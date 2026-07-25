# Folklore Corpus

Deterministic corpus engineering for the Folklore ecosystem.

The preserved v0.1.0 seed contains five pinned Project Gutenberg editions,
170 document/witness records and 3,291 exact passage slices. Each witness
records its raw byte span and every release artifact is content-addressed.

This seed is infrastructure, not yet the large folklore database. Its job is to
preserve source identity, provenance and reproducibility while the real
multi-source database is designed.

## Commands

```bash
npm install
npm run build:corpus
npm run db:build
npm run release:pack
npm run validate
```

The canonical release is under
`data/derived/releases/corpus-v0.1.0/`. See `docs/dataset-card-v0.1.md` and
`docs/identity-policy.md` before consuming it.

`npm run db:build` creates a persistent embedded PostgreSQL catalogue and
content-addressed Artifact store under `build/catalogue-v0.1.0/`. Re-running it
is idempotent. Pass another output location with:

```bash
npm run db:build -- --output /path/to/catalogue
```

`npm run release:pack` creates a deterministic `tar.gz` and SHA-256 sidecar
under `dist/`. Verify an archive independently with:

```bash
npm run release:verify -- --archive dist/folklore-corpus-v0.1.0.tar.gz
```

## Database direction

The future database should ingest immutable Corpus Releases rather than replace
the raw/derived release boundary. PostgreSQL can become the working catalogue
and relationship store; original captures and versioned release packages remain
file/object artifacts.

The first database and ingestion design is now recorded in:

- [`CONTEXT.md`](CONTEXT.md) — canonical domain language
- [`docs/database-v1.md`](docs/database-v1.md) — storage and relational design
- [`docs/ingestion-interface-v1.md`](docs/ingestion-interface-v1.md) — deep
  ingestion module and archive-adapter seam
- [`db/migrations/0001_core.sql`](db/migrations/0001_core.sql) — initial
  PostgreSQL schema
- [`db/migrations/0002_rights_gate.sql`](db/migrations/0002_rights_gate.sql) —
  per-resource rights evidence and fail-closed Release publication checks
- [`db/migrations/0003_multilingual_representations.sql`](db/migrations/0003_multilingual_representations.sql)
  — minimal language/script metadata and typed language Derivations
- [`db/migrations/0004_ingestion_runs.sql`](db/migrations/0004_ingestion_runs.sql)
  — durable adapter runs, checkpoints, and committed-item identities
- [`VISION.md`](VISION.md) — long-term multilingual research direction,
  deliberately outside the executable roadmap
