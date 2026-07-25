import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function auditLibriVox(database) {
  const result = await database.query(`
    WITH selected_representations AS (
      SELECT
        representation.resource_pk,
        representation.witness_resource_pk,
        representation.artifact_resource_pk,
        representation.metadata
      FROM folklore.representation representation
      JOIN folklore.resource resource USING (resource_pk)
      WHERE resource.canonical_id LIKE
        'fa:representation:librivox-celtic-fairy-tales-1837:%'
    ),
    selected_passages AS (
      SELECT
        passage.resource_pk,
        passage.witness_resource_pk,
        passage_representation.representation_resource_pk,
        passage_representation.selector
      FROM folklore.passage passage
      JOIN folklore.passage_representation passage_representation
        ON passage_representation.passage_resource_pk = passage.resource_pk
      JOIN selected_representations representation
        ON representation.resource_pk =
          passage_representation.representation_resource_pk
    ),
    selected_artifacts AS (
      SELECT DISTINCT artifact_resource_pk AS resource_pk
      FROM selected_representations
      UNION
      SELECT DISTINCT capture.artifact_resource_pk
      FROM folklore.capture capture
      JOIN folklore.resource resource USING (resource_pk)
      WHERE resource.canonical_id LIKE
        'fa:capture:librivox-celtic-fairy-tales-1837:%'
    ),
    releasable_artifacts AS (
      SELECT DISTINCT artifact_resource_pk AS resource_pk
      FROM selected_representations
      UNION
      SELECT DISTINCT capture.artifact_resource_pk
      FROM folklore.capture capture
      JOIN folklore.resource resource USING (resource_pk)
      WHERE resource.canonical_id LIKE
        'fa:capture:librivox-celtic-fairy-tales-1837:%:jurisdiction-review:%'
    ),
    rights_subjects AS (
      SELECT resource_pk FROM selected_representations
      UNION
      SELECT resource_pk FROM releasable_artifacts
    )
    SELECT
      (SELECT count(*)::integer
       FROM folklore.source_item source_item
       JOIN folklore.archive archive
         ON archive.resource_pk = source_item.archive_resource_pk
       JOIN folklore.resource archive_resource
         ON archive_resource.resource_pk = archive.resource_pk
       WHERE archive_resource.canonical_id =
         'fa:archive:librivox-celtic-fairy-tales-1837'
         AND source_item.native_id ~ '^[0-9]+$') AS sections,
      (SELECT min(source_item.native_id)
       FROM folklore.source_item source_item
       JOIN folklore.archive archive
         ON archive.resource_pk = source_item.archive_resource_pk
       JOIN folklore.resource archive_resource
         ON archive_resource.resource_pk = archive.resource_pk
       WHERE archive_resource.canonical_id =
         'fa:archive:librivox-celtic-fairy-tales-1837'
         AND source_item.native_id ~ '^[0-9]+$') AS first_section_id,
      (SELECT max(source_item.native_id)
       FROM folklore.source_item source_item
       JOIN folklore.archive archive
         ON archive.resource_pk = source_item.archive_resource_pk
       JOIN folklore.resource archive_resource
         ON archive_resource.resource_pk = archive.resource_pk
       WHERE archive_resource.canonical_id =
         'fa:archive:librivox-celtic-fairy-tales-1837'
         AND source_item.native_id ~ '^[0-9]+$') AS last_section_id,
      (SELECT count(*)::integer
       FROM selected_representations) AS representations,
      (SELECT count(*)::integer
       FROM selected_passages) AS passages,
      (SELECT count(DISTINCT witness_resource_pk)::integer
       FROM selected_representations) AS witnesses,
      (SELECT count(*)::integer
       FROM selected_artifacts) AS artifacts,
      (SELECT sum(
         (witness.metadata->>'durationSeconds')::integer
       )::integer
       FROM folklore.witness witness
       WHERE witness.resource_pk IN (
         SELECT witness_resource_pk FROM selected_representations
       )) AS total_duration_seconds,
      (SELECT count(*)::integer
       FROM selected_representations representation
       JOIN folklore.witness witness
         ON witness.resource_pk = representation.witness_resource_pk
       WHERE nullif(witness.metadata->>'reader', '') IS NULL
          OR nullif(witness.metadata->>'sourceTextId', '') IS NULL
          OR nullif(representation.metadata->>'mediaSha256', '') IS NULL
          OR (witness.metadata->>'durationSeconds')::integer <= 0)
        AS metadata_gaps,
      (SELECT count(*)::integer
       FROM selected_passages passage
       JOIN folklore.witness witness
         ON witness.resource_pk = passage.witness_resource_pk
       WHERE passage.selector->>'type' <> 'AudioTimeSelector'
          OR (passage.selector->>'startSeconds')::numeric <> 0
          OR (passage.selector->>'endSeconds')::numeric <>
            (witness.metadata->>'durationSeconds')::numeric)
        AS selector_gaps,
      (SELECT count(*)::integer
       FROM selected_representations representation
       WHERE NOT EXISTS (
         SELECT 1
         FROM folklore.capture capture
         WHERE capture.artifact_resource_pk =
           representation.artifact_resource_pk
       )) AS capture_trace_gaps,
      (SELECT count(*)::integer
       FROM rights_subjects subject
       WHERE NOT EXISTS (
         SELECT 1
         FROM folklore.rights_assessment assessment
         WHERE assessment.subject_resource_pk = subject.resource_pk
           AND assessment.review_state = 'accepted'
           AND assessment.redistribution_allowed IS TRUE
           AND assessment.ml_use_allowed IS TRUE
       )) AS rights_gaps
  `);
  const audit = result.rows[0];
  const expected = {
    sections: 27,
    first_section_id: "153266",
    last_section_id: "153292",
    representations: 27,
    passages: 27,
    witnesses: 27,
    artifacts: 31,
    total_duration_seconds: 23262,
    metadata_gaps: 0,
    selector_gaps: 0,
    capture_trace_gaps: 0,
    rights_gaps: 0,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (audit[field] !== value) {
      throw new Error(
        `LibriVox audit failed: ${field}=${audit[field]} expected ${value}`,
      );
    }
  }
  return audit;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalogueRoot = resolve(argument(
    "--catalogue-root",
    join(repositoryRoot, "build/catalogue-v0.2.0"),
  ));
  const database = new PGlite(join(catalogueRoot, "pgdata"));
  try {
    process.stdout.write(`${JSON.stringify(
      await auditLibriVox(database),
      null,
      2,
    )}\n`);
  } finally {
    await database.close();
  }
}
