# Evidence catalogue

This directory contains the PostgreSQL working catalogue for the corpus. The
catalogue indexes durable resources and their relationships; it is not the
storage location for scans, recordings, release archives, or other large
Artifacts.

`migrations/0001_core.sql` establishes the first normalized model.
`scripts/build-catalogue.mjs` imports the pinned v0.1 Release into a persistent
embedded PostgreSQL catalogue, materializes normalized Witness
Representations, and stores captured and derived bytes by SHA-256.

```bash
npm run db:build
```

The migration deliberately uses plain PostgreSQL features and avoids extensions
so the first schema does not prematurely bind the corpus to a vector, graph, or
search implementation.
