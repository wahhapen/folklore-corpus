import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { applyCatalogueMigrations } from "../build-catalogue.mjs";
import {
  CatalogueInvariantError,
  ensureResource,
  registerArtifact,
  sha256,
} from "./catalogue-storage.mjs";

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SELECTOR_FIELDS = {
  AudioTimeSelector: ["startSeconds", "endSeconds"],
  LineSelector: ["startLine", "endLine"],
  TextPositionSelector: ["start", "end"],
};
const DERIVATION_TYPES = new Set([
  null,
  "translation",
  "transliteration",
  "normalization",
  "transcription",
]);
const SAFE_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
]);
const RIGHTS_REVIEW_STATES = new Set([
  "unreviewed",
  "accepted",
  "rejected",
  "superseded",
]);

export class IngestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IngestValidationError";
  }
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

function requireKey(value, field) {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new IngestValidationError(
      `${field} must be a stable lowercase external key`,
    );
  }
}

function requireNonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new IngestValidationError(`${field} is required`);
  }
}

function isJsonValue(value, seen = new Set()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isBcp47LanguageTag(value) {
  if (value == null) return true;
  if (typeof value !== "string" || value === "") return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function sanitizeResponseMetadata(metadata) {
  const sanitized = {};
  if (Number.isInteger(metadata?.status)) {
    sanitized.status = metadata.status;
  }
  const headers = {};
  for (const [name, value] of Object.entries(metadata?.headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if (
      SAFE_RESPONSE_HEADERS.has(normalizedName)
      && (typeof value === "string" || typeof value === "number")
    ) {
      headers[normalizedName] = String(value);
    }
  }
  if (Object.keys(headers).length > 0) sanitized.headers = headers;
  return sanitized;
}

function validateSelector(selector, field) {
  if (!selector || !SELECTOR_FIELDS[selector.type]) {
    throw new IngestValidationError(`${field} has no supported selector`);
  }
  const [startField, endField] = SELECTOR_FIELDS[selector.type];
  if (
    !Number.isFinite(selector[startField])
    || !Number.isFinite(selector[endField])
    || selector[startField] < 0
    || selector[endField] < selector[startField]
  ) {
    throw new IngestValidationError(`${field} has an invalid range`);
  }
}

function validateItem(item, captured, materialized) {
  if (item?.release !== undefined) {
    throw new IngestValidationError("Adapters cannot publish Releases");
  }
  requireKey(item?.externalKey, "item.externalKey");
  if (!isJsonValue(item.checkpointAfter)) {
    throw new IngestValidationError(
      "item.checkpointAfter must be a JSON value",
    );
  }
  if (!Array.isArray(item.captures) || item.captures.length === 0) {
    throw new IngestValidationError("item.captures is required");
  }
  for (const handle of item.captures) {
    if (!handle || captured.get(handle.key)?.captureId !== handle.captureId) {
      throw new IngestValidationError(
        "item.captures must come from AdapterContext.capture",
      );
    }
  }
  const itemCaptureKeys = new Set(item.captures.map(({ key }) => key));
  const itemArtifacts = item.artifacts ?? [];
  if (!Array.isArray(itemArtifacts)) {
    throw new IngestValidationError("item.artifacts must be an array");
  }
  for (const handle of itemArtifacts) {
    if (!handle || materialized.get(handle.key)?.artifactId !== handle.artifactId) {
      throw new IngestValidationError(
        "item.artifacts must come from AdapterContext.materialize",
      );
    }
  }
  const itemArtifactKeys = new Set(itemArtifacts.map(({ key }) => key));
  requireKey(item.sourceItem?.externalKey, "sourceItem.externalKey");
  requireNonEmpty(item.sourceItem?.nativeId, "sourceItem.nativeId");
  if (!Array.isArray(item.witnesses) || item.witnesses.length === 0) {
    throw new IngestValidationError("item.witnesses is required");
  }
  for (const [witnessIndex, witness] of item.witnesses.entries()) {
    requireKey(witness.externalKey, `witnesses[${witnessIndex}].externalKey`);
    requireNonEmpty(witness.kind, `witnesses[${witnessIndex}].kind`);
    if (
      !Array.isArray(witness.representations)
      || witness.representations.length === 0
    ) {
      throw new IngestValidationError(
        `witnesses[${witnessIndex}].representations is required`,
      );
    }
    for (const [representationIndex, representation] of
      witness.representations.entries()) {
      const field =
        `witnesses[${witnessIndex}].representations[${representationIndex}]`;
      requireKey(representation.externalKey, `${field}.externalKey`);
      requireNonEmpty(representation.kind, `${field}.kind`);
      const hasCapture = representation.captureKey != null;
      const hasArtifact = representation.artifactKey != null;
      if (hasCapture === hasArtifact) {
        throw new IngestValidationError(
          `${field} needs exactly one captureKey or artifactKey`,
        );
      }
      if (
        hasCapture
        && (
          !captured.has(representation.captureKey)
          || !itemCaptureKeys.has(representation.captureKey)
        )
      ) {
        throw new IngestValidationError(
          `${field}.captureKey must be included in item.captures`,
        );
      }
      if (
        hasArtifact
        && (
          !materialized.has(representation.artifactKey)
          || !itemArtifactKeys.has(representation.artifactKey)
        )
      ) {
        throw new IngestValidationError(
          `${field}.artifactKey must be included in item.artifacts`,
        );
      }
      if (!isBcp47LanguageTag(representation.languageTag)) {
        throw new IngestValidationError(
          `${field}.languageTag must be a BCP 47 language tag`,
        );
      }
      if (
        representation.scriptCode != null
        && !/^[A-Z][a-z]{3}$/.test(representation.scriptCode)
      ) {
        throw new IngestValidationError(
          `${field}.scriptCode must be ISO 15924 shaped`,
        );
      }
      const derivation = representation.derivation;
      if (
        !derivation
        || !DERIVATION_TYPES.has(derivation.type ?? null)
        || !derivation.method
        || !derivation.methodVersion
      ) {
        throw new IngestValidationError(
          `${field}.derivation is incomplete`,
        );
      }
      if (hasArtifact) {
        if (
          !Array.isArray(derivation.inputCaptureKeys)
          || derivation.inputCaptureKeys.length === 0
          || derivation.inputCaptureKeys.some((key) =>
            !captured.has(key) || !itemCaptureKeys.has(key)
          )
        ) {
          throw new IngestValidationError(
            `${field}.derivation.inputCaptureKeys must reference item captures`,
          );
        }
      }
      if (
        !Array.isArray(representation.passages)
        || representation.passages.length === 0
      ) {
        throw new IngestValidationError(`${field}.passages is required`);
      }
      for (const [passageIndex, passage] of
        representation.passages.entries()) {
        requireKey(
          passage.externalKey,
          `${field}.passages[${passageIndex}].externalKey`,
        );
        if (!Number.isInteger(passage.ordinal) || passage.ordinal < 1) {
          throw new IngestValidationError(
            `${field}.passages[${passageIndex}].ordinal is invalid`,
          );
        }
        requireNonEmpty(
          passage.sourceAnchor,
          `${field}.passages[${passageIndex}].sourceAnchor`,
        );
        validateSelector(
          passage.selector,
          `${field}.passages[${passageIndex}].selector`,
        );
        if (!isBcp47LanguageTag(passage.languageTag)) {
          throw new IngestValidationError(
            `${field}.passages[${passageIndex}].languageTag must be BCP 47`,
          );
        }
      }
    }
  }
  const rights = item.rights;
  const evidenceCaptureKeys = Array.isArray(rights?.evidenceCaptureKeys)
    ? rights.evidenceCaptureKeys
    : [rights?.evidenceCaptureKey];
  if (
    !rights
    || evidenceCaptureKeys.length === 0
    || new Set(evidenceCaptureKeys).size !== evidenceCaptureKeys.length
    || evidenceCaptureKeys.some((key) =>
      !captured.has(key) || !itemCaptureKeys.has(key)
    )
  ) {
    throw new IngestValidationError(
      "item.rights with captured evidence is required",
    );
  }
  if (!RIGHTS_REVIEW_STATES.has(rights.reviewState)) {
    throw new IngestValidationError(
      "item.rights.reviewState is not recognized",
    );
  }
  for (const field of [
    "rightsSource",
    "attributionText",
    "jurisdiction",
    "reviewedOn",
    "reviewState",
  ]) {
    requireNonEmpty(rights[field], `item.rights.${field}`);
  }
  if (
    !rights.statementUri
    && !rights.controlledStatus
  ) {
    throw new IngestValidationError(
      "item.rights needs a statement URI or controlled status",
    );
  }
}

async function tableExists(database, table) {
  const result = await database.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'folklore' AND table_name = $1
    ) AS exists`,
    [table],
  );
  return result.rows[0].exists;
}

async function ensureIngestionMigration(database) {
  await applyCatalogueMigrations(database);
  if (!(await tableExists(database, "ingest_run"))) {
    const { readFile } = await import("node:fs/promises");
    const migrationUrl = new URL(
      "../../db/migrations/0004_ingestion_runs.sql",
      import.meta.url,
    );
    await database.exec(await readFile(migrationUrl, "utf8"));
  }
}

async function recordArtifact({
  database,
  artifactRoot,
  digest,
  byteLength,
  mediaType,
  temporaryPath,
  bytes,
}) {
  const storageKey = join("sha256", digest.slice(0, 2), digest);
  const path = join(artifactRoot, storageKey);
  await mkdir(dirname(path), { recursive: true });
  let artifactExists = false;
  try {
    await stat(path);
    artifactExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (artifactExists) {
    if (temporaryPath) await unlink(temporaryPath);
  } else {
    if (temporaryPath) {
      await rename(temporaryPath, path);
    } else {
      await writeFile(path, bytes);
    }
  }
  const { canonicalId, resourcePk } = await registerArtifact({
    database,
    digest,
    byteLength,
    mediaType,
    storageKey,
  });
  return { canonicalId, resourcePk, digest, byteLength, path };
}

async function putArtifact(database, artifactRoot, response, mediaType) {
  if (response.bytes !== undefined) {
    const bytes = Buffer.isBuffer(response.bytes)
      ? response.bytes
      : Buffer.from(response.bytes);
    return recordArtifact({
      database,
      artifactRoot,
      digest: sha256(bytes),
      byteLength: bytes.byteLength,
      mediaType,
      bytes,
    });
  }
  if (!response.body?.[Symbol.asyncIterator]) {
    throw new IngestValidationError(
      "capture transport must return bytes or an async iterable body",
    );
  }

  const temporaryRoot = join(artifactRoot, ".capture-tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryPath = join(temporaryRoot, randomUUID());
  const file = await open(temporaryPath, "wx");
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk);
      byteLength += chunk.byteLength;
      await file.write(chunk);
    }
  } catch (error) {
    await file.close();
    await unlink(temporaryPath);
    throw error;
  }
  await file.close();
  return recordArtifact({
    database,
    artifactRoot,
    digest: hash.digest("hex"),
    byteLength,
    mediaType,
    temporaryPath,
  });
}

async function startOrResumeRun(database, adapter, requestHash) {
  const active = await database.query(
    `SELECT resource.canonical_id, run.resource_pk, run.checkpoint
     FROM folklore.ingest_run run
     JOIN folklore.resource resource USING (resource_pk)
     WHERE run.adapter_key = $1
       AND run.adapter_version = $2
       AND run.request_hash = decode($3, 'hex')
       AND run.status IN ('running', 'paused')
     ORDER BY run.started_at DESC
     LIMIT 1`,
    [adapter.key, adapter.version, requestHash],
  );
  if (active.rows.length) {
    await database.query(
      `UPDATE folklore.ingest_run
       SET status = 'running', error = NULL, updated_at = current_timestamp
       WHERE resource_pk = $1`,
      [active.rows[0].resource_pk],
    );
    return {
      runId: active.rows[0].canonical_id,
      runPk: Number(active.rows[0].resource_pk),
      checkpoint: active.rows[0].checkpoint,
    };
  }

  const runId = `fa:ingest-run:${adapter.key}:${randomUUID()}`;
  const runPk = await ensureResource(database, runId, "ingest-run");
  await database.query(
    `INSERT INTO folklore.ingest_run (
       resource_pk, adapter_key, adapter_version, request_hash, status
     ) VALUES ($1, $2, $3, decode($4, 'hex'), 'running')`,
    [runPk, adapter.key, adapter.version, requestHash],
  );
  return { runId, runPk, checkpoint: null };
}

async function persistCapture({
  database,
  artifactRoot,
  adapter,
  archivePk,
  runId,
  sourceKey,
  role,
  request,
  captureTransport,
}) {
  requireKey(sourceKey, "capture.sourceKey");
  requireNonEmpty(role, "capture.role");
  requireNonEmpty(request?.uri, "capture.request.uri");
  requireNonEmpty(request?.mediaType, "capture.request.mediaType");
  const response = await captureTransport(request);
  const artifact = await putArtifact(
    database,
    artifactRoot,
    response,
    request.mediaType,
  );
  if (
    request.expectedSha256 != null
    && artifact.digest !== request.expectedSha256
  ) {
    throw new IngestValidationError(
      `Captured source digest mismatch for ${request.uri}`,
    );
  }
  if (
    request.expectedByteLength != null
    && artifact.byteLength !== request.expectedByteLength
  ) {
    throw new IngestValidationError(
      `Captured source byte length mismatch for ${request.uri}`,
    );
  }
  const sourceItemId = `fa:source-item:${adapter.key}:capture-${sourceKey}`;
  const sourceItemPk = await ensureResource(
    database,
    sourceItemId,
    "source-item",
  );
  await database.query(
    `INSERT INTO folklore.source_item (
       resource_pk, archive_resource_pk, native_id, landing_uri, native_metadata
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (resource_pk) DO NOTHING`,
    [
      sourceItemPk,
      archivePk,
      sourceKey,
      request.uri,
      JSON.stringify({ role }),
    ],
  );
  const runToken = runId.split(":").at(-1);
  const captureId =
    `fa:capture:${adapter.key}:${runToken}:${sourceKey}:sha256-${artifact.digest}`;
  const capturePk = await ensureResource(database, captureId, "capture");
  await database.query(
    `INSERT INTO folklore.capture (
       resource_pk, source_item_resource_pk, artifact_resource_pk,
       captured_at, retrieval_uri, request_metadata, response_metadata
     ) VALUES ($1, $2, $3, current_timestamp, $4, $5, $6)
     ON CONFLICT (resource_pk) DO NOTHING`,
    [
      capturePk,
      sourceItemPk,
      artifact.resourcePk,
      request.uri,
      JSON.stringify({ role }),
      JSON.stringify(sanitizeResponseMetadata(response.responseMetadata)),
    ],
  );
  return {
    handle: {
      key: sourceKey,
      captureId,
      capturePk,
      artifactId: artifact.canonicalId,
      artifactPk: artifact.resourcePk,
      digest: artifact.digest,
      mediaType: request.mediaType,
    },
    artifactPath: artifact.path,
  };
}

async function persistRights(database, subject, rights, evidence) {
  const policyDigest = sha256(Buffer.from(canonicalJson(rights)));
  const assessmentId =
    `fa:rights-assessment:sha256-${sha256(Buffer.from(
      `${subject.canonicalId}:${policyDigest}:${evidence.artifactId}`,
    ))}`;
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
       jurisdiction, reviewed_on, evidence_artifact_resource_pk, review_state
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
     )
     ON CONFLICT (resource_pk) DO NOTHING`,
    [
      assessmentPk,
      subject.resourcePk,
      rights.statementUri ?? null,
      rights.controlledStatus ?? null,
      rights.rightsSource,
      rights.attributionText,
      rights.commercialUseAllowed ?? null,
      rights.derivativesAllowed ?? null,
      rights.redistributionAllowed ?? null,
      rights.mlUseAllowed ?? null,
      rights.jurisdiction,
      rights.reviewedOn,
      evidence.artifactPk,
      rights.reviewState,
    ],
  );
}

async function persistItem({
  database,
  adapter,
  archivePk,
  runPk,
  item,
  captured,
  materialized,
}) {
  const digest = sha256(Buffer.from(canonicalJson(item)));
  const alreadyCommitted = await database.query(
    `SELECT encode(item_digest, 'hex') AS item_digest
     FROM folklore.ingest_item_commit
     WHERE run_resource_pk = $1 AND external_key = $2`,
    [runPk, item.externalKey],
  );
  if (alreadyCommitted.rows.length) {
    if (alreadyCommitted.rows[0].item_digest !== digest) {
      throw new IngestValidationError(
        `Committed item ${item.externalKey} changed during resume`,
      );
    }
    return { skipped: true };
  }

  const counts = {
    sourceItems: 0,
    witnesses: 0,
    representations: 0,
    passages: 0,
    derivations: 0,
  };
  await database.exec("BEGIN");
  try {
    const sourceItemId =
      `fa:source-item:${adapter.key}:${item.sourceItem.externalKey}`;
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
        archivePk,
        item.sourceItem.nativeId,
        item.sourceItem.landingUri ?? null,
        JSON.stringify(item.sourceItem.metadata ?? {}),
      ],
    );
    counts.sourceItems += 1;

    const firstRepresentation =
      item.witnesses[0]?.representations[0];
    const editionId =
      `fa:edition:${adapter.key}:${item.sourceItem.externalKey}`;
    const editionPk = await ensureResource(database, editionId, "edition");
    await database.query(
      `INSERT INTO folklore.edition (
         resource_pk, source_item_resource_pk, title, language_tag, metadata
       ) VALUES ($1, $2, $3, $4, '{}'::jsonb)
       ON CONFLICT (resource_pk) DO NOTHING`,
      [
        editionPk,
        sourceItemPk,
        item.sourceItem.metadata?.title ?? item.sourceItem.nativeId,
        firstRepresentation?.languageTag ?? null,
      ],
    );
    const documentId =
      `fa:document:${adapter.key}:${item.sourceItem.externalKey}:source`;
    const documentPk = await ensureResource(database, documentId, "document");
    await database.query(
      `INSERT INTO folklore.document (
         resource_pk, edition_resource_pk, source_ordinal, title,
         language_tag, metadata
       ) VALUES ($1, $2, 1, $3, $4, '{}'::jsonb)
       ON CONFLICT (resource_pk) DO NOTHING`,
      [
        documentPk,
        editionPk,
        item.sourceItem.metadata?.title ?? item.sourceItem.nativeId,
        firstRepresentation?.languageTag ?? null,
      ],
    );

    const evidenceCaptureKeys = Array.isArray(
      item.rights.evidenceCaptureKeys,
    )
      ? item.rights.evidenceCaptureKeys
      : [item.rights.evidenceCaptureKey];
    const evidence = evidenceCaptureKeys.map((key) => captured.get(key));
    const rightsSubjects = new Map();
    for (const handle of item.captures) {
      rightsSubjects.set(handle.artifactId, {
        canonicalId: handle.artifactId,
        resourcePk: handle.artifactPk,
      });
    }
    for (const handle of item.artifacts ?? []) {
      rightsSubjects.set(handle.artifactId, {
        canonicalId: handle.artifactId,
        resourcePk: handle.artifactPk,
      });
    }

    for (const witness of item.witnesses) {
      const witnessId =
        `fa:witness:${adapter.key}:${item.externalKey}:${witness.externalKey}`;
      const witnessPk = await ensureResource(database, witnessId, "witness");
      await database.query(
        `INSERT INTO folklore.witness (
           resource_pk, document_resource_pk, witness_kind, metadata
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (resource_pk) DO NOTHING`,
        [
          witnessPk,
          documentPk,
          witness.kind,
          JSON.stringify(witness.metadata ?? {}),
        ],
      );
      counts.witnesses += 1;

      for (const representation of witness.representations) {
        const capture = representation.captureKey == null
          ? null
          : captured.get(representation.captureKey);
        const artifact = capture
          ?? materialized.get(representation.artifactKey);
        const representationId =
          `fa:representation:${adapter.key}:${item.externalKey}:` +
          `${witness.externalKey}:${representation.externalKey}:` +
          `sha256-${artifact.digest}`;
        const representationPk = await ensureResource(
          database,
          representationId,
          "representation",
        );
        await database.query(
          `INSERT INTO folklore.representation (
             resource_pk, witness_resource_pk, artifact_resource_pk,
             representation_kind, language_tag, script_code, dialect, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (resource_pk) DO NOTHING`,
          [
            representationPk,
            witnessPk,
            artifact.artifactPk,
            representation.kind,
            representation.languageTag ?? null,
            representation.scriptCode ?? null,
            representation.dialect ?? null,
            JSON.stringify(representation.metadata ?? {}),
          ],
        );
        rightsSubjects.set(representationId, {
          canonicalId: representationId,
          resourcePk: representationPk,
        });
        counts.representations += 1;

        for (const passage of representation.passages) {
          const passageId =
            `fa:passage:${adapter.key}:${item.externalKey}:` +
            `${witness.externalKey}:${passage.externalKey}`;
          const passagePk = await ensureResource(
            database,
            passageId,
            "passage",
          );
          const existingPassage = await database.query(
            `SELECT
               witness_resource_pk, ordinal, source_anchor, citation_label,
               language_tag
             FROM folklore.passage
             WHERE resource_pk = $1`,
            [passagePk],
          );
          const passageIdentity = {
            witnessResourcePk: witnessPk,
            ordinal: passage.ordinal,
            sourceAnchor: passage.sourceAnchor,
            citationLabel: passage.citationLabel ?? null,
            languageTag: passage.languageTag ?? null,
          };
          if (existingPassage.rows.length) {
            const existing = existingPassage.rows[0];
            if (
              Number(existing.witness_resource_pk)
                !== passageIdentity.witnessResourcePk
              || Number(existing.ordinal) !== passageIdentity.ordinal
              || existing.source_anchor !== passageIdentity.sourceAnchor
              || existing.citation_label !== passageIdentity.citationLabel
              || existing.language_tag !== passageIdentity.languageTag
            ) {
              throw new IngestValidationError(
                `Passage ${passageId} changed; mint a replacement identity`,
              );
            }
          } else {
            await database.query(
              `INSERT INTO folklore.passage (
                 resource_pk, witness_resource_pk, ordinal, source_anchor,
                 citation_label, language_tag
               ) VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                passagePk,
                passageIdentity.witnessResourcePk,
                passageIdentity.ordinal,
                passageIdentity.sourceAnchor,
                passageIdentity.citationLabel,
                passageIdentity.languageTag,
              ],
            );
          }
          const quotedText = passage.quotedText ?? null;
          const sliceDigest = quotedText == null
            ? null
            : sha256(Buffer.from(quotedText));
          const existingSlice = await database.query(
            `SELECT selector, quoted_text, encode(slice_digest, 'hex')
               AS slice_digest
             FROM folklore.passage_representation
             WHERE passage_resource_pk = $1
               AND representation_resource_pk = $2`,
            [passagePk, representationPk],
          );
          if (existingSlice.rows.length) {
            const existing = existingSlice.rows[0];
            if (
              canonicalJson(existing.selector)
                !== canonicalJson(passage.selector)
              || existing.quoted_text !== quotedText
              || existing.slice_digest !== sliceDigest
            ) {
              throw new IngestValidationError(
                `Selector for ${passageId} changed under an immutable Representation`,
              );
            }
          } else {
            await database.query(
              `INSERT INTO folklore.passage_representation (
                 passage_resource_pk, representation_resource_pk, selector,
                 quoted_text, slice_digest
               ) VALUES ($1, $2, $3, $4, decode($5, 'hex'))`,
              [
                passagePk,
                representationPk,
                JSON.stringify(passage.selector),
                quotedText,
                sliceDigest,
              ],
            );
          }
          counts.passages += 1;
        }

        const derivationId =
          `fa:derivation:${adapter.key}:sha256-${sha256(Buffer.from(
            `${representationId}:` +
            `${capture?.captureId ?? artifact.artifactId}:` +
            canonicalJson(representation.derivation),
          ))}`;
        const derivationPk = await ensureResource(
          database,
          derivationId,
          "derivation",
        );
        await database.query(
          `INSERT INTO folklore.derivation (
             resource_pk, derivation_type, method, method_version,
             parameters, runtime, deterministic, completed_at
           ) VALUES (
             $1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, $5, current_timestamp
           )
           ON CONFLICT (resource_pk) DO NOTHING`,
          [
            derivationPk,
            representation.derivation.type ?? null,
            representation.derivation.method,
            representation.derivation.methodVersion,
            representation.derivation.deterministic,
          ],
        );
        const inputCaptures = capture
          ? [capture]
          : representation.derivation.inputCaptureKeys
            .map((key) => captured.get(key));
        for (const [inputIndex, inputCapture] of inputCaptures.entries()) {
          await database.query(
            `INSERT INTO folklore.derivation_input (
               derivation_resource_pk, ordinal, input_resource_pk, role
             ) VALUES ($1, $2, $3, 'capture')
             ON CONFLICT (derivation_resource_pk, ordinal) DO NOTHING`,
            [derivationPk, inputIndex, inputCapture.capturePk],
          );
        }
        await database.query(
          `INSERT INTO folklore.derivation_input (
             derivation_resource_pk, ordinal, input_resource_pk, role
           ) VALUES ($1, $2, $3, 'source-item')
           ON CONFLICT (derivation_resource_pk, ordinal) DO NOTHING`,
          [derivationPk, inputCaptures.length, sourceItemPk],
        );
        await database.query(
          `INSERT INTO folklore.derivation_output (
             derivation_resource_pk, ordinal, output_resource_pk, role
           ) VALUES ($1, 0, $2, 'representation')
           ON CONFLICT (derivation_resource_pk, ordinal) DO NOTHING`,
          [derivationPk, representationPk],
        );
        if (!capture) {
          await database.query(
            `INSERT INTO folklore.derivation_output (
               derivation_resource_pk, ordinal, output_resource_pk, role
             ) VALUES ($1, 1, $2, 'artifact')
             ON CONFLICT (derivation_resource_pk, ordinal) DO NOTHING`,
            [derivationPk, artifact.artifactPk],
          );
        }
        counts.derivations += 1;
      }
    }

    for (const subject of rightsSubjects.values()) {
      for (const evidenceArtifact of evidence) {
        await persistRights(
          database,
          subject,
          item.rights,
          evidenceArtifact,
        );
      }
    }

    await database.query(
      `INSERT INTO folklore.ingest_item_commit (
         run_resource_pk, external_key, item_digest, checkpoint_after
       ) VALUES ($1, $2, decode($3, 'hex'), $4)`,
      [runPk, item.externalKey, digest, JSON.stringify(item.checkpointAfter)],
    );
    await database.query(
      `UPDATE folklore.ingest_run
       SET checkpoint = $2, updated_at = current_timestamp
       WHERE resource_pk = $1`,
      [runPk, JSON.stringify(item.checkpointAfter)],
    );
    await database.exec("COMMIT");
    return { skipped: false, counts };
  } catch (error) {
    await database.exec("ROLLBACK");
    throw error;
  }
}

export async function* ingestCollection({
  database,
  artifactRoot,
  adapter,
  captureTransport,
  request = {},
  signal = new AbortController().signal,
}) {
  requireKey(adapter?.key, "adapter.key");
  requireNonEmpty(adapter?.version, "adapter.version");
  requireNonEmpty(adapter?.archive?.name, "adapter.archive.name");
  if (typeof adapter.read !== "function") {
    throw new IngestValidationError("adapter.read is required");
  }
  if (typeof captureTransport !== "function") {
    throw new IngestValidationError("captureTransport is required");
  }

  await ensureIngestionMigration(database);
  const requestHash = sha256(Buffer.from(canonicalJson(request)));
  const run = await startOrResumeRun(database, adapter, requestHash);
  const archiveId = `fa:archive:${adapter.key}`;
  const archivePk = await ensureResource(database, archiveId, "archive");
  await database.query(
    `INSERT INTO folklore.archive (
       resource_pk, name, homepage_uri, metadata
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (resource_pk) DO NOTHING`,
    [
      archivePk,
      adapter.archive.name,
      adapter.archive.homepageUri ?? null,
      JSON.stringify(adapter.archive.metadata ?? {}),
    ],
  );
  const captured = new Map();
  const capturedPaths = new Map();
  const materialized = new Map();
  const materializedPaths = new Map();
  const context = {
    checkpoint: run.checkpoint,
    signal,
    capture: async ({ sourceKey, role, request: captureRequest }) => {
      if (signal.aborted) throw signal.reason ?? new Error("Ingest aborted");
      if (captured.has(sourceKey)) return captured.get(sourceKey);
      const persisted = await persistCapture({
        database,
        artifactRoot,
        adapter,
        archivePk,
        runId: run.runId,
        sourceKey,
        role,
        request: captureRequest,
        captureTransport,
      });
      captured.set(sourceKey, persisted.handle);
      capturedPaths.set(sourceKey, persisted.artifactPath);
      return persisted.handle;
    },
    materialize: async ({ artifactKey, mediaType, bytes }) => {
      if (signal.aborted) throw signal.reason ?? new Error("Ingest aborted");
      requireKey(artifactKey, "materialize.artifactKey");
      requireNonEmpty(mediaType, "materialize.mediaType");
      if (bytes === undefined) {
        throw new IngestValidationError("materialize.bytes is required");
      }
      const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const digest = sha256(value);
      if (materialized.has(artifactKey)) {
        const existing = materialized.get(artifactKey);
        if (existing.digest !== digest) {
          throw new IngestValidationError(
            `materialize artifactKey ${artifactKey} changed within one run`,
          );
        }
        return existing;
      }
      const artifact = await recordArtifact({
        database,
        artifactRoot,
        digest,
        byteLength: value.byteLength,
        mediaType,
        bytes: value,
      });
      const handle = {
        key: artifactKey,
        artifactId: artifact.canonicalId,
        artifactPk: artifact.resourcePk,
        digest: artifact.digest,
        mediaType,
      };
      materialized.set(artifactKey, handle);
      materializedPaths.set(artifactKey, artifact.path);
      return handle;
    },
    readText: async (handle) => {
      const capturePath =
        captured.get(handle?.key)?.captureId === handle?.captureId
          ? capturedPaths.get(handle.key)
          : null;
      const artifactPath =
        materialized.get(handle?.key)?.artifactId === handle?.artifactId
          ? materializedPaths.get(handle.key)
          : null;
      if (!capturePath && !artifactPath) {
        throw new IngestValidationError(
          "AdapterContext.readText requires an engine-owned handle",
        );
      }
      return readFile(capturePath ?? artifactPath, "utf8");
    },
  };

  try {
    for await (const item of adapter.read(context)) {
      validateItem(item, captured, materialized);
      const result = await persistItem({
        database,
        adapter,
        archivePk,
        runPk: run.runPk,
        item,
        captured,
        materialized,
      });
      if (!result.skipped) {
        yield {
          type: "item-committed",
          runId: run.runId,
          externalKey: item.externalKey,
          checkpoint: item.checkpointAfter,
          counts: result.counts,
        };
      }
      context.checkpoint = item.checkpointAfter;
    }
    await database.query(
      `UPDATE folklore.ingest_run
       SET status = 'completed', completed_at = current_timestamp,
           updated_at = current_timestamp
       WHERE resource_pk = $1`,
      [run.runPk],
    );
    yield { type: "run-completed", runId: run.runId };
  } catch (error) {
    const status =
      error instanceof IngestValidationError
      || error instanceof CatalogueInvariantError
      ? "failed"
      : "paused";
    await database.query(
      `UPDATE folklore.ingest_run
       SET status = $2, error = $3, updated_at = current_timestamp
       WHERE resource_pk = $1`,
      [
        run.runPk,
        status,
        JSON.stringify({
          name: error.name,
          message: error.message,
        }),
      ],
    );
    throw error;
  }
}

export async function getIngestRun(database, runId) {
  const result = await database.query(
    `SELECT run.status, run.checkpoint, run.adapter_key, run.adapter_version
     FROM folklore.ingest_run run
     JOIN folklore.resource resource USING (resource_pk)
     WHERE resource.canonical_id = $1`,
    [runId],
  );
  if (!result.rows.length) return null;
  return {
    status: result.rows[0].status,
    checkpoint: result.rows[0].checkpoint,
    adapterKey: result.rows[0].adapter_key,
    adapterVersion: result.rows[0].adapter_version,
  };
}
