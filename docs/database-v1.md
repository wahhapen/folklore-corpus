# Folklore evidence database v1

## Decision in one sentence

Build a database that can become huge, not a huge database deployment on day
one: content-addressed Artifacts plus a PostgreSQL evidence catalogue, with
search, graph, vector, and ML Projections derived from immutable Releases.

## What “huge” means

The scale comes from source coverage and representations:

- millions of source items, witnesses, and passages;
- scans, books, photographs, audio, video, OCR, transcripts, and translations;
- multiple editions and tellings of related material;
- claims about motifs, people, places, languages, dates, collectors, and
  cultural contexts;
- exact derivation histories and multiple competing scholarly interpretations;
- several search indexes, embeddings, graph views, and training-set versions.

Most bytes will be scans and recordings. They do not belong in PostgreSQL.
Most rows will be passages, selectors, relationships, and claims. They do.

## Storage layers

```text
Archives
   │
   ▼
content-addressed Artifact store ── exact captured and derived bytes
   │
   ▼
PostgreSQL evidence catalogue ───── identity, metadata, coordinates, claims
   │
   ├──► search Projection
   ├──► graph Projection
   ├──► embedding Projection
   └──► versioned ML Release
```

The Artifact store may begin as ordinary files. Its interface is digest-based,
so it can later move to S3-compatible object storage without changing corpus
identity.

## Core relational model

Every durable object receives an internal numeric key for compact joins and a
globally unique canonical ID for interchange.

### Identity and source evidence

| Table | Purpose |
| --- | --- |
| `resource` | Registry of canonical IDs and resource kinds |
| `archive` | Institution or repository identity |
| `source_item` | Archive-native item ID, landing page, and native metadata |
| `artifact` | Digest, media type, byte length, and storage location |
| `capture` | Immutable retrieval event connecting a Source Item to an Artifact |
| `edition` | Publication, collection, editor, translator, and issue context |
| `document` | Source-defined subdivision of an Edition |
| `witness` | Stable identity of an attested source instance |
| `representation` | Immutable scan, OCR text, transcript, or translation of a Witness |
| `passage` | Stable source-anchored citable part of a Witness |
| `passage_representation` | Exact text/page/image/time selector in one Representation |

### Interpretation and history

| Table | Purpose |
| --- | --- |
| `derivation` | Method, version, parameters, environment, and run identity |
| `derivation_input` | Ordered immutable inputs |
| `derivation_output` | Ordered immutable outputs |
| `translation` | Source-to-translation Representation link, producer class, and independent review status |
| `claim` | Attributed, versioned assertion with predicate and confidence |
| `claim_object` | Resource target or typed literal value |
| `claim_evidence` | Supporting or contradicting resources and selectors |
| `claim_relation` | Supersedes, retracts, agrees-with, or disputes another Claim |
| `alias` | Replaced, merged, or split identities without silent ID reuse |
| `ingest_run` | Adapter identity, request hash, durable checkpoint, and lifecycle |
| `ingest_item_commit` | Idempotent external item commit within one run |

Representations carry a BCP 47 `language_tag`, an optional ISO 15924
`script_code`, and an optional source-described `dialect`. Passages may
override the language tag when a citable section differs from its
Representation. Derivations may identify the four language transformations
that must remain explicit: translation, transliteration, normalization, and
transcription. Other provenance operations leave that type null.

### Publication

| Table | Purpose |
| --- | --- |
| `release` | Version, manifest digest, creation method, and parent Release |
| `release_member` | Resource membership and role |
| `split_assignment` | Leakage-aware train, validation, and test grouping |

## Claim model

Interpretations must not overwrite source evidence. “This witness contains
motif ATU 510A,” “this place name refers to this coordinate,” and “these two
witnesses belong to one Story Family” are Claims, not columns pretending to be
settled facts.

A Claim records:

- subject resource;
- controlled predicate;
- resource target or typed literal;
- who or what asserted it;
- method and method version;
- confidence and review state;
- supporting or contradicting Evidence;
- creation time and any Claim it supersedes.

This lets imported archive metadata, human scholarship, deterministic
classifiers, and model suggestions coexist without becoming indistinguishable.

## Coordinates and citation

A Passage is a citation address, not merely a fixed-size search chunk. A
Passage stays source-anchored while each Representation supplies selectors
using one or more coordinate systems:

- Unicode character offsets in normalized text;
- byte offsets in a captured Artifact;
- page and bounding box in a scan;
- start and end time in audio or video;
- XML/TEI path or archive-native selector.

Search systems may create smaller retrieval windows, but answers cite Passages
and can trace them back through Derivations to captured bytes.

## Stable identity

- Captures and Artifacts are content-derived and immutable.
- Source Items retain the Archive's namespace and native identifier.
- Editions, Documents, and Witnesses receive mint-once canonical IDs.
- Corrected metadata creates a new Claim or Derivation; it does not silently
  repurpose an ID.
- Boundary changes publish explicit replacement, split, or merge aliases.
- Story Families are curated interpretations, never inferred identity.

## Scale path

### Pilot

One PostgreSQL instance and a local content-addressed Artifact directory are
enough. Import a few heterogeneous collections and prove citation, reruns, and
release reproducibility.

### Large corpus

Move Artifacts to object storage, partition the largest append-only tables when
measurements justify it, and add asynchronous ingestion workers. PostgreSQL
remains the catalogue.

### Very large media archive

Replicate object storage and separate hot from cold Artifacts. Scale search and
embedding Projections independently. The evidence model and canonical IDs stay
unchanged.

## Deliberate non-decisions

Version 1 does not require:

- a graph database: evidence-backed edges fit the relational Claim model;
- a dedicated vector database: embeddings are a replaceable Projection;
- one global folklore ontology: controlled predicates can grow by namespace;
- automatic Story Family merging;
- storing media bytes inside PostgreSQL;
- microservices, queues, or distributed databases.

Each can be introduced after a measured workload proves that the simpler
design is insufficient.

## First implementation slice

The first useful database milestone is not “load every tale.” It is:

1. define the core migration and content-addressed Artifact interface;
2. import the existing v0.1 Release without losing any identity or digest;
3. add two structurally different archive adapters;
4. prove idempotent re-import and exact citation back to captured bytes;
5. publish a v0.2 Release from database selection;
6. rebuild Search and one ML task from that Release.

That vertical slice tests the foundation shared by the entire ecosystem.
