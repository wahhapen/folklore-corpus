import { createHash } from "node:crypto";

export class CatalogueInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogueInvariantError";
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function ensureResource(database, canonicalId, resourceKind) {
  const inserted = await database.query(
    `INSERT INTO folklore.resource (canonical_id, resource_kind)
     VALUES ($1, $2)
     ON CONFLICT (canonical_id) DO NOTHING
     RETURNING resource_pk`,
    [canonicalId, resourceKind],
  );
  if (inserted.rows.length === 1) {
    return Number(inserted.rows[0].resource_pk);
  }

  const existing = await database.query(
    `SELECT resource_pk, resource_kind
     FROM folklore.resource
     WHERE canonical_id = $1`,
    [canonicalId],
  );
  if (
    existing.rows.length !== 1
    || existing.rows[0].resource_kind !== resourceKind
  ) {
    throw new CatalogueInvariantError(
      `Identity conflict for ${canonicalId}: expected ${resourceKind}`,
    );
  }
  return Number(existing.rows[0].resource_pk);
}

export async function registerArtifact({
  database,
  digest,
  byteLength,
  mediaType,
  storageKey,
}) {
  const canonicalId = `fa:artifact:sha256-${digest}`;
  const resourcePk = await ensureResource(database, canonicalId, "artifact");
  await database.query(
    `INSERT INTO folklore.artifact (
       resource_pk, digest, byte_length, media_type, storage_key
     ) VALUES ($1, decode($2, 'hex'), $3, $4, $5)
     ON CONFLICT (resource_pk) DO NOTHING`,
    [resourcePk, digest, byteLength, mediaType, storageKey],
  );
  return { canonicalId, resourcePk };
}
