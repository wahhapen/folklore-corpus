import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { createLibriVoxAdapter } from "../scripts/adapters/librivox.mjs";
import { acquireLockedSource } from "../scripts/acquire-librivox.mjs";
import { ingestLibriVox } from "../scripts/ingest-librivox.mjs";
import { ingestCollection } from "../scripts/lib/collection-ingestion.mjs";
import {
  createPinnedSourceTransport,
  PinnedSourceError,
} from "../scripts/lib/pinned-source-transport.mjs";

const EXPECTED_SECTION_IDS = Array.from(
  { length: 27 },
  (_, index) => String(153266 + index),
);

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collect(iterable: AsyncIterable<unknown>) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function createFixtureSource(root: string) {
  const sourceFiles: Record<string, Buffer> = {
    catalogue: Buffer.from(JSON.stringify({
      books: [{
        id: "1837",
        title: "Celtic Fairy Tales",
        language: "English",
        num_sections: "27",
        url_text_source: "https://www.gutenberg.org/ebooks/7885",
        url_librivox:
          "https://librivox.org/celtic-fairy-tales-by-joseph-jacobs/",
        sections: EXPECTED_SECTION_IDS.map((id, index) => ({
          id,
          section_number: String(index),
          title: index === 0 ? "00 - Preface" : `${index} - Section ${index}`,
          listen_url: `https://archive.org/download/item/section-${index}.mp3`,
          language: "English",
          playtime: String(100 + index),
          readers: [{ reader_id: String(index + 1), display_name: `Reader ${index}` }],
        })),
      }],
    })),
    internetArchiveMetadata: Buffer.from(
      "<metadata>" +
      "<identifier>celtic_fairy_tales_0903_librivox</identifier>" +
      "<licenseurl>https://creativecommons.org/publicdomain/mark/1.0/</licenseurl>" +
      "</metadata>",
    ),
    gutenbergRights: Buffer.from(
      JSON.stringify({ reviewId: "project-gutenberg-seed-us-v2" }),
    ),
  };
  sourceFiles.jurisdictionReview = Buffer.from(JSON.stringify({
    reviewId: "librivox-1837-us-v2",
    reviewedOn: "2026-07-27",
    reviewState: "accepted",
    jurisdiction: "US",
    scope: {
      bookId: "1837",
      sectionIds: {
        first: EXPECTED_SECTION_IDS[0],
        last: EXPECTED_SECTION_IDS.at(-1),
        count: EXPECTED_SECTION_IDS.length,
      },
      sourceTextId: "gutenberg-7885",
      internetArchiveId: "celtic_fairy_tales_0903_librivox",
    },
    recording: "public-domain",
    sourceText: "public-domain",
    redistributionAllowed: true,
    commercialUseAllowed: true,
    derivativesAllowed: true,
    evidenceUseAllowed: true,
    quotationAllowed: true,
    accessPrivateUseAllowed: true,
    mlEvaluationAllowed: true,
    mlTrainingAllowed: true,
    mlUseAllowed: true,
    evidence: [
      {
        role: "recording-item",
        capturedSha256: sha256(sourceFiles.internetArchiveMetadata),
      },
      {
        role: "source-text-jurisdiction",
        capturedSha256: sha256(sourceFiles.gutenbergRights),
      },
    ],
  }));
  const paths = {
    catalogue: "catalogue.json",
    internetArchiveMetadata: "internet-archive-metadata.xml",
    gutenbergRights: "gutenberg-rights-review-us.json",
    jurisdictionReview: "rights-review-us.json",
  };
  await mkdir(join(root, "audio"), { recursive: true });
  for (const [key, bytes] of Object.entries(sourceFiles)) {
    await writeFile(join(root, paths[key as keyof typeof paths]), bytes);
  }

  const sections = [];
  for (const [index, id] of EXPECTED_SECTION_IDS.entries()) {
    const bytes = Buffer.from(`audio-${id}`);
    const path = `audio/${id}.mp3`;
    await writeFile(join(root, path), bytes);
    sections.push({
      id,
      sectionNumber: index,
      title: index === 0 ? "00 - Preface" : `${index} - Section ${index}`,
      reader: { id: String(index + 1), name: `Reader ${index}` },
      durationSeconds: 100 + index,
      media: {
        uri: `https://archive.org/download/item/section-${index}.mp3`,
        path,
        mediaType: "audio/mpeg",
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      },
    });
  }

  return {
    version: 1,
    collection: {
      bookId: "1837",
      title: "Celtic Fairy Tales",
      languageTag: "en",
      scriptCode: "Latn",
      sourceTextUri: "https://www.gutenberg.org/ebooks/7885",
      sourceTextId: "gutenberg-7885",
      internetArchiveId: "celtic_fairy_tales_0903_librivox",
    },
    sources: Object.fromEntries(
      Object.entries(sourceFiles).map(([key, bytes]) => [
        key,
        {
          uri: `https://example.test/${paths[key as keyof typeof paths]}`,
          path: paths[key as keyof typeof paths],
          mediaType: key === "internetArchiveMetadata"
            ? "application/xml"
            : key.endsWith("Rights")
            ? "text/html"
            : "application/json",
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        },
      ]),
    ),
    sections,
    rights: {
      statementUri: "https://creativecommons.org/publicdomain/mark/1.0/",
      controlledStatus: "public-domain",
      rightsSource: "LibriVox and Project Gutenberg evidence bundle",
      attributionText: "LibriVox recording of Celtic Fairy Tales",
      commercialUseAllowed: true,
      derivativesAllowed: true,
      evidenceUseAllowed: true,
      quotationAllowed: true,
      redistributionAllowed: true,
      accessPrivateUseAllowed: true,
      mlEvaluationAllowed: true,
      mlTrainingAllowed: true,
      mlUseAllowed: true,
      jurisdiction: "US",
      reviewedOn: "2026-07-27",
      reviewState: "accepted",
    },
  };
}

