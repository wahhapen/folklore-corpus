import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../db/migrations/0001_core.sql",
  import.meta.url,
);
const multilingualMigrationUrl = new URL(
  "../db/migrations/0003_multilingual_representations.sql",
  import.meta.url,
);

describe("evidence catalogue migration", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("creates the complete core schema in PostgreSQL", async () => {
    database = new PGlite();
    const migration = await readFile(migrationUrl, "utf8");

    await database.exec(migration);

    const result = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'folklore'
      ORDER BY table_name
    `);

    expect(result.rows.map(({ table_name }) => table_name)).toEqual([
      "alias",
      "archive",
      "artifact",
      "capture",
      "claim",
      "claim_evidence",
      "claim_object",
      "claim_relation",
      "derivation",
      "derivation_input",
      "derivation_output",
      "document",
      "edition",
      "passage",
      "passage_representation",
      "release",
      "release_member",
      "representation",
      "resource",
      "source_item",
      "split_assignment",
      "witness",
    ]);
  });

  it("enforces canonical identity and content digest invariants", async () => {
    database = new PGlite();
    const migration = await readFile(migrationUrl, "utf8");
    await database.exec(migration);

    await database.exec(`
      INSERT INTO folklore.resource (canonical_id, resource_kind)
      VALUES ('fa:artifact:sha256-test', 'artifact');

      INSERT INTO folklore.artifact (
        resource_pk,
        digest,
        byte_length,
        media_type,
        storage_key
      )
      SELECT
        resource_pk,
        decode(repeat('00', 32), 'hex'),
        0,
        'application/octet-stream',
        'sha256/00'
      FROM folklore.resource
      WHERE canonical_id = 'fa:artifact:sha256-test';
    `);

    await expect(
      database.exec(`
        INSERT INTO folklore.resource (canonical_id, resource_kind)
        VALUES ('fa:artifact:sha256-test', 'artifact');
      `),
    ).rejects.toThrow();

    await database.exec(`
      INSERT INTO folklore.resource (canonical_id, resource_kind)
      VALUES ('fa:artifact:sha256-short', 'artifact');
    `);

    await expect(
      database.exec(`
        INSERT INTO folklore.artifact (
          resource_pk,
          digest,
          byte_length,
          storage_key
        )
        SELECT
          resource_pk,
          decode('00', 'hex'),
          1,
          'sha256/short'
        FROM folklore.resource
        WHERE canonical_id = 'fa:artifact:sha256-short';
      `),
    ).rejects.toThrow();
  });

  it("records multilingual representation layers without changing the witness", async () => {
    database = new PGlite();
    await database.exec(await readFile(migrationUrl, "utf8"));
    await database.exec(await readFile(multilingualMigrationUrl, "utf8"));

    const columns = await database.query<{
      table_name: string;
      column_name: string;
    }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'folklore'
        AND (
          (table_name = 'representation'
            AND column_name IN ('script_code', 'dialect'))
          OR
          (table_name = 'passage' AND column_name = 'language_tag')
          OR
          (table_name = 'derivation' AND column_name = 'derivation_type')
        )
      ORDER BY table_name, column_name
    `);

    expect(columns.rows).toEqual([
      { table_name: "derivation", column_name: "derivation_type" },
      { table_name: "passage", column_name: "language_tag" },
      { table_name: "representation", column_name: "dialect" },
      { table_name: "representation", column_name: "script_code" },
    ]);

    await expect(
      database.exec(`
        INSERT INTO folklore.resource (canonical_id, resource_kind)
        VALUES ('fa:derivation:bad-type', 'derivation');

        INSERT INTO folklore.derivation (
          resource_pk,
          derivation_type,
          method,
          method_version,
          deterministic,
          completed_at
        )
        SELECT
          resource_pk,
          'motif-inference',
          'test',
          '1',
          true,
          current_timestamp
        FROM folklore.resource
        WHERE canonical_id = 'fa:derivation:bad-type';
      `),
    ).rejects.toThrow();
  });
});
