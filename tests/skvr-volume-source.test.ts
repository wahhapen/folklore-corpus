import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSkvrI1VolumeAdapter,
  SKVR_I1_PILOT_IDS,
} from "../scripts/adapters/skvr-i1.mjs";
import { runPinnedSkvrIngest } from "../scripts/ingest-skvr.mjs";
import { ingestCollection } from
  "../scripts/lib/collection-ingestion.mjs";

const COMMIT = "2cfd7db101e79eb1446d0d2dbb108af1e8b2a18a";
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function fixtureVolume({ omit }: { omit?: string } = {}) {
  const records: string[] = [];
  for (let poemNumber = 1; poemNumber <= 100; poemNumber += 1) {
    const id = `skvr011${String(poemNumber).padStart(4, "0")}0`;
    if (poemNumber === 3) {
      records.push(`
  <ITEM nro="skvr01100021" y="1872">
    <META><OSA>I1</OSA><ID>2a.</ID><LOC>Alternate.</LOC></META>
    <TEXT><V>Alternate line</V></TEXT>
  </ITEM>`);
    }
    if (id === omit) continue;
    records.push(`
  <ITEM nro="${id}" y="${1834 + poemNumber}">
    <META>
      <OSA>I1</OSA><ID>${poemNumber}.</ID><LOC>Place ${poemNumber}.</LOC>
      <COL>Collector ${poemNumber}</COL><SGN>Signum ${poemNumber}</SGN>
      <INF>Performer ${poemNumber}</INF>
    </META>
    <TEXT>
      <V>${poemNumber === 1 ? "U&#776;ks'" : "Source"} line ${poemNumber} one</V>
      <V>2 Source line ${poemNumber} two</V>
    </TEXT>
  </ITEM>`);
  }
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<KOKONAISUUS>` +
    `${records.join("")}\n</KOKONAISUUS>\n`,
  );
}

function fixtureLock(
  volume: Buffer,
  reviewOverride: Record<string, unknown> = {},
) {
  const source = (
    uri: string,
    sourcePath: string,
    mediaType: string,
    bytes: Buffer,
  ) => ({
    uri,
    sourcePath,
    mediaType,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  });
  const readme = Buffer.from("SKVR data is CC BY 4.0");
  const review = Buffer.from(JSON.stringify({
    schemaVersion: "folklore-rights-review-v2",
    reviewId: "skvr-i1-fi-v2",
    reviewedOn: "2026-07-27",
    reviewState: "accepted",
    jurisdiction: "FI",
    assessment: "cc-by-4.0",
    evidenceUseAllowed: true,
    quotationAllowed: true,
    redistributionAllowed: true,
    accessPrivateUseAllowed: true,
    mlEvaluationAllowed: true,
    mlTrainingAllowed: true,
    ...reviewOverride,
  }));
  return {
    lock: {
      schemaVersion: 1,
      collection: "SKVR",
      upstream: {
        url: "https://github.com/sks190/SKVR",
        commit: COMMIT,
      },
      sources: {
        volume: source(
          "fixture://skvr/volume",
          "upstream/skvr_01_1.xml",
          "application/xml",
          volume,
        ),
        readme: source(
          "fixture://skvr/readme",
          "upstream/README.md",
          "text/markdown",
          readme,
        ),
        rightsReview: source(
          "fixture://skvr/review",
          "review/rights-review-fi.json",
          "application/json",
          review,
        ),
      },
    },
    sources: new Map([
      ["fixture://skvr/volume", volume],
      ["fixture://skvr/readme", readme],
      ["fixture://skvr/review", review],
    ]),
  };
}

async function writePinnedFixture(root: string, volume = fixtureVolume()) {
  const fixture = fixtureLock(volume);
  const lockPath = join(root, "i1-source.lock.json");
  for (const source of Object.values((fixture.lock as any).sources)) {
    const path = join(root, "sources", (source as any).sourcePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, fixture.sources.get((source as any).uri)!);
  }
  await writeFile(lockPath, JSON.stringify(fixture.lock));
  return {
    ...fixture,
    lockPath,
    sourceRoot: join(root, "sources"),
  };
}

describe("pinned SKVR volume source", () => {
  let database: PGlite | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    temporaryDirectory = undefined;
  });

  it("pins the official repository commit and source volume digest", async () => {
    const lock = JSON.parse(await readFile(
      new URL("../data/skvr/i1-source.lock.json", import.meta.url),
      "utf8",
    ));
    expect(lock).toMatchObject({
      schemaVersion: 1,
      collection: "SKVR",
      upstream: {
        repository: "SKVR",
        commit: COMMIT,
      },
      sources: {
        volume: {
          sourcePath: "upstream/skvr_01_1.xml",
          byteLength: 2631510,
          sha256:
            "be3091bf41154879cb26b223941cc9de25bad4b1da178d07d42b3f5ffb44da40",
        },
      },
    });
  });

  it("extracts exactly the 100 base poems from the pinned official volume", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "skvr-volume-"));
    database = new PGlite();
    const fixture = fixtureLock(fixtureVolume());
    const events = [];
    for await (const event of ingestCollection({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter: createSkvrI1VolumeAdapter(fixture.lock),
      captureTransport: async ({ uri }) => ({
        bytes: fixture.sources.get(uri),
        responseMetadata: { status: 200 },
      }),
      request: { pilot: "I1-base-1-100" },
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "run-completed" });

    const result = await database.query(`
      SELECT
        (SELECT count(*) FROM folklore.source_item
          WHERE native_id ~ '^skvr011[0-9]{5}$')::integer AS source_items,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages
    `);
    expect(result.rows).toEqual([{
      source_items: 100,
      representations: 200,
      passages: 100,
    }]);
    const identities = await database.query(`
      SELECT native_id, native_metadata->>'archiveRecordId'
        AS archive_record_id
      FROM folklore.source_item
      WHERE native_id IN ('skvr01100030', 'skvr01101000')
      ORDER BY native_id
    `);
    expect(identities.rows).toEqual([
      {
        native_id: "skvr01100030",
        archive_record_id: "skvr01100030",
      },
      {
        native_id: "skvr01101000",
        archive_record_id: "skvr01101000",
      },
    ]);
    const firstText = await database.query(`
      SELECT passage_representation.quoted_text
      FROM folklore.passage_representation passage_representation
      JOIN folklore.representation representation
        ON representation.resource_pk =
          passage_representation.representation_resource_pk
      JOIN folklore.resource resource
        ON resource.resource_pk = representation.resource_pk
      WHERE resource.canonical_id LIKE
        'fa:representation:skvr:skvr01100010:%:plain-text:%'
    `);
    expect(firstText.rows[0].quoted_text).toContain("U\u0308ks'");
    expect(firstText.rows[0].quoted_text).not.toContain("&#");
  });

  it("fails before item commit when a locked pilot ID is absent", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "skvr-volume-bad-"));
    database = new PGlite();
    const fixture = fixtureLock(fixtureVolume({
      omit: SKVR_I1_PILOT_IDS[49],
    }));
    const run = async () => {
      for await (const _ of ingestCollection({
        database,
        artifactRoot: join(temporaryDirectory, "artifacts"),
        adapter: createSkvrI1VolumeAdapter(fixture.lock),
        captureTransport: async ({ uri }) => ({
          bytes: fixture.sources.get(uri),
          responseMetadata: { status: 200 },
        }),
        request: { pilot: "I1-base-1-100" },
      })) {
        // Consume the ingestion stream.
      }
    };
    await expect(run()).rejects.toThrow("missing pilot IDs");
    const commits = await database.query(
      "SELECT count(*)::integer AS count FROM folklore.ingest_item_commit",
    );
    expect(commits.rows).toEqual([{ count: 0 }]);
  });

  it("rejects a pinned rights review that disagrees with Rights Contract v2", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "skvr-rights-bad-"));
    database = new PGlite();
    const fixture = fixtureLock(fixtureVolume(), {
      reviewState: "rejected",
    });
    const run = async () => {
      for await (const _ of ingestCollection({
        database,
        artifactRoot: join(temporaryDirectory, "artifacts"),
        adapter: createSkvrI1VolumeAdapter(fixture.lock),
        captureTransport: async ({ uri }) => ({
          bytes: fixture.sources.get(uri),
          responseMetadata: { status: 200 },
        }),
        request: { pilot: "I1-base-1-100" },
      })) {
        // Consume the ingestion stream.
      }
    };

    await expect(run()).rejects.toThrow(
      "SKVR Rights Contract v2 review is incomplete",
    );
    const commits = await database.query(
      "SELECT count(*)::integer AS count FROM folklore.ingest_item_commit",
    );
    expect(commits.rows).toEqual([{ count: 0 }]);
  });

  it("resumes the production pinned path from its committed checkpoint", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "skvr-pinned-resume-"));
    const fixture = await writePinnedFixture(temporaryDirectory);
    const output = join(temporaryDirectory, "catalogue");
    let committed = 0;
    await expect(runPinnedSkvrIngest({
      output,
      sourceRoot: fixture.sourceRoot,
      lockPath: fixture.lockPath,
      onEvent: (event: any) => {
        if (event.type === "item-committed" && ++committed === 50) {
          throw new Error("simulated process interruption");
        }
      },
    })).rejects.toThrow("simulated process interruption");

    const resumed = await runPinnedSkvrIngest({
      output,
      sourceRoot: fixture.sourceRoot,
      lockPath: fixture.lockPath,
    });
    expect(resumed).toHaveLength(51);
    expect(resumed[0]).toMatchObject({
      type: "item-committed",
      externalKey: "skvr01100510",
    });
  });

  it("versions changed locked bytes without duplicating logical poems", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "skvr-pinned-change-"));
    const fixture = await writePinnedFixture(temporaryDirectory);
    const output = join(temporaryDirectory, "catalogue");
    await runPinnedSkvrIngest({
      output,
      sourceRoot: fixture.sourceRoot,
      lockPath: fixture.lockPath,
    });

    const changedVolume = Buffer.from(
      fixtureVolume().toString("utf8")
        .replace("U&#776;ks' line 1 one", "Corrected line 1 one"),
    );
    const volumeSource = (fixture.lock as any).sources.volume;
    volumeSource.byteLength = changedVolume.byteLength;
    volumeSource.sha256 = sha256(changedVolume);
    await writeFile(
      join(fixture.sourceRoot, volumeSource.sourcePath),
      changedVolume,
    );
    await writeFile(fixture.lockPath, JSON.stringify(fixture.lock));
    await runPinnedSkvrIngest({
      output,
      sourceRoot: fixture.sourceRoot,
      lockPath: fixture.lockPath,
    });

    database = new PGlite(join(output, "pgdata"));
    const counts = await database.query(`
      SELECT
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages,
        (SELECT count(*) FROM folklore.ingest_run
          WHERE status = 'completed')::integer AS completed_runs
    `);
    expect(counts.rows).toEqual([{
      witnesses: 100,
      representations: 202,
      passages: 100,
      completed_runs: 2,
    }]);
  });
});
