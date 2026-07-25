import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { createLibriVoxFixtureAdapter } from
  "../scripts/adapters/librivox-fixture.mjs";
import { createSkvrFixtureAdapter } from
  "../scripts/adapters/skvr-fixture.mjs";
import {
  IngestValidationError,
  getIngestRun,
  ingestCollection,
} from "../scripts/lib/collection-ingestion.mjs";

const SKVR_TEI = Buffer.from(`<?xml version="1.0"?>
<TEI xml:lang="fi"><text><body>
  <div type="poem" xml:id="skvr-I1-1">
    <head>Laulajan synty</head>
    <lg><l n="1">Laulaja laululle lähti</l><l n="2">sanaseppo saatteleikse</l></lg>
  </div>
</body></text></TEI>`);
const LIBRIVOX_AUDIO_64 = Buffer.from("fixture-mp3-audio-64kbps");
const LIBRIVOX_AUDIO_128 = Buffer.from("fixture-mp3-audio-128kbps");
const LIBRIVOX_CATALOGUE = Buffer.from(JSON.stringify({
  sections: [{
    id: "section-01",
    title: "The Horned Women",
    language: "en",
    audio64Uri: "fixture://librivox/section-01-64kbps.mp3",
    audio128Uri: "fixture://librivox/section-01-128kbps.mp3",
    durationSeconds: 12.5,
  }],
}));
const SKVR_RIGHTS = Buffer.from(
  "SKVR fixture: Creative Commons Attribution 4.0 International",
);
const LIBRIVOX_RIGHTS = Buffer.from(
  "LibriVox fixture: recordings are dedicated to the public domain",
);

const fixtureBytes = new Map<string, Buffer>([
  ["fixture://skvr/tei", SKVR_TEI],
  ["fixture://skvr/rights", SKVR_RIGHTS],
  ["fixture://librivox/catalogue", LIBRIVOX_CATALOGUE],
  ["fixture://librivox/section-01-64kbps.mp3", LIBRIVOX_AUDIO_64],
  ["fixture://librivox/section-01-128kbps.mp3", LIBRIVOX_AUDIO_128],
  ["fixture://librivox/rights", LIBRIVOX_RIGHTS],
]);

async function collect<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function fixtureTransport(request: { uri: string }) {
  const bytes = fixtureBytes.get(request.uri);
  if (!bytes) throw new Error(`Unexpected fixture URI: ${request.uri}`);
  if (request.uri.includes("librivox/section-01-")) {
    return {
      body: (async function* () {
        yield bytes.subarray(0, 7);
        yield bytes.subarray(7);
      })(),
      responseMetadata: {
        status: 200,
        headers: {
          authorization: "must-not-be-stored",
          etag: '"fixture"',
        },
      },
    };
  }
  return {
    bytes,
    responseMetadata: {
      status: 200,
      headers: {
        authorization: "must-not-be-stored",
        etag: '"fixture"',
      },
    },
  };
}

