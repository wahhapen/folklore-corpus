import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { acquireLibriVoxSources } from "./acquire-librivox.mjs";
import { acquireSkvr } from "./acquire-skvr.mjs";
import { createSkvrI1VolumeAdapter } from "./adapters/skvr-i1.mjs";
import { auditLibriVox } from "./audit-librivox.mjs";
import { auditSkvr } from "./audit-skvr.mjs";
import {
  catalogueStats,
  importRelease,
  putArtifact,
} from "./build-catalogue.mjs";
import { projectV02Release } from "./build-v02-release.mjs";
import { ingestLibriVox } from "./ingest-librivox.mjs";
import { ingestCollection } from "./lib/collection-ingestion.mjs";
import { ensureResource } from "./lib/catalogue-storage.mjs";
import { createPinnedSourceTransport } from
  "./lib/pinned-source-transport.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function consume(iterable) {
  let committed = 0;
  for await (const event of iterable) {
    if (event.type === "item-committed") committed += 1;
  }
  return committed;
}

async function integritySummary(database) {
  const result = await database.query(`
    SELECT
      (SELECT count(*)::integer
       FROM folklore.resource resource
       WHERE resource.resource_kind = 'artifact'
         AND NOT EXISTS (
           SELECT 1 FROM folklore.artifact artifact
           WHERE artifact.resource_pk = resource.resource_pk
         )) AS artifact_row_gaps,
      (SELECT count(*)::integer
       FROM folklore.capture capture
       WHERE NOT EXISTS (
         SELECT 1 FROM folklore.artifact artifact
         WHERE artifact.resource_pk = capture.artifact_resource_pk
       )) AS capture_artifact_gaps,
      (SELECT count(*)::integer
       FROM folklore.representation representation
       WHERE NOT EXISTS (
         SELECT 1 FROM folklore.artifact artifact
         WHERE artifact.resource_pk = representation.artifact_resource_pk
       )) AS representation_artifact_gaps
  `);
  const summary = result.rows[0];
  if (Object.values(summary).some((value) => value !== 0)) {
    throw new Error(
      `Cumulative catalogue integrity failed: ${JSON.stringify(summary)}`,
    );
  }
  return summary;
}

async function persistSeedRights({ database, artifactRoot }) {
  const reviewPath = join(
    repositoryRoot,
    "data/gutenberg/rights-review-us.json",
  );
  const reviewBytes = await readFile(reviewPath);
  const review = JSON.parse(reviewBytes);
  const evidence = await putArtifact({
    database,
    artifactRoot,
    bytes: reviewBytes,
    mediaType: "application/json",
    sourcePath: reviewPath,
  });
  const archive = await database.query(`
    SELECT resource_pk
    FROM folklore.resource
    WHERE canonical_id = 'fa:archive:project-gutenberg'
  `);
  const sourceItemId =
    "fa:source-item:project-gutenberg:rights-review-us-v1";
  const sourceItemPk = await ensureResource(
    database,
    sourceItemId,
    "source-item",
  );
  await database.query(
    `INSERT INTO folklore.source_item (
       resource_pk, archive_resource_pk, native_id, landing_uri,
       native_metadata
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (resource_pk) DO NOTHING`,
    [
      sourceItemPk,
      archive.rows[0].resource_pk,
      "rights-review-us-v1",
      "https://github.com/wahhapen/folklore-corpus/blob/main/data/gutenberg/rights-review-us.json",
      JSON.stringify({
        role: "rights-evidence",
        reviewId: review.reviewId,
      }),
    ],
  );
  const captureId =
    `fa:capture:project-gutenberg:rights-review-us-v1:sha256-${evidence.digest}`;
  const capturePk = await ensureResource(database, captureId, "capture");
  await database.query(
    `INSERT INTO folklore.capture (
       resource_pk, source_item_resource_pk, artifact_resource_pk,
       captured_at, retrieval_uri, request_metadata, response_metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (resource_pk) DO NOTHING`,
    [
      capturePk,
      sourceItemPk,
      evidence.resourcePk,
      `${review.reviewedOn}T00:00:00Z`,
      "https://github.com/wahhapen/folklore-corpus/blob/main/data/gutenberg/rights-review-us.json",
      JSON.stringify({ role: "rights-evidence" }),
      JSON.stringify({
        sha256: evidence.digest,
        byteLength: reviewBytes.byteLength,
      }),
    ],
  );
  const seedArtifacts = await database.query(`
    SELECT
      artifact.resource_pk,
      resource.canonical_id,
      encode(artifact.digest, 'hex') AS digest
    FROM folklore.capture capture
    JOIN folklore.source_item source_item
      ON source_item.resource_pk = capture.source_item_resource_pk
    JOIN folklore.resource archive_resource
      ON archive_resource.resource_pk = source_item.archive_resource_pk
    JOIN folklore.artifact artifact
      ON artifact.resource_pk = capture.artifact_resource_pk
    JOIN folklore.resource resource
      ON resource.resource_pk = artifact.resource_pk
    WHERE archive_resource.canonical_id = 'fa:archive:project-gutenberg'
      AND source_item.native_id <> 'rights-review-us-v1'
    ORDER BY resource.canonical_id
  `);
  const subjects = [
    ...seedArtifacts.rows.map((row) => ({
      ...row,
      policy: review,
    })),
    {
      resource_pk: evidence.resourcePk,
      canonical_id: evidence.canonicalId,
      digest: evidence.digest,
      policy: {
        ...review.evidenceLicense,
        controlledStatus: "permission",
        statementUri:
          "https://github.com/wahhapen/folklore-corpus/blob/main/data/gutenberg/rights-review-us.json",
      },
    },
  ];
  for (const subject of subjects) {
    const assessmentDigest = createHash("sha256").update(
      `${subject.canonical_id}:${evidence.digest}:${review.reviewId}`,
    ).digest("hex");
    const assessmentId =
      `fa:rights-assessment:sha256-${assessmentDigest}`;
    const assessmentPk = await ensureResource(
      database,
      assessmentId,
      "rights-assessment",
    );
    await database.query(
      `INSERT INTO folklore.rights_assessment (
         resource_pk, subject_resource_pk, statement_uri, controlled_status,
         rights_source, attribution_text, commercial_use_allowed,
         derivatives_allowed, redistribution_allowed, ml_use_allowed,
         jurisdiction, reviewed_on, evidence_artifact_resource_pk,
         review_state, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         'accepted', $14
       )
       ON CONFLICT (resource_pk) DO NOTHING`,
      [
        assessmentPk,
        subject.resource_pk,
        subject.policy.statementUri ?? review.statementUri,
        subject.policy.controlledStatus,
        subject.policy.rightsSource,
        subject.policy.attributionText,
        subject.policy.commercialUseAllowed,
        subject.policy.derivativesAllowed,
        subject.policy.redistributionAllowed,
        subject.policy.mlUseAllowed,
        review.jurisdiction,
        review.reviewedOn,
        evidence.resourcePk,
        JSON.stringify({
          reviewId: review.reviewId,
          subjectDigest: subject.digest,
          limitations: review.limitations,
        }),
      ],
    );
  }
  return {
    evidenceArtifactId: evidence.canonicalId,
    subjectCount: subjects.length,
  };
}

