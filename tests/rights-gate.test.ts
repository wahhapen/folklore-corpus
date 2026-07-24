import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const coreMigrationUrl = new URL(
  "../db/migrations/0001_core.sql",
  import.meta.url,
);
const rightsMigrationUrl = new URL(
  "../db/migrations/0002_rights_gate.sql",
  import.meta.url,
);

describe("Release rights gate", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("fails closed until byte-bearing members have accepted use rights and evidence", async () => {
    database = new PGlite();
    await database.exec(await readFile(coreMigrationUrl, "utf8"));
    await database.exec(await readFile(rightsMigrationUrl, "utf8"));
    await database.exec(`
      INSERT INTO folklore.resource (canonical_id, resource_kind)
      VALUES
        ('fa:artifact:sha256-content', 'artifact'),
        ('fa:artifact:sha256-rights-evidence', 'artifact'),
        ('fa:release:corpus-v0.2.0', 'release'),
        ('fa:rights-assessment:content-redistribution', 'rights-assessment'),
        ('fa:rights-assessment:rights-evidence', 'rights-assessment');

      INSERT INTO folklore.artifact (
        resource_pk, digest, byte_length, storage_key
      )
      SELECT resource_pk, decode(repeat('01', 32), 'hex'), 1, 'sha256/01'
      FROM folklore.resource
      WHERE canonical_id = 'fa:artifact:sha256-content';

      INSERT INTO folklore.artifact (
        resource_pk, digest, byte_length, storage_key
      )
      SELECT resource_pk, decode(repeat('02', 32), 'hex'), 1, 'sha256/02'
      FROM folklore.resource
      WHERE canonical_id = 'fa:artifact:sha256-rights-evidence';

      INSERT INTO folklore.release (
        resource_pk, version, manifest_artifact_resource_pk, published_at
      )
      SELECT
        release.resource_pk,
        '0.2.0',
        evidence.resource_pk,
        '2026-07-24'
      FROM folklore.resource release
      CROSS JOIN folklore.resource evidence
      WHERE release.canonical_id = 'fa:release:corpus-v0.2.0'
        AND evidence.canonical_id = 'fa:artifact:sha256-rights-evidence';

      INSERT INTO folklore.release_member (
        release_resource_pk, member_resource_pk, member_role, ordinal
      )
      SELECT release.resource_pk, content.resource_pk, 'artifact', 0
      FROM folklore.resource release
      CROSS JOIN folklore.resource content
      WHERE release.canonical_id = 'fa:release:corpus-v0.2.0'
        AND content.canonical_id = 'fa:artifact:sha256-content';
    `);

    const releasePk = await database.query<{ resource_pk: number }>(`
      SELECT resource_pk
      FROM folklore.resource
      WHERE canonical_id = 'fa:release:corpus-v0.2.0'
    `);
    const gapsBefore = await database.query<{ canonical_id: string }>(
      "SELECT canonical_id FROM folklore.release_rights_gaps($1, false)",
      [releasePk.rows[0].resource_pk],
    );
    expect(gapsBefore.rows.map((row) => row.canonical_id)).toEqual([
      "fa:artifact:sha256-content",
    ]);

    await database.exec(`
      INSERT INTO folklore.rights_assessment (
        resource_pk,
        subject_resource_pk,
        controlled_status,
        rights_source,
        attribution_text,
        commercial_use_allowed,
        derivatives_allowed,
        redistribution_allowed,
        ml_use_allowed,
        jurisdiction,
        reviewed_on,
        evidence_artifact_resource_pk,
        review_state
      )
      SELECT
        assessment.resource_pk,
        content.resource_pk,
        'public-domain',
        'Source rights declaration',
        'No attribution required',
        true,
        true,
        true,
        NULL,
        'US',
        '2026-07-24',
        evidence.resource_pk,
        'accepted'
      FROM folklore.resource assessment
      CROSS JOIN folklore.resource content
      CROSS JOIN folklore.resource evidence
      WHERE assessment.canonical_id =
          'fa:rights-assessment:content-redistribution'
        AND content.canonical_id = 'fa:artifact:sha256-content'
        AND evidence.canonical_id =
          'fa:artifact:sha256-rights-evidence';

      INSERT INTO folklore.rights_assessment (
        resource_pk,
        subject_resource_pk,
        controlled_status,
        rights_source,
        attribution_text,
        commercial_use_allowed,
        derivatives_allowed,
        redistribution_allowed,
        ml_use_allowed,
        jurisdiction,
        reviewed_on,
        evidence_artifact_resource_pk,
        review_state
      )
      SELECT
        assessment.resource_pk,
        evidence.resource_pk,
        'public-domain',
        'Project-authored rights review',
        'No attribution required',
        true,
        true,
        true,
        true,
        'US',
        '2026-07-24',
        evidence.resource_pk,
        'accepted'
      FROM folklore.resource assessment
      CROSS JOIN folklore.resource evidence
      WHERE assessment.canonical_id =
          'fa:rights-assessment:rights-evidence'
        AND evidence.canonical_id =
          'fa:artifact:sha256-rights-evidence';
    `);

    const missingEvidenceMembership = await database.query(
      "SELECT * FROM folklore.release_rights_gaps($1, false)",
      [releasePk.rows[0].resource_pk],
    );
    expect(missingEvidenceMembership.rows).toHaveLength(1);

    await database.exec(`
      INSERT INTO folklore.release_member (
        release_resource_pk, member_resource_pk, member_role, ordinal
      )
      SELECT release.resource_pk, assessment.resource_pk, 'rights-assessment', 1
      FROM folklore.resource release
      CROSS JOIN folklore.resource assessment
      WHERE release.canonical_id = 'fa:release:corpus-v0.2.0'
        AND assessment.canonical_id =
          'fa:rights-assessment:content-redistribution';

      INSERT INTO folklore.release_member (
        release_resource_pk, member_resource_pk, member_role, ordinal
      )
      SELECT release.resource_pk, assessment.resource_pk, 'rights-assessment', 3
      FROM folklore.resource release
      CROSS JOIN folklore.resource assessment
      WHERE release.canonical_id = 'fa:release:corpus-v0.2.0'
        AND assessment.canonical_id =
          'fa:rights-assessment:rights-evidence';

      INSERT INTO folklore.release_member (
        release_resource_pk, member_resource_pk, member_role, ordinal
      )
      SELECT release.resource_pk, evidence.resource_pk, 'rights-evidence', 2
      FROM folklore.resource release
      CROSS JOIN folklore.resource evidence
      WHERE release.canonical_id = 'fa:release:corpus-v0.2.0'
        AND evidence.canonical_id =
          'fa:artifact:sha256-rights-evidence';
    `);

    const redistributionGaps = await database.query(
      "SELECT * FROM folklore.release_rights_gaps($1, false)",
      [releasePk.rows[0].resource_pk],
    );
    expect(redistributionGaps.rows).toHaveLength(0);

    const mlGaps = await database.query<{ canonical_id: string }>(
      "SELECT canonical_id FROM folklore.release_rights_gaps($1, true)",
      [releasePk.rows[0].resource_pk],
    );
    expect(mlGaps.rows.map((row) => row.canonical_id)).toEqual([
      "fa:artifact:sha256-content",
    ]);
  });
});