describe("CollectionAdapter shared contract", () => {
  let database: PGlite | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    await database?.close();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    database = undefined;
    temporaryDirectory = undefined;
  });

  for (const example of [
    {
      name: "SKVR TEI",
      adapter: createSkvrFixtureAdapter,
      expected: {
        languageTag: "fi",
        scriptCode: "Latn",
        selectorType: "LineSelector",
        representations: 1,
        passages: 1,
      },
    },
    {
      name: "LibriVox catalogue/audio",
      adapter: createLibriVoxFixtureAdapter,
      expected: {
        languageTag: "en",
        scriptCode: null,
        selectorType: "AudioTimeSelector",
        representations: 2,
        passages: 2,
      },
    },
  ]) {
    it(`${example.name} commits through the same engine contract`, async () => {
      temporaryDirectory = await mkdtemp(
        join(tmpdir(), "folklore-adapter-contract-"),
      );
      database = new PGlite(join(temporaryDirectory, "pgdata"));

      const events = await collect(ingestCollection({
        database,
        artifactRoot: join(temporaryDirectory, "artifacts"),
        adapter: example.adapter(),
        captureTransport: fixtureTransport,
        request: { fixture: example.name },
      }));

      expect(events.map(({ type }) => type)).toEqual([
        "item-committed",
        "run-completed",
      ]);
      const committed = events[0];
      expect(committed).toMatchObject({
        externalKey: expect.any(String),
        counts: {
          sourceItems: 1,
          witnesses: 1,
          representations: example.expected.representations,
          passages: example.expected.passages,
          derivations: example.expected.representations,
        },
      });

      const run = await getIngestRun(database, events.at(-1)!.runId);
      expect(run).toMatchObject({
        status: "completed",
        checkpoint: { index: 1 },
      });

      const representation = await database.query<{
        language_tag: string;
        script_code: string;
      }>(`
        SELECT language_tag, script_code
        FROM folklore.representation
      `);
      expect(representation.rows).toContainEqual({
        language_tag: example.expected.languageTag,
        script_code: example.expected.scriptCode,
      });

      const selector = await database.query<{ selector: { type: string } }>(`
        SELECT selector
        FROM folklore.passage_representation
      `);
      expect(selector.rows.map(({ selector }) => selector.type))
        .toContain(example.expected.selectorType);

      const rights = await database.query<{ count: number }>(`
        SELECT count(*)::integer AS count
        FROM folklore.rights_assessment
        WHERE review_state = 'accepted'
      `);
      expect(Number(rights.rows[0].count)).toBeGreaterThanOrEqual(2);

      const sourceTrace = await database.query<{
        witness_count: number;
        derivation_count: number;
      }>(`
        SELECT
          count(DISTINCT witness.resource_pk)::integer AS witness_count,
          count(DISTINCT derivation_input.derivation_resource_pk)::integer
            AS derivation_count
        FROM folklore.source_item source_item
        JOIN folklore.edition edition
          ON edition.source_item_resource_pk = source_item.resource_pk
        JOIN folklore.document document
          ON document.edition_resource_pk = edition.resource_pk
        JOIN folklore.witness witness
          ON witness.document_resource_pk = document.resource_pk
        JOIN folklore.derivation_input derivation_input
          ON derivation_input.input_resource_pk = source_item.resource_pk
         AND derivation_input.role = 'source-item'
        WHERE source_item.native_id NOT LIKE 'fixture-%'
      `);
      expect(sourceTrace.rows[0]).toEqual({
        witness_count: 1,
        derivation_count: example.expected.representations,
      });

      const captures = await database.query<{
        response_metadata: {
          headers?: Record<string, string>;
        };
      }>("SELECT response_metadata FROM folklore.capture");
      expect(captures.rows.every(({ response_metadata }) =>
        response_metadata.headers?.authorization === undefined
      )).toBe(true);
    });
  }

  for (const invalid of [
    {
      name: "stable item key",
      mutate: (item: any) => {
        item.externalKey = "NOT STABLE";
      },
    },
    {
      name: "selector",
      mutate: (item: any) => {
        item.witnesses[0].representations[0].passages[0].selector =
          undefined;
      },
    },
    {
      name: "captured provenance",
      mutate: (item: any) => {
        const captureKey =
          item.witnesses[0].representations[0].captureKey;
        item.captures = item.captures
          .filter(({ key }: { key: string }) => key !== captureKey);
      },
    },
    {
      name: "Derivation",
      mutate: (item: any) => {
        item.witnesses[0].representations[0].derivation = undefined;
      },
    },
    {
      name: "rights evidence",
      mutate: (item: any) => {
        item.rights = undefined;
      },
    },
    {
      name: "recognized rights review state",
      mutate: (item: any) => {
        item.rights.reviewState = "pending";
      },
    },
    {
      name: "JSON checkpoint",
      mutate: (item: any) => {
        item.checkpointAfter = { index: 1n };
      },
    },
    {
      name: "BCP 47 language tag",
      mutate: (item: any) => {
        item.witnesses[0].representations[0].languageTag = "not a tag!";
      },
    },
  ]) {
    it(`rejects missing or invalid ${invalid.name} before item commit`, async () => {
      temporaryDirectory = await mkdtemp(
        join(tmpdir(), "folklore-adapter-invalid-"),
      );
      database = new PGlite(join(temporaryDirectory, "pgdata"));
      const adapter = createSkvrFixtureAdapter();
      const originalRead = adapter.read.bind(adapter);
      adapter.read = async function* (context) {
        for await (const item of originalRead(context)) {
          invalid.mutate(item);
          yield item;
        }
      };

      await expect(collect(ingestCollection({
        database,
        artifactRoot: join(temporaryDirectory, "artifacts"),
        adapter,
        captureTransport: fixtureTransport,
        request: { invalid: invalid.name },
      }))).rejects.toBeInstanceOf(IngestValidationError);

      const commits = await database.query<{ count: number }>(`
        SELECT count(*)::integer AS count
        FROM folklore.ingest_item_commit
      `);
      expect(Number(commits.rows[0].count)).toBe(0);
    });
  }

  it("catalogues rejected rights evidence without making it publishable", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-adapter-rejected-rights-"),
    );
    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const adapter = createSkvrFixtureAdapter();
    const originalRead = adapter.read.bind(adapter);
    adapter.read = async function* (context) {
      for await (const item of originalRead(context)) {
        item.rights.reviewState = "rejected";
        yield item;
      }
    };

    const events = await collect(ingestCollection({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter,
      captureTransport: fixtureTransport,
      request: { fixture: "rejected-rights" },
    }));
    expect(events.at(-1)?.type).toBe("run-completed");

    const states = await database.query<{
      review_state: string;
      count: number;
    }>(`
      SELECT review_state, count(*)::integer AS count
      FROM folklore.rights_assessment
      GROUP BY review_state
    `);
    expect(states.rows).toEqual([{
      review_state: "rejected",
      count: 3,
    }]);
  });

  it("resumes after the last committed checkpoint without duplicating items", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-adapter-resume-"),
    );
    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const adapter = createSkvrFixtureAdapter();
    const fixtureRead = adapter.read.bind(adapter);
    adapter.read = async function* (context) {
      let template;
      for await (const item of fixtureRead({ ...context, checkpoint: null })) {
        template = item;
      }
      const start = context.checkpoint?.index ?? 0;
      if (start < 1) {
        yield template;
        throw new Error("fixture archive paused");
      }
      if (start < 2) {
        yield {
          ...template,
          externalKey: "skvr-i1-2",
          checkpointAfter: { index: 2 },
          sourceItem: {
            ...template.sourceItem,
            externalKey: "skvr-i1-2",
            nativeId: "skvr-I1-2",
          },
        };
      }
    };

    const firstAttempt = ingestCollection({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter,
      captureTransport: fixtureTransport,
      request: { fixture: "resume" },
    })[Symbol.asyncIterator]();
    const firstEvent = await firstAttempt.next();
    expect(firstEvent.value.type).toBe("item-committed");
    await expect(firstAttempt.next()).rejects.toThrow("fixture archive paused");
    expect(await getIngestRun(database, firstEvent.value.runId))
      .toMatchObject({ status: "paused", checkpoint: { index: 1 } });

    const resumed = await collect(ingestCollection({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter,
      captureTransport: fixtureTransport,
      request: { fixture: "resume" },
    }));
    expect(resumed).toMatchObject([
      {
        type: "item-committed",
        runId: firstEvent.value.runId,
        externalKey: "skvr-i1-2",
      },
      { type: "run-completed", runId: firstEvent.value.runId },
    ]);

    const counts = await database.query<{
      commits: number;
      witnesses: number;
    }>(`
      SELECT
        (SELECT count(*) FROM folklore.ingest_item_commit)::integer AS commits,
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses
    `);
    expect(counts.rows[0]).toEqual({ commits: 2, witnesses: 2 });
  });

  it("keeps logical identity stable while changed bytes create new evidence", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-adapter-change-"),
    );
    database = new PGlite(join(temporaryDirectory, "pgdata"));
    let teiBytes = SKVR_TEI;
    const changingTransport = async (request: { uri: string }) => {
      if (request.uri === "fixture://skvr/tei") {
        return { bytes: teiBytes, responseMetadata: { status: 200 } };
      }
      return fixtureTransport(request);
    };
    const options = {
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter: createSkvrFixtureAdapter(),
      captureTransport: changingTransport,
      request: { fixture: "changed-bytes" },
    };

    await collect(ingestCollection(options));
    teiBytes = Buffer.concat([SKVR_TEI, Buffer.from("\n<!-- corrected -->")]);
    await collect(ingestCollection({
      ...options,
      adapter: createSkvrFixtureAdapter(),
    }));

    const counts = await database.query<{
      captures: number;
      witnesses: number;
      representations: number;
      passages: number;
    }>(`
      SELECT
        (SELECT count(*) FROM folklore.capture)::integer AS captures,
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages
    `);
    expect(counts.rows[0]).toEqual({
      captures: 4,
      witnesses: 1,
      representations: 2,
      passages: 1,
    });
  });

  it("rejects a changed Passage boundary under an existing external key", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-adapter-boundary-"),
    );
    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const options = {
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      captureTransport: fixtureTransport,
      request: { fixture: "boundary-change" },
    };
    await collect(ingestCollection({
      ...options,
      adapter: createSkvrFixtureAdapter(),
    }));

    const changed = createSkvrFixtureAdapter();
    const originalRead = changed.read.bind(changed);
    changed.read = async function* (context) {
      for await (const item of originalRead(context)) {
        item.witnesses[0].representations[0].passages[0].sourceAnchor =
          "skvr-I1-1:lines:1-3";
        yield item;
      }
    };
    await expect(collect(ingestCollection({
      ...options,
      adapter: changed,
    }))).rejects.toBeInstanceOf(IngestValidationError);

    const passages = await database.query<{ source_anchor: string }>(
      "SELECT source_anchor FROM folklore.passage",
    );
    expect(passages.rows).toEqual([{
      source_anchor: "skvr-I1-1:lines:1-2",
    }]);
  });
});
