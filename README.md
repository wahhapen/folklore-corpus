# Folklore Corpus

Deterministic corpus engineering for the Folklore ecosystem.

Corpus v0.2.1 retains the five-edition Project Gutenberg seed and adds 100
official-source SKVR records plus 27 LibriVox sections. The cumulative release
contains 297 Documents and 3,418 Passages with immutable source bytes,
content-addressed artifacts, multilingual Representation metadata, typed
Derivations, and fail-closed rights evidence.

v0.2.1 supersedes v0.2.0 because the earlier release serialized all 520
rights-review dates using a locale-dependent PGlite `Date` string. The patch
changes only those values to canonical `YYYY-MM-DD` dates and adds validation;
the v0.2 record contract and corpus contents are otherwise unchanged. Consumers
must re-pin the v0.2.1 archive and manifest SHA-256 values after publication.

## Commands

```bash
npm install
npm run build:corpus
npm run release:build
npm run release:pack
npm run validate
```

`npm run release:build` requires the exact clean producer commit:

```bash
FOLKLORE_PRODUCER_COMMIT=<40-character-HEAD> npm run release:build
```

`npm run validate` performs its v0.2 build in a fresh temporary directory,
binds it to the checked-out commit, validates the complete release, and removes
the temporary output. It does not depend on a previously built release tree.

It acquires and verifies the locked inputs, creates the embedded PostgreSQL
catalogue and content-addressed Artifact store under
`build/catalogue-v0.2.1/`, executes collection audits and the transactional
rights gate, then projects `build/releases/corpus-v0.2.1/` in the same database
process. Pass explicit fresh locations when proving a second clean build:

```bash
npm run release:build -- \
  --output /path/to/catalogue \
  --release-root /path/to/release
```

`npm run release:pack` creates a deterministic `tar.gz` and SHA-256 sidecar
under `dist/`. Verify an archive independently with:

```bash
npm run release:verify -- --archive dist/folklore-corpus-v0.2.1.tar.gz
```

The fixed SKVR I1 pilot is acquired and imported through the production
CollectionAdapter seam:

```bash
npm run source:skvr -- --source-root source-cache/skvr-i1
npm run db:ingest:skvr -- \
  --source-root source-cache/skvr-i1 \
  --output build/catalogue-skvr-i1
npm run audit:skvr -- --catalogue-root build/catalogue-skvr-i1
```

The acquisition command downloads the official SKS190 repository at the
checked-in commit and verifies the locked byte length and SHA-256 for the I1
volume and license statement. The importer selects the checked-in 100-ID
manifest from those real volume bytes, stores an exact per-record XML
extraction plus a deterministic plain-text Representation, and records the
upstream commit, volume digest, archive identifiers, line selectors, CC BY 4.0
assessment and attribution. An interrupted run resumes after its last
committed electronic ID.
LibriVox uses the same seam for 27 locked recording sections. Audio is
represented with whole-section time selectors and metadata-only searchable
text; v0.2 makes no transcript or semantic audio-retrieval claim.

## Database direction

The database ingests immutable Corpus Releases rather than replacing
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
