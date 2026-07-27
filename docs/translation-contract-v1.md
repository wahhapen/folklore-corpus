# Translation provenance and review contract

Corpus v0.3 represents a translation as a relationship between two immutable
Representations. The translated Representation and its source-language
Representation must both remain accessible in the same release. A translation
record is not created merely because a historical edition describes itself as
a translation; without the corresponding source Representation, that claim
would be an orphan.

## Producer class

Every translation has exactly one explicit producer class:

- `source-published`
- `expert-produced`
- `user-produced`
- `machine-generated`

Producer class describes origin only. It never implies review status.

## Review status

Every translation independently declares one of:

- `unreviewed`
- `accepted`
- `rejected`
- `superseded`

An unreviewed record has no reviewer or review-evidence reference. Every other
status requires both. This prevents a reviewed label without review
provenance, and prevents producer type from silently standing in for review.

Only `accepted` translations may support language-sensitive claims.
Unreviewed machine translations remain usable as visibly labeled working
material, but consumers must treat them as blocked for language-sensitive
evidence. Rejected and superseded translations are blocked as well.

## Release representation

`translations.jsonl` carries `folklore-translation-v1` records. Each record
links `translationRepresentationId` to `sourceRepresentationId`, names its
producer class and review status, and includes review provenance when
applicable. A matching `translation` Derivation must include the source as an
input and the translated Representation as an output.

The independent release validator recomputes these closure rules from
`representations.jsonl`, `derivations.jsonl`, the artifact manifest, and
`translations.jsonl`. The gate report publishes the total number of
translations, the number of unreviewed machine translations, and the number
blocked for language-sensitive use.
