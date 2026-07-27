import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrations = [
  "../db/migrations/0001_core.sql",
  "../db/migrations/0003_multilingual_representations.sql",
  "../db/migrations/0006_translation_contract.sql",
].map((path) => new URL(path, import.meta.url));

async function migratedDatabase() {
  const database = new PGlite();
  for (const migration of migrations) {
    await database.exec(await readFile(migration, "utf8"));
  }
  return database;
}

async function seedRepresentations(database: PGlite) {
  await database.exec(`
    INSERT INTO folklore.resource (canonical_id, resource_kind) VALUES
      ('fa:document:test', 'document'),
      ('fa:witness:test', 'witness'),
      ('fa:artifact:source', 'artifact'),
      ('fa:artifact:translation', 'artifact'),
      ('fa:representation:source', 'representation'),
      ('fa:representation:translation', 'representation'),
      ('fa:agent:reviewer', 'agent'),
      ('fa:artifact:review', 'artifact');

    INSERT INTO folklore.document (resource_pk, title)
    SELECT resource_pk, 'Test'
    FROM folklore.resource WHERE canonical_id = 'fa:document:test';

    INSERT INTO folklore.witness (
      resource_pk, document_resource_pk, witness_kind
    )
    SELECT witness.resource_pk, document.resource_pk, 'text'
    FROM folklore.resource witness, folklore.resource document
    WHERE witness.canonical_id = 'fa:witness:test'
      AND document.canonical_id = 'fa:document:test';

    INSERT INTO folklore.artifact (
      resource_pk, digest, byte_length, media_type, storage_key
    )
    SELECT resource_pk, decode(repeat('01', 32), 'hex'), 1, 'text/plain',
           canonical_id
    FROM folklore.resource
    WHERE canonical_id = 'fa:artifact:source';

    INSERT INTO folklore.artifact (
      resource_pk, digest, byte_length, media_type, storage_key
    )
    SELECT resource_pk, decode(repeat('02', 32), 'hex'), 1, 'text/plain',
           canonical_id
    FROM folklore.resource
    WHERE canonical_id = 'fa:artifact:translation';

    INSERT INTO folklore.artifact (
      resource_pk, digest, byte_length, media_type, storage_key
    )
    SELECT resource_pk, decode(repeat('03', 32), 'hex'), 1,
           'application/json', canonical_id
    FROM folklore.resource
    WHERE canonical_id = 'fa:artifact:review';

    INSERT INTO folklore.representation (
      resource_pk, witness_resource_pk, artifact_resource_pk,
      representation_kind, language_tag
    )
    SELECT representation.resource_pk, witness.resource_pk,
           artifact.resource_pk, 'plain-text', 'fi'
    FROM folklore.resource representation, folklore.resource witness,
         folklore.resource artifact
    WHERE representation.canonical_id = 'fa:representation:source'
      AND witness.canonical_id = 'fa:witness:test'
      AND artifact.canonical_id = 'fa:artifact:source';

    INSERT INTO folklore.representation (
      resource_pk, witness_resource_pk, artifact_resource_pk,
      representation_kind, language_tag
    )
    SELECT representation.resource_pk, witness.resource_pk,
           artifact.resource_pk, 'plain-text', 'en'
    FROM folklore.resource representation, folklore.resource witness,
         folklore.resource artifact
    WHERE representation.canonical_id = 'fa:representation:translation'
      AND witness.canonical_id = 'fa:witness:test'
      AND artifact.canonical_id = 'fa:artifact:translation';
  `);
}

describe("translation provenance and review contract", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("records producer class independently from explicit review status", async () => {
    database = await migratedDatabase();
    await seedRepresentations(database);

    await database.exec(`
      INSERT INTO folklore.translation (
        translation_representation_resource_pk,
        source_representation_resource_pk,
        producer_class,
        review_status
      )
      SELECT translation.resource_pk, source.resource_pk,
             'machine-generated', 'unreviewed'
      FROM folklore.resource translation, folklore.resource source
      WHERE translation.canonical_id = 'fa:representation:translation'
        AND source.canonical_id = 'fa:representation:source';
    `);

    const result = await database.query(`
      SELECT producer_class, review_status
      FROM folklore.translation
    `);
    expect(result.rows).toEqual([{
      producer_class: "machine-generated",
      review_status: "unreviewed",
    }]);
  });

  it("rejects self-links and reviewed states without review provenance", async () => {
    database = await migratedDatabase();
    await seedRepresentations(database);

    await expect(database.exec(`
      INSERT INTO folklore.translation (
        translation_representation_resource_pk,
        source_representation_resource_pk,
        producer_class,
        review_status
      )
      SELECT resource_pk, resource_pk, 'expert-produced', 'unreviewed'
      FROM folklore.resource
      WHERE canonical_id = 'fa:representation:translation';
    `)).rejects.toThrow();

    await expect(database.exec(`
      INSERT INTO folklore.translation (
        translation_representation_resource_pk,
        source_representation_resource_pk,
        producer_class,
        review_status
      )
      SELECT translation.resource_pk, source.resource_pk,
             'source-published', 'accepted'
      FROM folklore.resource translation, folklore.resource source
      WHERE translation.canonical_id = 'fa:representation:translation'
        AND source.canonical_id = 'fa:representation:source';
    `)).rejects.toThrow();
  });
});
