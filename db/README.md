# Evidence catalogue

This directory contains the PostgreSQL working catalogue for the corpus. The
catalogue indexes durable resources and their relationships; it is not the
storage location for scans, recordings, release archives, or other large
Artifacts.

`migrations/0001_core.sql` establishes the first normalized model.
`migrations/0002_rights_gate.sql` adds immutable per-resource rights
assessments and the fail-closed Release query used before redistribution or ML
publication.
`migrations/0003_multilingual_representations.sql` adds optional ISO 15924
script and dialect metadata to Representations, passage-level BCP 47 overrides,
and typed translation/transliteration/normalization/transcription Derivations.
`migrations/0004_ingestion_runs.sql` records resumable CollectionAdapter runs,
their durable checkpoints, and committed external item keys.
`migrations/0005_rights_contract_v2.sql` adds independent tri-state decisions
for evidence use, quotation, redistribution, access/private use, ML
evaluation, and ML training, plus a use-specific fail-closed Release gate.
`scripts/build-catalogue.mjs` imports the pinned v0.1 Release into a persistent
embedded PostgreSQL catalogue, materializes normalized Witness
Representations, and stores captured and derived bytes by SHA-256.

```bash
npm run db:build
```

The migration deliberately uses plain PostgreSQL features and avoids extensions
so the first schema does not prematurely bind the corpus to a vector, graph, or
search implementation.
