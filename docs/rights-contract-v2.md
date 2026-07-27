# Rights Contract v2

Rights Contract v2 is the v0.3.0 publication contract for governed Corpus
resources. It separates six decisions that v0.2 could not express
independently:

| Use case | Release field | Catalogue column |
| --- | --- | --- |
| use as evidence | `evidenceUseAllowed` | `evidence_use_allowed` |
| quotation | `quotationAllowed` | `quotation_allowed` |
| redistribution | `redistributionAllowed` | `redistribution_allowed` |
| access/private use | `accessPrivateUseAllowed` | `access_private_use_allowed` |
| ML evaluation | `mlEvaluationAllowed` | `ml_evaluation_allowed` |
| ML training | `mlTrainingAllowed` | `ml_training_allowed` |

Every decision is tri-state: `true` means allowed, `false` means prohibited,
and `null` means unknown. Unknown is not permission. The v0.3 release schema
requires every field to be present, including explicit `null` values.

`folklore.release_rights_gaps_v2(release_pk, use_case)` is the executable
gate. A resource is covered only when an accepted assessment explicitly allows
the requested use and both the assessment and its evidence Artifact are
members of the candidate Release.

## Migrating v0.2 records

Migration `0005_rights_contract_v2.sql` adds the five new catalogue columns as
nullable and leaves existing `redistribution_allowed` values unchanged. It
does not derive new permissions from `ml_use_allowed`, license labels, public
domain labels, or any other v0.2 field. Consequently every migrated v0.2
assessment begins with unknown v2 decisions and fails the corresponding v2
gate until it is reviewed again.

Project-authored Gutenberg, SKVR, and LibriVox review records have new v2
identities, dates, bytes, and pinned hashes. Their explicit decisions produce
`folklore-rights-assessment-v2` release records. Historical v0.2 releases and
their v1 rights records remain immutable.

This is an engineering publication gate, not legal advice. Jurisdiction and
the cited rights evidence remain part of each assessment.
