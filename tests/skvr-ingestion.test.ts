import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  SKVR_I1_PILOT_IDS,
} from
  "../scripts/adapters/skvr-i1.mjs";
import { runSkvrIngest } from "../scripts/ingest-skvr.mjs";
import { IngestValidationError } from
  "../scripts/lib/collection-ingestion.mjs";

const RIGHTS_URI =
  "https://aineistot.finlit.fi/exist/apps/skvr/ohjeet.html";

function fixtureTei(electronicId: string) {
  const poemNumber = Number(electronicId.slice(7, 11));
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"
     xml:id="${electronicId}" xml:lang="krl">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>SKVR I1 ${poemNumber}.</title></titleStmt>
      <publicationStmt>
        <idno type="electronic">${electronicId}</idno>
        <idno type="URN">urn:nbn:fi:sks-${electronicId}</idno>
      </publicationStmt>
      <sourceDesc>
        <bibl>
          <biblScope unit="part">I1</biblScope>
          <biblScope unit="poem">${poemNumber}</biblScope>
          <idno type="signum">Fixture ${poemNumber}</idno>
        </bibl>
      </sourceDesc>
    </fileDesc>
    <profileDesc>
      <langUsage>
        <language ident="krl">Vienan karjala</language>
      </langUsage>
    </profileDesc>
  </teiHeader>
  <text>
    <body>
      <div type="poem">
        <head>Fixture poem ${poemNumber}</head>
        <lg>
          <l n="1">Prefix ${poemNumber} <choice><orig>Orig ${poemNumber}a</orig><reg>Norm ${poemNumber}a</reg></choice> suffix</l>
          <l n="2"><choice><orig>Orig ${poemNumber}b</orig><reg>Norm ${poemNumber}b</reg></choice></l>
        </lg>
      </div>
    </body>
  </text>
</TEI>`);
}

async function collect<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("SKVR I1 acquisition manifest", () => {
  it("pins exactly base poems 1 through 100 without gaps or alternates", () => {
    const expected = Array.from(
      { length: 100 },
      (_, index) => `skvr011${String(index + 1).padStart(4, "0")}0`,
    );

    expect(SKVR_I1_PILOT_IDS).toEqual(expected);
    expect(new Set(SKVR_I1_PILOT_IDS).size).toBe(100);
  });
});

describe("SKVR I1 acquisition and import", () => {
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

  it("imports the exact pilot as raw TEI plus derived normalized text", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "folklore-skvr-i1-"));
    const artifactRoot = join(temporaryDirectory, "artifacts");
    const rightsBytes = Buffer.from(
      "SKVR XML/TEI data: Creative Commons Attribution 4.0 International",
    );
    const transport = async ({ uri }: { uri: string }) => {
      if (uri === RIGHTS_URI) {
        return { bytes: rightsBytes, responseMetadata: { status: 200 } };
      }
      const match = uri.match(/\/(skvr011\d{5})\.xml$/);
      if (!match || !SKVR_I1_PILOT_IDS.includes(match[1])) {
        throw new Error(`Unexpected SKVR fixture URI: ${uri}`);
      }
      return {
        bytes: fixtureTei(match[1]),
        responseMetadata: {
          status: 200,
          headers: { "content-type": "application/tei+xml" },
        },
      };
    };

    const events = await runSkvrIngest({
      output: temporaryDirectory,
      captureTransport: transport,
    });
    database = new PGlite(join(temporaryDirectory, "pgdata"));

    expect(events).toHaveLength(101);
    expect(events.at(-1)?.type).toBe("run-completed");
    const counts = await database.query<{
      source_items: number;
      witnesses: number;
      representations: number;
      passages: number;
      captures: number;
      artifacts: number;
    }>(`
      SELECT
        (SELECT count(*) FROM folklore.source_item
          WHERE native_id ~ '^skvr011[0-9]{5}$')::integer AS source_items,
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages,
        (SELECT count(*) FROM folklore.capture)::integer AS captures,
        (SELECT count(*) FROM folklore.artifact)::integer AS artifacts
    `);
    expect(counts.rows[0]).toEqual({
      source_items: 100,
      witnesses: 100,
      representations: 200,
      passages: 100,
      captures: 101,
      artifacts: 201,
    });

    const item = await database.query<{
      native_id: string;
      landing_uri: string;
      native_metadata: {
        printedCitation: string;
        persistentUrn: string;
      };
    }>(`
      SELECT native_id, landing_uri, native_metadata
      FROM folklore.source_item
      WHERE native_id = 'skvr01100010'
    `);
    expect(item.rows).toEqual([{
      native_id: "skvr01100010",
      landing_uri:
        "https://aineistot.finlit.fi/exist/apps/skvr/main/skvr01100010.xml",
      native_metadata: expect.objectContaining({
        printedCitation: "SKVR I1 1",
        persistentUrn: "urn:nbn:fi:sks-skvr01100010",
      }),
    }]);

    const representations = await database.query<{
      representation_kind: string;
      language_tag: string;
      script_code: string;
      dialect: string;
      storage_key: string;
      derivation_type: string | null;
      method: string;
      method_version: string;
    }>(`
      SELECT
        representation.representation_kind,
        representation.language_tag,
        representation.script_code,
        representation.dialect,
        artifact.storage_key,
        derivation.derivation_type,
        derivation.method,
        derivation.method_version
      FROM folklore.source_item source_item
      JOIN folklore.edition edition
        ON edition.source_item_resource_pk = source_item.resource_pk
      JOIN folklore.document document
        ON document.edition_resource_pk = edition.resource_pk
      JOIN folklore.witness witness
        ON witness.document_resource_pk = document.resource_pk
      JOIN folklore.representation representation
        ON representation.witness_resource_pk = witness.resource_pk
      JOIN folklore.artifact artifact
        ON artifact.resource_pk = representation.artifact_resource_pk
      JOIN folklore.derivation_output output
        ON output.output_resource_pk = representation.resource_pk
      JOIN folklore.derivation derivation
        ON derivation.resource_pk = output.derivation_resource_pk
      WHERE source_item.native_id = 'skvr01100010'
      ORDER BY representation.representation_kind
    `);
    expect(representations.rows).toMatchObject([
      {
        representation_kind: "normalized-text",
        language_tag: "krl",
        script_code: "Latn",
        dialect: "Vienan karjala",
        derivation_type: "normalization",
        method: "skvr-tei-choice-normalization",
        method_version: "1",
      },
      {
        representation_kind: "tei-source",
        language_tag: "krl",
        script_code: "Latn",
        dialect: "Vienan karjala",
        derivation_type: null,
        method: "skvr-tei-capture",
        method_version: "1",
      },
    ]);
    expect(representations.rows[0].storage_key)
      .not.toBe(representations.rows[1].storage_key);
    expect(await readFile(
      join(artifactRoot, representations.rows[0].storage_key),
      "utf8",
    )).toBe("Prefix 1 Norm 1a suffix\nNorm 1b\n");

    const passage = await database.query<{
      source_anchor: string;
      citation_label: string;
      kinds: string[];
      selectors: Array<{
        type: string;
        startLine: number;
        endLine: number;
      }>;
    }>(`
      SELECT
        passage.source_anchor,
        passage.citation_label,
        array_agg(representation.representation_kind
          ORDER BY representation.representation_kind) AS kinds,
        json_agg(link.selector
          ORDER BY representation.representation_kind) AS selectors
      FROM folklore.source_item source_item
      JOIN folklore.edition edition
        ON edition.source_item_resource_pk = source_item.resource_pk
      JOIN folklore.document document
        ON document.edition_resource_pk = edition.resource_pk
      JOIN folklore.witness witness
        ON witness.document_resource_pk = document.resource_pk
      JOIN folklore.passage passage
        ON passage.witness_resource_pk = witness.resource_pk
      JOIN folklore.passage_representation link
        ON link.passage_resource_pk = passage.resource_pk
      JOIN folklore.representation representation
        ON representation.resource_pk = link.representation_resource_pk
      WHERE source_item.native_id = 'skvr01100010'
      GROUP BY passage.source_anchor, passage.citation_label
    `);
    expect(passage.rows).toEqual([{
      source_anchor: "skvr01100010:lines:1-2",
      citation_label: "SKVR I1 1, lines 1–2",
      kinds: ["normalized-text", "tei-source"],
      selectors: [
        { type: "LineSelector", startLine: 1, endLine: 2 },
        { type: "LineSelector", startLine: 1, endLine: 2 },
      ],
    }]);

    const rights = await database.query<{ uncovered: number }>(`
      SELECT count(*)::integer AS uncovered
      FROM (
        SELECT resource_pk FROM folklore.artifact
        UNION ALL
        SELECT resource_pk FROM folklore.representation
      ) subject
      WHERE NOT EXISTS (
        SELECT 1 FROM folklore.rights_assessment rights
        WHERE rights.subject_resource_pk = subject.resource_pk
          AND rights.review_state = 'accepted'
          AND rights.statement_uri =
            'https://creativecommons.org/licenses/by/4.0/'
          AND rights.redistribution_allowed IS TRUE
          AND rights.ml_use_allowed IS TRUE
      )
    `);
    expect(rights.rows).toEqual([{ uncovered: 0 }]);

    const provenance = await database.query<{
      input_roles: string[];
      output_roles: string[];
    }>(`
      SELECT
        array_agg(DISTINCT input.role ORDER BY input.role) AS input_roles,
        array_agg(DISTINCT output.role ORDER BY output.role) AS output_roles
      FROM folklore.source_item source_item
      JOIN folklore.edition edition
        ON edition.source_item_resource_pk = source_item.resource_pk
      JOIN folklore.document document
        ON document.edition_resource_pk = edition.resource_pk
      JOIN folklore.witness witness
        ON witness.document_resource_pk = document.resource_pk
      JOIN folklore.representation representation
        ON representation.witness_resource_pk = witness.resource_pk
       AND representation.representation_kind = 'normalized-text'
      JOIN folklore.derivation_output selected_output
        ON selected_output.output_resource_pk = representation.resource_pk
      JOIN folklore.derivation_input input
        ON input.derivation_resource_pk =
          selected_output.derivation_resource_pk
      JOIN folklore.derivation_output output
        ON output.derivation_resource_pk =
          selected_output.derivation_resource_pk
      WHERE source_item.native_id = 'skvr01100010'
    `);
    expect(provenance.rows).toEqual([{
      input_roles: ["capture", "source-item"],
      output_roles: ["artifact", "representation"],
    }]);
  });

  for (const invalid of [
    {
      name: "malformed TEI",
      bytes: Buffer.from("<TEI><text>"),
      message: "malformed TEI/XML",
    },
    {
      name: "missing electronic ID",
      bytes: fixtureTei("skvr01100020"),
      message: "does not identify it",
    },
    {
      name: "broken line selectors",
      bytes: Buffer.from(
        fixtureTei("skvr01100010")
          .toString("utf8")
          .replace('<l n="2">', '<l n="1">'),
      ),
      message: "not strictly increasing",
    },
  ]) {
    it(`fails before item commit for ${invalid.name}`, async () => {
      temporaryDirectory = await mkdtemp(
        join(tmpdir(), "folklore-skvr-invalid-"),
      );
      const transport = async ({ uri }: { uri: string }) => {
        if (uri === RIGHTS_URI) {
          return {
            bytes: Buffer.from("CC BY 4.0 rights evidence"),
            responseMetadata: { status: 200 },
          };
        }
        if (uri.endsWith("/skvr01100010.xml")) {
          return {
            bytes: invalid.bytes,
            responseMetadata: { status: 200 },
          };
        }
        throw new Error(`Unexpected fixture URI: ${uri}`);
      };

      await expect(runSkvrIngest({
        output: temporaryDirectory,
        captureTransport: transport,
      })).rejects.toMatchObject({
        name: IngestValidationError.name,
        message: expect.stringContaining(invalid.message),
      });

      database = new PGlite(join(temporaryDirectory, "pgdata"));
      const state = await database.query<{
        commits: number;
        status: string;
      }>(`
        SELECT
          (SELECT count(*) FROM folklore.ingest_item_commit)::integer
            AS commits,
          status
        FROM folklore.ingest_run
      `);
      expect(state.rows).toEqual([{ commits: 0, status: "failed" }]);
    });
  }

  it("resumes at the first uncommitted manifest ID after interruption", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "folklore-skvr-resume-"));
    let interrupted = false;
    const transport = async ({ uri }: { uri: string }) => {
      if (uri === RIGHTS_URI) {
        return {
          bytes: Buffer.from("CC BY 4.0 rights evidence"),
          responseMetadata: { status: 200 },
        };
      }
      const match = uri.match(/\/(skvr011\d{5})\.xml$/);
      if (!match) throw new Error(`Unexpected fixture URI: ${uri}`);
      if (match[1] === "skvr01100510" && !interrupted) {
        interrupted = true;
        throw new Error("fixture archive interrupted");
      }
      return {
        bytes: fixtureTei(match[1]),
        responseMetadata: { status: 200 },
      };
    };

    await expect(runSkvrIngest({
      output: temporaryDirectory,
      captureTransport: transport,
    })).rejects.toThrow("fixture archive interrupted");

    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const paused = await database.query<{
      status: string;
      checkpoint: {
        nextIndex: number;
        electronicId: string;
      };
      commits: number;
    }>(`
      SELECT
        status,
        checkpoint,
        (SELECT count(*) FROM folklore.ingest_item_commit)::integer
          AS commits
      FROM folklore.ingest_run
    `);
    expect(paused.rows).toEqual([{
      status: "paused",
      checkpoint: {
        nextIndex: 50,
        electronicId: "skvr01100500",
      },
      commits: 50,
    }]);
    await database.close();
    database = undefined;

    const resumed = await runSkvrIngest({
      output: temporaryDirectory,
      captureTransport: transport,
    });
    expect(resumed).toHaveLength(51);
    expect(resumed[0]).toMatchObject({
      type: "item-committed",
      externalKey: "skvr01100510",
    });

    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const completed = await database.query<{
      status: string;
      commits: number;
      captures: number;
      witnesses: number;
    }>(`
      SELECT
        status,
        (SELECT count(*) FROM folklore.ingest_item_commit)::integer
          AS commits,
        (SELECT count(*) FROM folklore.capture)::integer AS captures,
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses
      FROM folklore.ingest_run
    `);
    expect(completed.rows).toEqual([{
      status: "completed",
      commits: 100,
      captures: 101,
      witnesses: 100,
    }]);
  });

  it("replays without duplicate logical resources and versions changed TEI", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "folklore-skvr-replay-"));
    let changed = false;
    const transport = async ({ uri }: { uri: string }) => {
      if (uri === RIGHTS_URI) {
        return {
          bytes: Buffer.from("CC BY 4.0 rights evidence"),
          responseMetadata: { status: 200 },
        };
      }
      const match = uri.match(/\/(skvr011\d{5})\.xml$/);
      if (!match) throw new Error(`Unexpected fixture URI: ${uri}`);
      const original = fixtureTei(match[1]);
      return {
        bytes: changed && match[1] === "skvr01100010"
          ? Buffer.concat([original, Buffer.from("\n<!-- corrected -->")])
          : original,
        responseMetadata: { status: 200 },
      };
    };

    await runSkvrIngest({
      output: temporaryDirectory,
      captureTransport: transport,
    });
    await runSkvrIngest({
      output: temporaryDirectory,
      captureTransport: transport,
    });

    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const replay = await database.query<{
      runs: number;
      captures: number;
      artifacts: number;
      witnesses: number;
      representations: number;
      passages: number;
    }>(`
      SELECT
        (SELECT count(*) FROM folklore.ingest_run)::integer AS runs,
        (SELECT count(*) FROM folklore.capture)::integer AS captures,
        (SELECT count(*) FROM folklore.artifact)::integer AS artifacts,
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages
    `);
    expect(replay.rows).toEqual([{
      runs: 2,
      captures: 202,
      artifacts: 201,
      witnesses: 100,
      representations: 200,
      passages: 100,
    }]);
    await database.close();
    database = undefined;

    changed = true;
    await runSkvrIngest({
      output: temporaryDirectory,
      captureTransport: transport,
    });

    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const versioned = await database.query<{
      runs: number;
      captures: number;
      artifacts: number;
      witnesses: number;
      representations: number;
      passages: number;
    }>(`
      SELECT
        (SELECT count(*) FROM folklore.ingest_run)::integer AS runs,
        (SELECT count(*) FROM folklore.capture)::integer AS captures,
        (SELECT count(*) FROM folklore.artifact)::integer AS artifacts,
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages
    `);
    expect(versioned.rows).toEqual([{
      runs: 3,
      captures: 303,
      artifacts: 202,
      witnesses: 100,
      representations: 201,
      passages: 100,
    }]);
  });
});
