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
npm run validate
```

The canonical release is under
`data/derived/releases/corpus-v0.1.0/`. See `docs/dataset-card-v0.1.md` and
`docs/identity-policy.md` before consuming it.

## Database direction

The future database should ingest immutable Corpus Releases rather than replace
the raw/derived release boundary. PostgreSQL can become the working catalogue
and relationship store; original captures and versioned release packages remain
file/object artifacts.
