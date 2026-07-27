import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function auditSkvr(database) {
  const result = await database.query(`
    WITH selected_items AS (
      SELECT source_item.*
      FROM folklore.source_item source_item
      JOIN folklore.archive archive
        ON archive.resource_pk = source_item.archive_resource_pk
      JOIN folklore.resource archive_resource
        ON archive_resource.resource_pk = archive.resource_pk
      WHERE archive_resource.canonical_id = 'fa:archive:skvr'
        AND source_item.native_id ~ '^skvr011[0-9]{5}$'
    ),
    selected_representations AS (
      SELECT representation.*
      FROM selected_items source_item
      JOIN folklore.edition edition
        ON edition.source_item_resource_pk = source_item.resource_pk
      JOIN folklore.document document
        ON document.edition_resource_pk = edition.resource_pk
      JOIN folklore.witness witness
        ON witness.document_resource_pk = document.resource_pk
      JOIN folklore.representation representation
        ON representation.witness_resource_pk = witness.resource_pk
    ),
    selected_passages AS (
      SELECT
        passage.resource_pk,
        passage_representation.representation_resource_pk,
        passage_representation.selector
      FROM folklore.passage passage
      JOIN folklore.passage_representation passage_representation
        ON passage_representation.passage_resource_pk = passage.resource_pk
      JOIN selected_representations representation
        ON representation.resource_pk =
          passage_representation.representation_resource_pk
    ),
    rights_subjects AS (
      SELECT resource_pk FROM selected_representations
      UNION
      SELECT artifact_resource_pk FROM selected_representations
      UNION
      SELECT capture.artifact_resource_pk
      FROM folklore.capture capture
      JOIN folklore.resource resource
        ON resource.resource_pk = capture.resource_pk
      WHERE resource.canonical_id LIKE 'fa:capture:skvr:%:skvr-i1-volume:%'
         OR resource.canonical_id LIKE
           'fa:capture:skvr:%:skvr-i1-rights-review:%'
    )
    SELECT
      (SELECT count(*)::integer FROM selected_items) AS poems,
      (SELECT min(native_id) FROM selected_items) AS first_electronic_id,
      (SELECT max(native_id) FROM selected_items) AS last_electronic_id,
      (SELECT count(DISTINCT witness_resource_pk)::integer
       FROM selected_representations) AS witnesses,
      (SELECT count(*)::integer
       FROM selected_representations) AS representations,
      (SELECT count(DISTINCT resource_pk)::integer
       FROM folklore.passage
       WHERE resource_pk IN (
         SELECT passage.resource_pk FROM selected_passages passage
       )) AS passages,
      (SELECT count(*)::integer
       FROM selected_items
       WHERE nullif(native_metadata->>'archiveRecordId', '') IS NULL
          OR nullif(native_metadata->>'printedCitation', '') IS NULL
          OR native_metadata->>'sourceCommit' <>
             '2cfd7db101e79eb1446d0d2dbb108af1e8b2a18a')
        AS metadata_gaps,
      (SELECT count(*)::integer
       FROM selected_passages
       WHERE selector->>'type' <> 'LineSelector'
          OR (selector->>'startLine')::integer <> 1
          OR (selector->>'endLine')::integer < 1)
        AS selector_gaps,
      (SELECT count(*)::integer
       FROM selected_representations
       WHERE language_tag <> 'krl' OR script_code <> 'Latn')
        AS language_gaps,
      (SELECT count(*)::integer
       FROM rights_subjects subject
       WHERE NOT EXISTS (
         SELECT 1
         FROM folklore.rights_assessment assessment
         WHERE assessment.subject_resource_pk = subject.resource_pk
           AND assessment.review_state = 'accepted'
           AND assessment.statement_uri =
             'https://creativecommons.org/licenses/by/4.0/'
           AND assessment.evidence_use_allowed IS TRUE
           AND assessment.quotation_allowed IS TRUE
           AND assessment.redistribution_allowed IS TRUE
           AND assessment.access_private_use_allowed IS TRUE
           AND assessment.ml_evaluation_allowed IS TRUE
           AND assessment.ml_training_allowed IS TRUE
       )) AS rights_gaps
  `);
  const audit = result.rows[0];
  const expected = {
    poems: 100,
    first_electronic_id: "skvr01100010",
    last_electronic_id: "skvr01101000",
    witnesses: 100,
    representations: 200,
    passages: 100,
    metadata_gaps: 0,
    selector_gaps: 0,
    language_gaps: 0,
    rights_gaps: 0,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (audit[field] !== value) {
      throw new Error(
        `SKVR audit failed: ${field}=${audit[field]} expected ${value}`,
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
    join(repositoryRoot, "build/catalogue-v0.3.0"),
  ));
  const database = new PGlite(join(catalogueRoot, "pgdata"));
  try {
    process.stdout.write(`${JSON.stringify(
      await auditSkvr(database),
      null,
      2,
    )}\n`);
  } finally {
    await database.close();
  }
}
