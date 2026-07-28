import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PGlite } from "@electric-sql/pglite";
import { serializeReviewedOn } from "./lib/release-values.mjs";
import {
  assertReleasePublicationRights,
  RIGHTS_USE_CASES,
} from "./lib/rights-contract-v2.mjs";
import {
  supportsLanguageSensitiveUse,
} from "./lib/translation-contract-v1.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const run = promisify(execFile);
const seedReleaseRoot = join(
  repositoryRoot,
  "data/derived/releases/corpus-v0.1.0",
);
const CORE_JSONL = [
  "captures.jsonl",
  "editions.jsonl",
  "documents.jsonl",
  "witnesses.jsonl",
  "passages.jsonl",
  "lineage.jsonl",
  "splits.jsonl",
  "aliases.jsonl",
  "duplicate-candidates.jsonl",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function prepareReleaseRoot({ catalogueRoot, releaseRoot }) {
  const catalogue = resolve(catalogueRoot);
  const output = resolve(releaseRoot);
  if (
    output === resolve("/")
    || output === repositoryRoot
    || output === catalogue
    || isWithin(output, repositoryRoot)
    || isWithin(output, catalogue)
    || isWithin(catalogue, output)
  ) {
    throw new Error(`Unsafe or overlapping release root: ${output}`);
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
}

export async function verifyProducerCommit(producerCommit) {
  if (!/^[0-9a-f]{40}$/.test(producerCommit)) {
    throw new Error("A 40-character producer commit is required");
  }
  const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (head.trim() !== producerCommit) {
    throw new Error("Producer commit does not equal checked-out HEAD");
  }
  await run("git", ["cat-file", "-e", `${producerCommit}^{commit}`], {
    cwd: repositoryRoot,
  });
  const { stdout: status } = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (status.trim()) {
    throw new Error("Producer worktree is not clean");
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function jsonLine(record) {
  return `${JSON.stringify(record)}\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function captureIdentity(descriptor) {
  return `fa:capture:release-v0.3:sha256-` +
    sha256(Buffer.from(canonicalJson(descriptor)));
}

function releaseSourceMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !key.endsWith("CaptureId")),
  );
}

function releaseCaptureId(row) {
  return captureIdentity({
    archiveId: row.archive_id,
    sourceId: row.archive_id === "fa:archive:skvr"
      ? "skvr-i1-volume"
      : row.native_id,
    retrievalUri: row.retrieval_uri,
    artifactSha256: row.capture_artifact_sha256,
    byteLength: Number(row.capture_artifact_byte_length),
  });
}

function releaseEvidenceCaptureId(row) {
  if (row.archive_id === "fa:archive:project-gutenberg") {
    return row.capture_id;
  }
  return captureIdentity({
    archiveId: row.archive_id,
    sourceId: row.source_id,
    retrievalUri: row.retrieval_uri,
    artifactSha256: row.artifact_sha256,
    byteLength: Number(row.byte_length),
  });
}

async function readJsonLines(path) {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function writeJsonLines(path, records) {
  await writeFile(path, records.map(jsonLine).join(""), "utf8");
}

async function selectedRows(database) {
  const result = await database.query(`
    SELECT
      archive_resource.canonical_id AS archive_id,
      source_item.native_id,
      source_item.landing_uri,
      source_item.native_metadata,
      edition_resource.canonical_id AS edition_id,
      document_resource.canonical_id AS document_id,
      witness_resource.canonical_id AS witness_id,
      witness.witness_kind,
      witness.metadata AS witness_metadata,
      representation_resource.canonical_id AS representation_id,
      representation.representation_kind,
      representation.language_tag,
      representation.script_code,
      representation.dialect,
      representation.metadata AS representation_metadata,
      artifact_resource.canonical_id AS artifact_id,
      encode(artifact.digest, 'hex') AS artifact_sha256,
      artifact.byte_length,
      artifact.media_type,
      artifact.storage_key,
      capture_resource.canonical_id AS capture_id,
      capture.retrieval_uri,
      capture_artifact_resource.canonical_id AS capture_artifact_id,
      encode(capture_artifact.digest, 'hex') AS capture_artifact_sha256,
      capture_artifact.byte_length AS capture_artifact_byte_length,
      capture_artifact.media_type AS capture_artifact_media_type,
      capture_artifact.storage_key AS capture_artifact_storage_key,
      passage_resource.canonical_id AS passage_id,
      passage.ordinal,
      passage.source_anchor,
      passage.citation_label,
      passage_representation.selector,
      passage_representation.quoted_text,
      derivation_resource.canonical_id AS derivation_id,
      derivation.derivation_type,
      derivation.method,
      derivation.method_version,
      derivation.deterministic
    FROM folklore.source_item source_item
    JOIN folklore.archive archive
      ON archive.resource_pk = source_item.archive_resource_pk
    JOIN folklore.resource archive_resource
      ON archive_resource.resource_pk = archive.resource_pk
    JOIN folklore.edition edition
      ON edition.source_item_resource_pk = source_item.resource_pk
    JOIN folklore.resource edition_resource
      ON edition_resource.resource_pk = edition.resource_pk
    JOIN folklore.document document
      ON document.edition_resource_pk = edition.resource_pk
    JOIN folklore.resource document_resource
      ON document_resource.resource_pk = document.resource_pk
    JOIN folklore.witness witness
      ON witness.document_resource_pk = document.resource_pk
    JOIN folklore.resource witness_resource
      ON witness_resource.resource_pk = witness.resource_pk
    JOIN folklore.representation representation
      ON representation.witness_resource_pk = witness.resource_pk
    JOIN folklore.resource representation_resource
      ON representation_resource.resource_pk = representation.resource_pk
    JOIN folklore.artifact artifact
      ON artifact.resource_pk = representation.artifact_resource_pk
    JOIN folklore.resource artifact_resource
      ON artifact_resource.resource_pk = artifact.resource_pk
    JOIN folklore.passage passage
      ON passage.witness_resource_pk = witness.resource_pk
    JOIN folklore.resource passage_resource
      ON passage_resource.resource_pk = passage.resource_pk
    JOIN folklore.passage_representation passage_representation
      ON passage_representation.passage_resource_pk = passage.resource_pk
     AND passage_representation.representation_resource_pk =
       representation.resource_pk
    JOIN folklore.derivation_output derivation_output
      ON derivation_output.output_resource_pk = representation.resource_pk
     AND derivation_output.role = 'representation'
    JOIN folklore.derivation derivation
      ON derivation.resource_pk = derivation_output.derivation_resource_pk
    JOIN folklore.resource derivation_resource
      ON derivation_resource.resource_pk = derivation.resource_pk
    JOIN folklore.derivation_input capture_input
      ON capture_input.derivation_resource_pk = derivation.resource_pk
     AND capture_input.role = 'capture'
     AND capture_input.ordinal = 0
    JOIN folklore.capture capture
      ON capture.resource_pk = capture_input.input_resource_pk
    JOIN folklore.resource capture_resource
      ON capture_resource.resource_pk = capture.resource_pk
    JOIN folklore.artifact capture_artifact
      ON capture_artifact.resource_pk = capture.artifact_resource_pk
    JOIN folklore.resource capture_artifact_resource
      ON capture_artifact_resource.resource_pk = capture_artifact.resource_pk
    WHERE (
      archive_resource.canonical_id = 'fa:archive:skvr'
      AND representation.representation_kind = 'plain-text'
    ) OR (
      archive_resource.canonical_id =
        'fa:archive:librivox-celtic-fairy-tales-1837'
      AND representation.representation_kind = 'audio'
    )
    ORDER BY archive_id, source_item.native_id
  `);
  return result.rows;
}

async function representationRows(database) {
  const result = await database.query(`
    SELECT
      representation_resource.canonical_id AS id,
      witness_resource.canonical_id AS witness_id,
      representation.representation_kind AS kind,
      representation.language_tag,
      representation.script_code,
      representation.dialect,
      representation.metadata,
      artifact_resource.canonical_id AS artifact_id,
      encode(artifact.digest, 'hex') AS artifact_sha256,
      artifact.byte_length,
      artifact.media_type,
      artifact.storage_key,
      derivation_resource.canonical_id AS derivation_id
    FROM folklore.representation representation
    JOIN folklore.resource representation_resource
      ON representation_resource.resource_pk = representation.resource_pk
    JOIN folklore.witness witness
      ON witness.resource_pk = representation.witness_resource_pk
    JOIN folklore.resource witness_resource
      ON witness_resource.resource_pk = witness.resource_pk
    JOIN folklore.document document
      ON document.resource_pk = witness.document_resource_pk
    JOIN folklore.edition edition
      ON edition.resource_pk = document.edition_resource_pk
    JOIN folklore.source_item source_item
      ON source_item.resource_pk = edition.source_item_resource_pk
    JOIN folklore.archive archive
      ON archive.resource_pk = source_item.archive_resource_pk
    JOIN folklore.resource archive_resource
      ON archive_resource.resource_pk = archive.resource_pk
    JOIN folklore.artifact artifact
      ON artifact.resource_pk = representation.artifact_resource_pk
    JOIN folklore.resource artifact_resource
      ON artifact_resource.resource_pk = artifact.resource_pk
    JOIN folklore.derivation_output derivation_output
      ON derivation_output.output_resource_pk = representation.resource_pk
     AND derivation_output.role = 'representation'
    JOIN folklore.resource derivation_resource
      ON derivation_resource.resource_pk =
        derivation_output.derivation_resource_pk
    WHERE archive_resource.canonical_id IN (
      'fa:archive:skvr',
      'fa:archive:librivox-celtic-fairy-tales-1837'
    )
    ORDER BY id
  `);
  return result.rows;
}

async function sourceItemRows(database) {
  const result = await database.query(`
    SELECT
      source_resource.canonical_id AS id,
      archive_resource.canonical_id AS archive_id,
      source_item.native_id,
      source_item.landing_uri,
      source_item.native_metadata
    FROM folklore.source_item source_item
    JOIN folklore.resource source_resource
      ON source_resource.resource_pk = source_item.resource_pk
    JOIN folklore.resource archive_resource
      ON archive_resource.resource_pk = source_item.archive_resource_pk
    JOIN folklore.edition edition
      ON edition.source_item_resource_pk = source_item.resource_pk
    WHERE archive_resource.canonical_id IN (
      'fa:archive:skvr',
      'fa:archive:librivox-celtic-fairy-tales-1837'
    )
    ORDER BY id
  `);
  return result.rows;
}

async function derivationRows(database) {
  const result = await database.query(`
    SELECT DISTINCT
      derivation_resource.canonical_id AS id,
      derivation.derivation_type,
      derivation.method,
      derivation.method_version,
      derivation.parameters,
      derivation.runtime,
      derivation.deterministic,
      array_agg(DISTINCT input_resource.canonical_id
        ORDER BY input_resource.canonical_id) AS input_ids,
      array_agg(DISTINCT output_resource.canonical_id
        ORDER BY output_resource.canonical_id) AS output_ids
    FROM folklore.derivation derivation
    JOIN folklore.resource derivation_resource
      ON derivation_resource.resource_pk = derivation.resource_pk
    JOIN folklore.derivation_input derivation_input
      ON derivation_input.derivation_resource_pk = derivation.resource_pk
    JOIN folklore.resource input_resource
      ON input_resource.resource_pk = derivation_input.input_resource_pk
    JOIN folklore.derivation_output derivation_output
      ON derivation_output.derivation_resource_pk = derivation.resource_pk
    JOIN folklore.resource output_resource
      ON output_resource.resource_pk = derivation_output.output_resource_pk
    WHERE EXISTS (
      SELECT 1
      FROM folklore.derivation_output selected_output
      JOIN folklore.resource selected_resource
        ON selected_resource.resource_pk = selected_output.output_resource_pk
      WHERE selected_output.derivation_resource_pk = derivation.resource_pk
        AND (
          selected_resource.canonical_id LIKE
            'fa:representation:skvr:%'
          OR selected_resource.canonical_id LIKE
            'fa:representation:librivox-celtic-fairy-tales-1837:%'
        )
    )
    GROUP BY
      derivation_resource.canonical_id,
      derivation.derivation_type,
      derivation.method,
      derivation.method_version,
      derivation.parameters,
      derivation.runtime,
      derivation.deterministic
    ORDER BY id
  `);
  return result.rows;
}

function publishDerivations(derivations, captureIdMap) {
  return derivations.map((row) => {
    const content = {
      type: row.derivation_type,
      method: row.method,
      methodVersion: row.method_version,
      parameters: row.parameters,
      runtime: row.runtime,
      deterministic: row.deterministic,
      inputIds: row.input_ids
        .map((id) => captureIdMap.get(id) ?? id)
        .sort(),
      outputIds: [...row.output_ids].sort(),
    };
    return {
      schemaVersion: "folklore-derivation-v1",
      id: `fa:derivation:release-v0.3:sha256-` +
        sha256(Buffer.from(canonicalJson(content))),
      ...content,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

async function rightsRows(database) {
  const result = await database.query(`
    SELECT
      assessment_resource.canonical_id AS id,
      subject_resource.canonical_id AS subject_id,
      assessment.statement_uri,
      assessment.controlled_status,
      assessment.rights_source,
      assessment.attribution_text,
      assessment.commercial_use_allowed,
      assessment.derivatives_allowed,
      assessment.redistribution_allowed,
      assessment.ml_use_allowed,
      assessment.evidence_use_allowed,
      assessment.quotation_allowed,
      assessment.access_private_use_allowed,
      assessment.ml_evaluation_allowed,
      assessment.ml_training_allowed,
      assessment.jurisdiction,
      assessment.reviewed_on,
      assessment.review_state,
      evidence_resource.canonical_id AS evidence_artifact_id
    FROM folklore.rights_assessment assessment
    JOIN folklore.resource assessment_resource
      ON assessment_resource.resource_pk = assessment.resource_pk
    JOIN folklore.resource subject_resource
      ON subject_resource.resource_pk = assessment.subject_resource_pk
    JOIN folklore.resource evidence_resource
      ON evidence_resource.resource_pk =
        assessment.evidence_artifact_resource_pk
    ORDER BY subject_id, id
  `);
  return result.rows;
}

async function translationRows(database) {
  const result = await database.query(`
    SELECT
      translation_resource.canonical_id AS translation_representation_id,
      source_resource.canonical_id AS source_representation_id,
      translation.producer_class,
      translation.review_status,
      reviewer_resource.canonical_id AS reviewed_by_id,
      evidence_resource.canonical_id AS review_evidence_artifact_id,
      translation.metadata
    FROM folklore.translation translation
    JOIN folklore.resource translation_resource
      ON translation_resource.resource_pk =
        translation.translation_representation_resource_pk
    JOIN folklore.resource source_resource
      ON source_resource.resource_pk =
        translation.source_representation_resource_pk
    LEFT JOIN folklore.resource reviewer_resource
      ON reviewer_resource.resource_pk =
        translation.reviewed_by_resource_pk
    LEFT JOIN folklore.resource evidence_resource
      ON evidence_resource.resource_pk =
        translation.review_evidence_artifact_resource_pk
    ORDER BY translation_representation_id
  `);
  return result.rows;
}

function publishTranslations(translations) {
  return translations.map((row) => {
    const content = {
      translationRepresentationId: row.translation_representation_id,
      sourceRepresentationId: row.source_representation_id,
      producerClass: row.producer_class,
      reviewStatus: row.review_status,
      reviewedById: row.reviewed_by_id,
      reviewEvidenceArtifactId: row.review_evidence_artifact_id,
      metadata: row.metadata,
    };
    return {
      schemaVersion: "folklore-translation-v1",
      id: `fa:translation:sha256-${sha256(
        Buffer.from(canonicalJson(content)),
      )}`,
      ...content,
    };
  });
}

async function rightsEvidenceRows(database) {
  const result = await database.query(`
    SELECT DISTINCT
      artifact_resource.canonical_id AS artifact_id,
      encode(artifact.digest, 'hex') AS artifact_sha256,
      artifact.byte_length,
      artifact.media_type,
      artifact.storage_key,
      capture_resource.canonical_id AS capture_id,
      source_item.native_id AS source_id,
      archive_resource.canonical_id AS archive_id,
      source_item.landing_uri,
      capture.retrieval_uri
    FROM folklore.rights_assessment assessment
    JOIN folklore.artifact artifact
      ON artifact.resource_pk = assessment.evidence_artifact_resource_pk
    JOIN folklore.resource artifact_resource
      ON artifact_resource.resource_pk = artifact.resource_pk
    JOIN folklore.capture capture
      ON capture.artifact_resource_pk = artifact.resource_pk
    JOIN folklore.resource capture_resource
      ON capture_resource.resource_pk = capture.resource_pk
    JOIN folklore.source_item source_item
      ON source_item.resource_pk = capture.source_item_resource_pk
    JOIN folklore.archive archive
      ON archive.resource_pk = source_item.archive_resource_pk
    JOIN folklore.resource archive_resource
      ON archive_resource.resource_pk = archive.resource_pk
    ORDER BY artifact_id, capture_id
  `);
  return result.rows;
}

async function seedArtifactRows(database) {
  const result = await database.query(`
    SELECT DISTINCT
      artifact_resource.canonical_id AS artifact_id,
      encode(artifact.digest, 'hex') AS artifact_sha256,
      artifact.byte_length,
      artifact.media_type,
      artifact.storage_key
    FROM folklore.capture capture
    JOIN folklore.source_item source_item
      ON source_item.resource_pk = capture.source_item_resource_pk
    JOIN folklore.resource archive_resource
      ON archive_resource.resource_pk = source_item.archive_resource_pk
    JOIN folklore.artifact artifact
      ON artifact.resource_pk = capture.artifact_resource_pk
    JOIN folklore.resource artifact_resource
      ON artifact_resource.resource_pk = artifact.resource_pk
    WHERE archive_resource.canonical_id = 'fa:archive:project-gutenberg'
      AND source_item.native_id <> 'rights-review-us-v2'
    ORDER BY artifact_id
  `);
  return result.rows;
}

async function evaluateReleaseRights(database, {
  representations,
  rows,
  evidenceRows,
  seedArtifacts,
  rights,
}) {
  const members = new Map();
  const add = (id, role) => {
    if (!members.has(id)) members.set(id, role);
  };
  for (const row of representations) {
    add(row.id, "representation");
    add(row.artifact_id, "artifact");
  }
  for (const row of rows) {
    add(row.capture_artifact_id, "artifact");
  }
  for (const row of seedArtifacts) add(row.artifact_id, "artifact");
  for (const row of evidenceRows) add(row.artifact_id, "rights-evidence");
  for (const row of rights) add(row.id, "rights-assessment");

  await database.exec("BEGIN");
  try {
    const release = await database.query(`
      INSERT INTO folklore.resource (canonical_id, resource_kind)
      VALUES ('fa:release:corpus-v0.3.0-candidate', 'release')
      RETURNING resource_pk
    `);
    const releasePk = release.rows[0].resource_pk;
    await database.query(
      `INSERT INTO folklore.release (
         resource_pk, version, manifest_artifact_resource_pk, published_at,
         metadata
       ) VALUES ($1, '0.3.0-candidate', (
         SELECT resource_pk
         FROM folklore.resource
         WHERE canonical_id = $2
       ), '2026-07-25T00:00:00Z', $3)`,
      [
        releasePk,
        seedArtifacts[0].artifact_id,
        JSON.stringify({ purpose: "transactional-rights-gate" }),
      ],
    );
    let ordinal = 0;
    for (const [memberId, role] of [...members.entries()].sort()) {
      const inserted = await database.query(
        `INSERT INTO folklore.release_member (
           release_resource_pk, member_resource_pk, member_role, ordinal
         )
         SELECT $1, resource_pk, $3, $4
         FROM folklore.resource
         WHERE canonical_id = $2
         RETURNING member_resource_pk`,
        [releasePk, memberId, role, ordinal],
      );
      if (inserted.rows.length !== 1) {
        throw new Error(`Missing prospective Release member: ${memberId}`);
      }
      ordinal += 1;
    }
    const gaps = Object.fromEntries(
      await Promise.all(RIGHTS_USE_CASES.map(async ({ useCase }) => {
        const result = await database.query(
          `SELECT canonical_id, resource_kind
           FROM folklore.release_rights_gaps_v2($1, $2)`,
          [releasePk, useCase],
        );
        return [useCase, result.rows];
      })),
    );
    assertReleasePublicationRights(gaps);
    return {
      memberCount: members.size,
      useCaseGaps: Object.fromEntries(
        Object.entries(gaps).map(([useCase, rows]) => [
          useCase,
          rows.length,
        ]),
      ),
    };
  } finally {
    await database.exec("ROLLBACK");
  }
}

function projection(rows, evidenceRows) {
  const captures = new Map();
  const editions = [];
  const documents = [];
  const witnesses = [];
  const passages = [];
  const lineage = [];
  for (const row of rows) {
    const captureId = releaseCaptureId(row);
    const text = row.quoted_text
      ?? `${row.native_metadata.title} [audio metadata only; no transcript]`;
    const rawPath = `artifacts/${row.storage_key}`;
    const captureRawPath =
      `artifacts/${row.capture_artifact_storage_key}`;
    captures.set(captureId, {
      schemaVersion: "folklore-capture-v1",
      id: captureId,
      sourceId: row.archive_id === "fa:archive:skvr"
        ? "skvr-i1-volume"
        : row.native_id,
      capturedAt: "2026-07-25",
      institution: row.archive_id === "fa:archive:skvr"
        ? "Suomalaisen Kirjallisuuden Seura"
        : "LibriVox / Internet Archive",
      landingPage: row.landing_uri,
      retrievalUrl: row.retrieval_uri,
      rawPath: captureRawPath,
      rawSha256: row.capture_artifact_sha256,
      byteLength: Number(row.capture_artifact_byte_length),
    });
    editions.push({
      schemaVersion: "folklore-edition-v1",
      id: row.edition_id,
      captureId,
      title: row.native_metadata.title,
      language: row.language_tag,
      sourceUrl: row.landing_uri,
    });
    documents.push({
      schemaVersion: "folklore-document-v1",
      id: row.document_id,
      editionId: row.edition_id,
      sourceOrdinal: 1,
      recordType: row.archive_id === "fa:archive:skvr"
        ? "historical-oral-poem"
        : "public-domain-audio-section",
      title: row.native_metadata.title,
      language: row.language_tag,
      captureId,
      witnessIds: [row.witness_id],
      citation: {
        sourceUrl: row.landing_uri,
        preferred: row.citation_label,
      },
    });
    witnesses.push({
      schemaVersion: "folklore-witness-v1",
      id: row.witness_id,
      documentId: row.document_id,
      kind: row.witness_kind,
      language: row.language_tag,
      text,
      textStatus: row.quoted_text == null
        ? "metadata-only-no-transcript"
        : "source-derived-text",
      rawPath,
      rawSha256: row.artifact_sha256,
      selector: row.selector,
    });
    passages.push({
      schemaVersion: "folklore-passage-v1",
      id: row.passage_id,
      documentId: row.document_id,
      witnessId: row.witness_id,
      ordinal: Number(row.ordinal),
      text,
      citationLabel: row.citation_label,
      sourceAnchor: row.source_anchor,
      selector: row.selector,
      contentStatus: row.quoted_text == null
        ? "metadata-only-no-transcript"
        : "source-derived-text",
    });
    for (const [outputId, outputKind] of [
      [row.document_id, "document"],
      [row.witness_id, "witness"],
      [row.passage_id, "passage"],
    ]) {
      lineage.push({
        schemaVersion: "folklore-lineage-v1",
        outputId,
        outputKind,
        inputIds: [captureId],
        method: row.method,
        methodVersion: row.method_version,
        rawSha256: row.capture_artifact_sha256,
      });
    }
  }
  for (const row of evidenceRows) {
    const captureId = releaseEvidenceCaptureId(row);
    captures.set(captureId, {
      schemaVersion: "folklore-capture-v1",
      id: captureId,
      sourceId: row.source_id,
      capturedAt: "2026-07-25",
      institution: row.archive_id === "fa:archive:skvr"
        ? "Suomalaisen Kirjallisuuden Seura"
        : "LibriVox / Internet Archive",
      landingPage: row.landing_uri,
      retrievalUrl: row.retrieval_uri,
      rawPath: `artifacts/${row.storage_key}`,
      rawSha256: row.artifact_sha256,
      byteLength: Number(row.byte_length),
    });
  }
  return {
    captures: [...captures.values()],
    editions,
    documents,
    witnesses,
    passages,
    lineage,
  };
}

async function copySelectedArtifacts({
  catalogueRoot,
  releaseRoot,
  representations,
  rows,
  evidenceRows,
  seedArtifacts,
}) {
  const artifacts = new Map();
  const add = (storageKey, digest, byteLength) => {
    const existing = artifacts.get(storageKey);
    const specification = {
      digest,
      byteLength: Number(byteLength),
    };
    if (
      existing
      && (
        existing.digest !== specification.digest
        || existing.byteLength !== specification.byteLength
      )
    ) {
      throw new Error(`Conflicting Artifact metadata: ${storageKey}`);
    }
    artifacts.set(storageKey, specification);
  };
  for (const row of representations) {
    add(row.storage_key, row.artifact_sha256, row.byte_length);
  }
  for (const row of rows) {
    add(
      row.capture_artifact_storage_key,
      row.capture_artifact_sha256,
      row.capture_artifact_byte_length,
    );
  }
  for (const row of evidenceRows) {
    add(row.storage_key, row.artifact_sha256, row.byte_length);
  }
  for (const row of seedArtifacts) {
    add(row.storage_key, row.artifact_sha256, row.byte_length);
  }
  for (const [storageKey, expected] of [...artifacts.entries()].sort()) {
    const source = join(catalogueRoot, "artifacts", storageKey);
    const sourceStats = await stat(source);
    const sourceDigest = await sha256File(source);
    if (
      sourceStats.size !== expected.byteLength
      || sourceDigest !== expected.digest
    ) {
      throw new Error(`Artifact store mismatch: ${storageKey}`);
    }
    const destination = join(releaseRoot, "artifacts", storageKey);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function releaseArtifacts(releaseRoot, paths) {
  const artifacts = [];
  for (const path of [...paths].sort()) {
    const bytes = await readFile(join(releaseRoot, path));
    artifacts.push({
      path,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return artifacts;
}

export async function projectRelease({
  database,
  catalogueRoot,
  releaseRoot,
  producerCommit,
  producerAlreadyVerified = false,
}) {
  if (!producerAlreadyVerified) await verifyProducerCommit(producerCommit);
  await prepareReleaseRoot({ catalogueRoot, releaseRoot });
  const rows = await selectedRows(database);
    if (rows.length !== 127) {
      throw new Error(`Expected 127 selected release rows, got ${rows.length}`);
    }
    const representations = await representationRows(database);
    if (representations.length !== 227) {
      throw new Error(
        `Expected 227 collection Representations, got ${representations.length}`,
      );
    }
    const sourceItems = await sourceItemRows(database);
    if (sourceItems.length !== 127) {
      throw new Error(
        `Expected 127 logical Source Items, got ${sourceItems.length}`,
      );
    }
    const derivations = await derivationRows(database);
    const rights = await rightsRows(database);
    const translations = publishTranslations(
      await translationRows(database),
    );
    const evidenceRows = await rightsEvidenceRows(database);
    const seedArtifacts = await seedArtifactRows(database);
    const rightsGate = await evaluateReleaseRights(database, {
      representations,
      rows,
      evidenceRows,
      seedArtifacts,
      rights,
    });
    const additions = projection(rows, evidenceRows);
    const captureIdMap = new Map([
      ...rows.map((row) => [row.capture_id, releaseCaptureId(row)]),
      ...evidenceRows.map((row) => [
        row.capture_id,
        releaseEvidenceCaptureId(row),
      ]),
    ]);
    const publishedDerivations = publishDerivations(
      derivations,
      captureIdMap,
    );
    const derivationIdByRepresentation = new Map(
      publishedDerivations.flatMap((derivation) =>
        derivation.outputIds.filter((id) =>
          id.startsWith("fa:representation:")
        ).map((id) => [id, derivation.id])
      ),
    );
    const seedArtifactPathByDigest = new Map(
      seedArtifacts.map((row) => [
        row.artifact_sha256,
        `artifacts/${row.storage_key}`,
      ]),
    );
    for (const filename of CORE_JSONL) {
      let seed = await readJsonLines(join(seedReleaseRoot, filename));
      if (filename === "captures.jsonl" || filename === "witnesses.jsonl") {
        seed = seed.map((record) => ({
          ...record,
          rawPath: seedArtifactPathByDigest.get(record.rawSha256)
            ?? record.rawPath,
        }));
      }
      const key = filename.replace(".jsonl", "");
      const extra = additions[key] ?? [];
      await writeJsonLines(join(releaseRoot, filename), [...seed, ...extra]);
    }
    await copyFile(
      join(repositoryRoot, "schemas/corpus-release-v3.schema.json"),
      join(releaseRoot, "schema.json"),
    );
    await copyFile(
      join(repositoryRoot, "schemas/corpus-release-v2.schema.json"),
      join(releaseRoot, "corpus-release-v2.schema.json"),
    );
    await copyFile(
      join(seedReleaseRoot, "manifest.schema.json"),
      join(releaseRoot, "manifest.schema.json"),
    );
    await writeJsonLines(
      join(releaseRoot, "source-items.jsonl"),
      sourceItems.map((row) => ({
        schemaVersion: "folklore-source-item-v1",
        id: row.id,
        archiveId: row.archive_id,
        nativeId: row.native_id,
        landingUri: row.landing_uri,
        metadata: releaseSourceMetadata(row.native_metadata),
      })),
    );
    await writeJsonLines(
      join(releaseRoot, "representations.jsonl"),
      representations.map((row) => ({
        schemaVersion: "folklore-representation-v1",
        id: row.id,
        witnessId: row.witness_id,
        kind: row.kind,
        language: row.language_tag,
        script: row.script_code,
        dialect: row.dialect,
        metadata: row.metadata,
        artifactId: row.artifact_id,
        artifactPath: `artifacts/${row.storage_key}`,
        artifactSha256: row.artifact_sha256,
        byteLength: Number(row.byte_length),
        mediaType: row.media_type,
        derivationId: derivationIdByRepresentation.get(row.id),
      })),
    );
    await writeJsonLines(
      join(releaseRoot, "derivations.jsonl"),
      publishedDerivations,
    );
    await writeJsonLines(
      join(releaseRoot, "translations.jsonl"),
      translations,
    );
    await writeJsonLines(
      join(releaseRoot, "rights.jsonl"),
      rights.map((row) => ({
        schemaVersion: "folklore-rights-assessment-v2",
        id: row.id,
        subjectId: row.subject_id,
        statementUri: row.statement_uri,
        controlledStatus: row.controlled_status,
        rightsSource: row.rights_source,
        attributionText: row.attribution_text,
        commercialUseAllowed: row.commercial_use_allowed,
        derivativesAllowed: row.derivatives_allowed,
        redistributionAllowed: row.redistribution_allowed,
        mlUseAllowed: row.ml_use_allowed,
        ...Object.fromEntries(RIGHTS_USE_CASES.map(({
          releaseField,
          catalogueColumn,
        }) => [releaseField, row[catalogueColumn]])),
        jurisdiction: row.jurisdiction,
        reviewedOn: serializeReviewedOn(row.reviewed_on),
        reviewState: row.review_state,
        evidenceArtifactId: row.evidence_artifact_id,
      })),
    );
    const sourceEvidence = {
      schemaVersion: "folklore-source-evidence-v1",
      skvr: JSON.parse(await readFile(
        join(repositoryRoot, "data/skvr/i1-source.lock.json"),
        "utf8",
      )),
      librivox: JSON.parse(await readFile(
        join(repositoryRoot, "data/librivox/book-1837.lock.json"),
        "utf8",
      )),
    };
    const seedManifest = JSON.parse(await readFile(
      join(seedReleaseRoot, "manifest.json"),
      "utf8",
    ));
    await writeFile(
      join(releaseRoot, "source-evidence.json"),
      `${JSON.stringify(sourceEvidence, null, 2)}\n`,
    );
    await copySelectedArtifacts({
      catalogueRoot,
      releaseRoot,
      representations,
      rows,
      evidenceRows,
      seedArtifacts,
    });

    const counts = Object.fromEntries(
      await Promise.all([
        ["captures", "captures.jsonl"],
        ["editions", "editions.jsonl"],
        ["documents", "documents.jsonl"],
        ["witnesses", "witnesses.jsonl"],
        ["passages", "passages.jsonl"],
        ["aliases", "aliases.jsonl"],
        ["lineageEvents", "lineage.jsonl"],
        ["splitAssignments", "splits.jsonl"],
        ["sourceItems", "source-items.jsonl"],
        ["representations", "representations.jsonl"],
        ["derivations", "derivations.jsonl"],
        ["translations", "translations.jsonl"],
        ["rightsAssessments", "rights.jsonl"],
      ].map(async ([key, filename]) => [
        key,
        (await readJsonLines(join(releaseRoot, filename))).length,
      ])),
    );
    const gateReport = {
      schemaVersion: "folklore-corpus-v0.3-gate-report-v1",
      releaseId: "fa:release:corpus-v0.3.0",
      producerCommit,
      counts,
      releaseRights: rightsGate,
      translations: {
        total: translations.length,
        unreviewedMachineTranslations: translations.filter((translation) =>
          translation.producerClass === "machine-generated"
          && translation.reviewStatus === "unreviewed"
        ).length,
        languageSensitiveUseGaps: translations.filter((translation) =>
          !supportsLanguageSensitiveUse(translation)
        ).length,
      },
      collectionGates: {
        skvr: {
          selectedRecords: rows.filter((row) =>
            row.archive_id === "fa:archive:skvr"
          ).length,
          metadataGaps: rows.filter((row) =>
            row.archive_id === "fa:archive:skvr"
            && (!row.native_metadata?.title || !row.citation_label)
          ).length,
          selectorGaps: rows.filter((row) =>
            row.archive_id === "fa:archive:skvr" && row.selector == null
          ).length,
          languageGaps: rows.filter((row) =>
            row.archive_id === "fa:archive:skvr" && !row.language_tag
          ).length,
          rightsGaps: rightsGate.useCaseGaps.redistribution,
        },
        librivox: {
          selectedSections: rows.filter((row) =>
            row.archive_id ===
              "fa:archive:librivox-celtic-fairy-tales-1837"
          ).length,
          totalDurationSeconds: rows.filter((row) =>
            row.archive_id ===
              "fa:archive:librivox-celtic-fairy-tales-1837"
          ).reduce(
            (total, row) =>
              total + Number(row.witness_metadata?.durationSeconds ?? 0),
            0,
          ),
          metadataGaps: rows.filter((row) =>
            row.archive_id ===
              "fa:archive:librivox-celtic-fairy-tales-1837"
            && (
              !row.native_metadata?.title
              || !row.witness_metadata?.durationSeconds
            )
          ).length,
          selectorGaps: rows.filter((row) =>
            row.archive_id ===
              "fa:archive:librivox-celtic-fairy-tales-1837"
            && row.selector == null
          ).length,
          captureTraceGaps: rows.filter((row) =>
            row.archive_id ===
              "fa:archive:librivox-celtic-fairy-tales-1837"
            && !row.capture_artifact_id
          ).length,
          rightsGaps: rightsGate.useCaseGaps.redistribution,
        },
      },
      timing: {
        deterministicArtifact: false,
        note: "Wall-clock timings are emitted by db:build and are not included in the byte-reproducible release identity.",
      },
    };
    await writeFile(
      join(releaseRoot, "gate-report.json"),
      `${JSON.stringify(gateReport, null, 2)}\n`,
    );
    await writeFile(
      join(releaseRoot, "dataset-card.md"),
      `# Folklore Corpus v0.3.0\n\n` +
      `Cumulative evidence release containing the complete v0.1 Gutenberg ` +
      `seed, 100 SKVR I1 records, and 27 LibriVox sections.\n\n` +
      `SKVR is released as official pinned volume XML plus deterministic ` +
      `Unicode plain text; it is not represented as TEI or as an archive-` +
      `normalized edition. LibriVox audio has whole-section time selectors ` +
      `but no transcript; its searchable text is explicitly metadata-only.\n\n` +
      `SKVR data is CC BY 4.0 with attribution to the Finnish Literature ` +
      `Society SKS. The selected LibriVox recordings and Gutenberg source ` +
      `text are assessed as public domain in the United States. See ` +
      `rights.jsonl and source-evidence.json for evidence and limitations.\n\n` +
      `Rights Contract v2 records independent tri-state decisions for ` +
      `evidence use, quotation, redistribution, access/private use, ML ` +
      `evaluation, and ML training. True means allowed, false means ` +
      `prohibited, and null means unknown; false and null both fail the ` +
      `corresponding executable release gate. Historical v0.2 rights are ` +
      `not promoted automatically and require an explicit v2 review.\n\n` +
      `Translations are separate provenance records linking each translated ` +
      `Representation to an original-language Representation shipped beside ` +
      `it. Producer class and review status are independent. Unreviewed, ` +
      `rejected, or superseded translations must not support language-` +
      `sensitive claims; consumers can inspect translations.jsonl and the ` +
      `machine-readable gate report instead of inferring trust from origin.\n`,
    );

    const artifactPaths = [];
    for (const filename of [
      ...CORE_JSONL,
      "schema.json",
      "corpus-release-v2.schema.json",
      "manifest.schema.json",
      "source-items.jsonl",
      "representations.jsonl",
      "derivations.jsonl",
      "translations.jsonl",
      "rights.jsonl",
      "source-evidence.json",
      "gate-report.json",
      "dataset-card.md",
    ]) {
      artifactPaths.push(filename);
    }
    for (const representation of representations) {
      artifactPaths.push(`artifacts/${representation.storage_key}`);
    }
    for (const row of rows) {
      artifactPaths.push(
        `artifacts/${row.capture_artifact_storage_key}`,
      );
    }
    for (const row of evidenceRows) {
      artifactPaths.push(`artifacts/${row.storage_key}`);
    }
    for (const row of seedArtifacts) {
      artifactPaths.push(`artifacts/${row.storage_key}`);
    }
    const artifacts = await releaseArtifacts(
      releaseRoot,
      new Set(artifactPaths),
    );
    const manifest = {
      schemaVersion: "folklore-release-manifest-v1",
      releaseId: "fa:release:corpus-v0.3.0",
      version: "0.3.0",
      publishedAt: "2026-07-27",
      producer: {
        repository: "wahhapen/folklore-corpus",
        commit: producerCommit,
      },
      compiler: {
        command: "npm run release:build",
        parser: "catalogue-v0.3-projection-v1",
        node: ">=22.13.0",
      },
      counts,
      inputs: [
        ...seedManifest.inputs,
        ...(sourceEvidence.skvr.sources
          ? Object.values(sourceEvidence.skvr.sources)
          : []),
        ...Object.values(sourceEvidence.librivox.sources),
        ...sourceEvidence.librivox.sections.map(({ media }) => media),
      ].filter((source) =>
        (source.sourceUrl ?? source.uri).startsWith("https://")
      ).map((source) => ({
        path: source.sourcePath ?? source.path,
        sourceUrl: source.sourceUrl ?? source.uri,
        byteLength: source.byteLength,
        sha256: source.sha256,
      })),
      artifacts,
    };
    await writeFile(
      join(releaseRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  return {
    releaseRoot,
    manifestSha256: sha256(await readFile(
      join(releaseRoot, "manifest.json"),
    )),
    counts,
    artifactCount: artifacts.length,
  };
}

export async function buildRelease(options) {
  const database = new PGlite(join(options.catalogueRoot, "pgdata"));
  try {
    return await projectRelease({ ...options, database });
  } finally {
    await database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildRelease({
    catalogueRoot: resolve(option(
      "--catalogue-root",
      join(repositoryRoot, "build/catalogue-v0.3.0"),
    )),
    releaseRoot: resolve(option(
      "--release-root",
      join(repositoryRoot, "build/releases/corpus-v0.3.0"),
    )),
    producerCommit: option(
      "--producer-commit",
      process.env.FOLKLORE_PRODUCER_COMMIT,
    ),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
