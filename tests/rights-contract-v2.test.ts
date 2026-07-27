import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationUrls = [
  "../db/migrations/0001_core.sql",
  "../db/migrations/0002_rights_gate.sql",
  "../db/migrations/0005_rights_contract_v2.sql",
].map((path) => new URL(path, import.meta.url));

describe("Rights Contract v2", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("fails closed until each governed use is explicitly allowed", async () => {
    database = new PGlite();
    for (const migrationUrl of migrationUrls) {
      await database.exec(await readFile(migrationUrl, "utf8"));
    }
    await database.exec(`
      INSERT INTO folklore.resource (canonical_id, resource_kind)
      VALUES
        ('fa:artifact:content', 'artifact'),
        ('fa:artifact:rights-evidence', 'artifact'),
        ('fa:release:corpus-v0.3.0', 'release'),
        ('fa:rights-assessment:content-v2', 'rights-assessment');

      INSERT INTO folklore.artifact (
        resource_pk, digest, byte_length, storage_key
      )
      SELECT resource_pk, decode(repeat('01', 32), 'hex'), 1, 'sha256/01'
      FROM folklore.resource
      WHERE canonical_id = 'fa:artifact:content';

      INSERT INTO folklore.artifact (
        resource_pk, digest, byte_length, storage_key
      )
      SELECT resource_pk, decode(repeat('02', 32), 'hex'), 1, 'sha256/02'
      FROM folklore.resource
      WHERE canonical_id = 'fa:artifact:rights-evidence';

      INSERT INTO folklore.release (
        resource_pk, version, manifest_artifact_resource_pk, published_at
      )
      SELECT release.resource_pk, '0.3.0', evidence.resource_pk, '2026-07-27'
      FROM folklore.resource release
      CROSS JOIN folklore.resource evidence
      WHERE release.canonical_id = 'fa:release:corpus-v0.3.0'
        AND evidence.canonical_id = 'fa:artifact:rights-evidence';

      INSERT INTO folklore.rights_assessment (
        resource_pk,
        subject_resource_pk,
        controlled_status,
        rights_source,
        attribution_text,
        redistribution_allowed,
        jurisdiction,
        reviewed_on,
        evidence_artifact_resource_pk,
        review_state
      )
      SELECT
        assessment.resource_pk,
        content.resource_pk,
        'licensed',
        'Fixture rights declaration',
        'Fixture attribution',
        NULL,
        'US',
        '2026-07-27',
        evidence.resource_pk,
        'accepted'
      FROM folklore.resource assessment
      CROSS JOIN folklore.resource content
      CROSS JOIN folklore.resource evidence
      WHERE assessment.canonical_id = 'fa:rights-assessment:content-v2'
        AND content.canonical_id = 'fa:artifact:content'
        AND evidence.canonical_id = 'fa:artifact:rights-evidence';

      INSERT INTO folklore.release_member (
        release_resource_pk, member_resource_pk, member_role, ordinal
      )
      SELECT release.resource_pk, member.resource_pk, member.resource_kind, row_number() OVER ()
      FROM folklore.resource release
      CROSS JOIN folklore.resource member
      WHERE release.canonical_id = 'fa:release:corpus-v0.3.0'
        AND member.canonical_id IN (
          'fa:artifact:content',
          'fa:artifact:rights-evidence',
          'fa:rights-assessment:content-v2'
        );
    `);

    const release = await database.query<{ resource_pk: number }>(`
      SELECT resource_pk
      FROM folklore.resource
      WHERE canonical_id = 'fa:release:corpus-v0.3.0'
    `);
    const gaps = () => database!.query<{ canonical_id: string }>(
      "SELECT canonical_id FROM folklore.release_rights_gaps_v2($1, 'evidence-use')",
      [release.rows[0].resource_pk],
    );

    expect((await gaps()).rows.map(({ canonical_id }) => canonical_id)).toEqual([
      "fa:artifact:content",
      "fa:artifact:rights-evidence",
    ]);

    await database.exec(`
      UPDATE folklore.rights_assessment
      SET evidence_use_allowed = true
      WHERE resource_pk = (
        SELECT resource_pk
        FROM folklore.resource
        WHERE canonical_id = 'fa:rights-assessment:content-v2'
      );
    `);

    expect((await gaps()).rows.map(({ canonical_id }) => canonical_id)).toEqual([
      "fa:artifact:rights-evidence",
    ]);

    const governedUses = [
      ["quotation", "quotation_allowed"],
      ["redistribution", "redistribution_allowed"],
      ["access-private-use", "access_private_use_allowed"],
      ["ml-evaluation", "ml_evaluation_allowed"],
      ["ml-training", "ml_training_allowed"],
    ] as const;
    for (const [useCase, column] of governedUses) {
      const before = await database.query<{ canonical_id: string }>(
        `SELECT canonical_id
         FROM folklore.release_rights_gaps_v2($1, '${useCase}')`,
        [release.rows[0].resource_pk],
      );
      expect(before.rows.map(({ canonical_id }) => canonical_id)).toContain(
        "fa:artifact:content",
      );

      await database.exec(`
        UPDATE folklore.rights_assessment
        SET ${column} = true
        WHERE resource_pk = (
          SELECT resource_pk
          FROM folklore.resource
          WHERE canonical_id = 'fa:rights-assessment:content-v2'
        );
      `);
      const after = await database.query<{ canonical_id: string }>(
        `SELECT canonical_id
         FROM folklore.release_rights_gaps_v2($1, '${useCase}')`,
        [release.rows[0].resource_pk],
      );
      expect(after.rows.map(({ canonical_id }) => canonical_id)).not.toContain(
        "fa:artifact:content",
      );
    }
  });
});