export async function buildV02Catalogue({
  outputRoot,
  skvrSourceRoot,
  librivoxSourceRoot,
  releaseRoot,
  producerCommit,
}) {
  const started = performance.now();
  await Promise.all([
    acquireSkvr({ sourceRoot: skvrSourceRoot }),
    acquireLibriVoxSources({ sourceRoot: librivoxSourceRoot }),
  ]);

  await mkdir(outputRoot, { recursive: true });
  const artifactRoot = join(outputRoot, "artifacts");
  const database = new PGlite(join(outputRoot, "pgdata"));
  try {
    const seed = await importRelease({ database, artifactRoot });
    const seedRights = await persistSeedRights({ database, artifactRoot });
    const skvrLockPath = join(
      repositoryRoot,
      "data/skvr/i1-source.lock.json",
    );
    const skvrLockBytes = await readFile(skvrLockPath);
    const skvrLock = JSON.parse(skvrLockBytes);
    const skvrLockSha256 = createHash("sha256")
      .update(skvrLockBytes)
      .digest("hex");
    const skvrItems = await consume(ingestCollection({
      database,
      artifactRoot,
      adapter: createSkvrI1VolumeAdapter(skvrLock, {
        lockSha256: skvrLockSha256,
      }),
      captureTransport: createPinnedSourceTransport({
        sourceRoot: skvrSourceRoot,
      }),
      request: {
        collection: "skvr",
        pilot: "I1-base-1-100",
        lockSha256: skvrLockSha256,
      },
    }));
    const librivoxItems = await consume(await ingestLibriVox({
      database,
      artifactRoot,
      sourceRoot: librivoxSourceRoot,
    }));
    const skvrAudit = await auditSkvr(database);
    const librivoxAudit = await auditLibriVox(database);
    const integrity = await integritySummary(database);
    const cumulative = await catalogueStats(database);
    const release = releaseRoot == null
      ? null
      : await projectV02Release({
        database,
        catalogueRoot: outputRoot,
        releaseRoot,
        producerCommit,
      });
    await database.exec("CHECKPOINT");
    return {
      schemaVersion: "folklore-corpus-v0.2-build-report-v1",
      version: "0.2.0",
      durationMilliseconds: Math.round(performance.now() - started),
      sourceItemsCommitted: {
        skvr: skvrItems,
        librivox: librivoxItems,
      },
      seed,
      seedRights,
      cumulative,
      audits: {
        skvr: skvrAudit,
        librivox: librivoxAudit,
        integrity,
      },
      release,
    };
  } finally {
    await database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await buildV02Catalogue({
    outputRoot: resolve(option(
      "--output",
      join(repositoryRoot, "build/catalogue-v0.2.0"),
    )),
    skvrSourceRoot: resolve(option(
      "--skvr-source-root",
      join(repositoryRoot, "source-cache/skvr-i1"),
    )),
    librivoxSourceRoot: resolve(option(
      "--librivox-source-root",
      join(repositoryRoot, "source-cache/librivox"),
    )),
    releaseRoot: option("--release-root") == null
      ? null
      : resolve(option("--release-root")),
    producerCommit: option(
      "--producer-commit",
      process.env.FOLKLORE_PRODUCER_COMMIT,
    ),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