describe("LibriVox production adapter", () => {
  let temporaryDirectory: string | undefined;
  let database: PGlite | undefined;

  afterEach(async () => {
    if (database) await database.close();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    database = undefined;
    temporaryDirectory = undefined;
  });

  it("locks the real pilot to book 1837 and exactly sections 153266–153292", async () => {
    const lock = JSON.parse(await readFile(
      new URL("../data/librivox/book-1837.lock.json", import.meta.url),
      "utf8",
    ));
    expect(lock.collection).toMatchObject({
      bookId: "1837",
      sourceTextId: "gutenberg-7885",
      internetArchiveId: "celtic_fairy_tales_0903_librivox",
    });
    expect(lock.sections.map(({ id }: { id: string }) => id))
      .toEqual(EXPECTED_SECTION_IDS);
    expect(lock.sections).toHaveLength(27);
    expect(lock.sections.reduce(
      (sum: number, section: { durationSeconds: number }) =>
        sum + section.durationSeconds,
      0,
    )).toBe(23262);
  });

  it("imports 27 independently citable audio witnesses through the shared seam", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "folklore-librivox-"));
    const sourceRoot = join(temporaryDirectory, "sources");
    const lock = await createFixtureSource(sourceRoot);
    database = new PGlite(join(temporaryDirectory, "pgdata"));

    const events = await collect(ingestCollection({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter: createLibriVoxAdapter(lock),
      captureTransport: createPinnedSourceTransport({ sourceRoot }),
      request: { lockDigest: sha256(Buffer.from(JSON.stringify(lock))) },
    }));
    expect(events.filter(
      (event: any) => event.type === "item-committed",
    )).toHaveLength(27);
    expect(events.at(-1)).toMatchObject({ type: "run-completed" });

    const result = await database.query<{
      witnesses: number;
      representations: number;
      passages: number;
      first_id: string;
      last_id: string;
      total_duration: number;
    }>(`
      SELECT
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages,
        (SELECT min(native_id) FROM folklore.source_item
          WHERE native_id ~ '^[0-9]+$') AS first_id,
        (SELECT max(native_id) FROM folklore.source_item
          WHERE native_id ~ '^[0-9]+$') AS last_id,
        (SELECT sum((metadata->>'durationSeconds')::integer)
          FROM folklore.witness)::integer AS total_duration
    `);
    expect(result.rows[0]).toEqual({
      witnesses: 27,
      representations: 27,
      passages: 27,
      first_id: "153266",
      last_id: "153292",
      total_duration: 3051,
    });

    const trace = await database.query<{
      source_anchor: string;
      selector: { type: string; startSeconds: number; endSeconds: number };
      reader: string;
      media_digest: string;
    }>(`
      SELECT
        passage.source_anchor,
        passage_representation.selector,
        witness.metadata->>'reader' AS reader,
        representation.metadata->>'mediaSha256' AS media_digest
      FROM folklore.passage passage
      JOIN folklore.witness witness
        ON witness.resource_pk = passage.witness_resource_pk
      JOIN folklore.passage_representation passage_representation
        ON passage_representation.passage_resource_pk = passage.resource_pk
      JOIN folklore.representation representation
        ON representation.resource_pk =
          passage_representation.representation_resource_pk
      ORDER BY passage.source_anchor
      LIMIT 1
    `);
    expect(trace.rows[0]).toMatchObject({
      source_anchor: "librivox:1837:section:153266:t=0,100",
      selector: {
        type: "AudioTimeSelector",
        startSeconds: 0,
        endSeconds: 100,
      },
      reader: "Reader 0",
    });
    expect(trace.rows[0].media_digest).toMatch(/^[0-9a-f]{64}$/);

    const rightsEvidence = await database.query<{
      digest: string;
    }>(`
      SELECT DISTINCT encode(artifact.digest, 'hex') AS digest
      FROM folklore.rights_assessment assessment
      JOIN folklore.artifact artifact
        ON artifact.resource_pk = assessment.evidence_artifact_resource_pk
      ORDER BY digest
    `);
    expect(rightsEvidence.rows.map(({ digest }) => digest).sort()).toEqual([
      lock.sources.internetArchiveMetadata.sha256,
      lock.sources.jurisdictionReview.sha256,
    ].sort());
  });

  it("rejects corrupt media before it reaches the catalogue", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-librivox-corrupt-"),
    );
    const sourceRoot = join(temporaryDirectory, "sources");
    const lock = await createFixtureSource(sourceRoot);
    await writeFile(
      join(sourceRoot, lock.sections[0].media.path),
      Buffer.from("corrupt"),
    );
    database = new PGlite(join(temporaryDirectory, "pgdata"));

    await expect(collect(ingestCollection({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter: createLibriVoxAdapter(lock),
      captureTransport: createPinnedSourceTransport({ sourceRoot }),
      request: { fixture: "corrupt" },
    }))).rejects.toBeInstanceOf(PinnedSourceError);

    const witnesses = await database.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM folklore.witness",
    );
    expect(witnesses.rows[0].count).toBe(0);
  });

  it("resumes an interrupted source transfer before admitting the bytes", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-librivox-download-"),
    );
    const bytes = Buffer.from("complete-audio");
    const source = {
      uri: "https://example.test/audio.mp3",
      path: "audio/section.mp3",
      mediaType: "audio/mpeg",
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    };
    const partialPath = join(
      temporaryDirectory,
      `${source.path}.part`,
    );
    await mkdir(join(temporaryDirectory, "audio"), { recursive: true });
    await writeFile(partialPath, bytes.subarray(0, 5));

    const result = await acquireLockedSource({
      source,
      sourceRoot: temporaryDirectory,
      fetchImpl: async (_uri: string, options: { headers: { range: string } }) => {
        expect(options.headers.range).toBe("bytes=5-");
        return new Response(bytes.subarray(5), {
          status: 206,
          headers: { "content-range": `bytes 5-${bytes.length - 1}/${bytes.length}` },
        });
      },
    });
    expect(result.status).toBe("resumed-download");
    expect(await readFile(join(temporaryDirectory, source.path)))
      .toEqual(bytes);
  });

  it("resumes after missing media and keeps logical resources idempotent", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-librivox-resume-"),
    );
    const sourceRoot = join(temporaryDirectory, "sources");
    const lock = await createFixtureSource(sourceRoot);
    const missingPath = join(sourceRoot, lock.sections[1].media.path);
    const missingBytes = await readFile(missingPath);
    await rm(missingPath);
    const lockPath = join(temporaryDirectory, "book-1837.lock.json");
    await writeFile(lockPath, JSON.stringify(lock));
    database = new PGlite(join(temporaryDirectory, "pgdata"));
    const options = {
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      sourceRoot,
      lockPath,
    };

    await expect(collect(await ingestLibriVox(options)))
      .rejects.toBeInstanceOf(PinnedSourceError);
    await writeFile(missingPath, missingBytes);

    const changedBytes = Buffer.concat([
      await readFile(join(sourceRoot, lock.sections[0].media.path)),
      Buffer.from("-corrected"),
    ]);
    await writeFile(
      join(sourceRoot, lock.sections[0].media.path),
      changedBytes,
    );
    lock.sections[0].media.byteLength = changedBytes.byteLength;
    lock.sections[0].media.sha256 = sha256(changedBytes);
    await writeFile(lockPath, JSON.stringify(lock));

    const resumed = await collect(await ingestLibriVox(options));
    expect(resumed.filter(
      (event: any) => event.type === "item-committed",
    )).toHaveLength(27);
    expect(resumed.at(-1)).toMatchObject({ type: "run-completed" });

    await collect(await ingestLibriVox(options));
    const counts = await database.query<{
      witnesses: number;
      representations: number;
      passages: number;
      paused_runs: number;
      completed_runs: number;
    }>(`
      SELECT
        (SELECT count(*) FROM folklore.witness)::integer AS witnesses,
        (SELECT count(*) FROM folklore.representation)::integer
          AS representations,
        (SELECT count(*) FROM folklore.passage)::integer AS passages,
        (SELECT count(*) FROM folklore.ingest_run
          WHERE status = 'paused')::integer AS paused_runs,
        (SELECT count(*) FROM folklore.ingest_run
          WHERE status = 'completed')::integer AS completed_runs
    `);
    expect(counts.rows[0]).toEqual({
      witnesses: 27,
      representations: 28,
      passages: 27,
      paused_runs: 1,
      completed_runs: 2,
    });
  });

  it("rejects symlink escapes for acquisition and pinned reads", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-librivox-symlink-"),
    );
    const sourceRoot = join(temporaryDirectory, "sources");
    const outside = join(temporaryDirectory, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(outside, "section.mp3"), Buffer.from("audio"));
    await symlink(outside, join(sourceRoot, "audio"));
    const source = {
      uri: "https://example.test/section.mp3",
      path: "audio/section.mp3",
      mediaType: "audio/mpeg",
      byteLength: 5,
      sha256: sha256(Buffer.from("audio")),
    };

    await expect(acquireLockedSource({
      source,
      sourceRoot,
      fetchImpl: async () => new Response("audio"),
    })).rejects.toThrow(/symlink/);
    await expect(createPinnedSourceTransport({ sourceRoot })({
      uri: source.uri,
      sourcePath: source.path,
      mediaType: source.mediaType,
      expectedByteLength: source.byteLength,
      expectedSha256: source.sha256,
    })).rejects.toThrow(/symlink/);
  });

  it.each([
    ".",
    "foo/..",
    "/tmp/outside.mp3",
  ])("rejects degenerate cache path %s", async (path) => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-librivox-path-"),
    );
    const bytes = Buffer.from("audio");
    await expect(acquireLockedSource({
      source: {
        uri: "https://example.test/section.mp3",
        path,
        mediaType: "audio/mpeg",
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      },
      sourceRoot: join(temporaryDirectory, "cache"),
      fetchImpl: async () => new Response(bytes),
    })).rejects.toBeInstanceOf(PinnedSourceError);
  });

  it("rejects invalid duration and incomplete source-text rights review", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-librivox-invalid-"),
    );
    const sourceRoot = join(temporaryDirectory, "sources");
    const invalidDuration = await createFixtureSource(sourceRoot);
    invalidDuration.sections[0].durationSeconds = 0;
    expect(() => createLibriVoxAdapter(invalidDuration))
      .toThrow(/invalid metadata/);

    const incompleteRights = await createFixtureSource(sourceRoot);
    const reviewBytes = Buffer.from(JSON.stringify({
      jurisdiction: "US",
      recording: "public-domain",
      sourceText: "unknown",
    }));
    await writeFile(
      join(sourceRoot, incompleteRights.sources.jurisdictionReview.path),
      reviewBytes,
    );
    incompleteRights.sources.jurisdictionReview.byteLength =
      reviewBytes.byteLength;
    incompleteRights.sources.jurisdictionReview.sha256 =
      sha256(reviewBytes);
    database = new PGlite(join(temporaryDirectory, "pgdata"));
    await expect(collect(ingestCollection({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
      adapter: createLibriVoxAdapter(incompleteRights),
      captureTransport: createPinnedSourceTransport({ sourceRoot }),
      request: { fixture: "incomplete-rights" },
    }))).rejects.toThrow(/jurisdiction review is incomplete/);
  });
});
