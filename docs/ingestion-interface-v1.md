# Corpus ingestion interface v1

## Three independent designs

### Minimal job interface

```ts
run(request: IngestRun): AsyncIterable<RunUpdate>
release(request: ReleaseRequest): Promise<ReleaseRef>
```

This maximizes depth: start, attach, resume, retry, status, checkpoints,
streaming capture, identity, and transactions all disappear behind `run`.
Its weak point is an adapter-owned untyped selection value at the public seam.

### Universal materialization engine

```ts
run(request: CaptureTarget | MaterializationTarget): AsyncIterable<RunEvent>
read(query: ReadQuery): AsyncIterable<CorpusEnvelope | ByteChunk>
```

This can express capture, OCR, parsing, annotation, releases, and projections
through one recipe mechanism. It is powerful, but risks turning the core into a
generic workflow/plugin engine whose resource model is less obvious to the
ordinary archive importer.

### Collection-first interface

```ts
ingest(adapter: CollectionAdapter, options?: IngestOptions):
  AsyncIterable<IngestEvent>
release(spec: ReleaseSpec): Promise<ReleaseRef>
```

This makes the common case concrete: adding a structured archive means writing
one async generator. It preserves a narrow public surface while keeping source
pagination, metadata interpretation, and permanent external keys inside the
adapter that understands them.

## Recommendation

Adopt the collection-first interface with the minimal job interface's durable
run semantics. Keep catalogue reading and provenance tracing in a separate
reader module so ingestion does not become a query grab bag.

```ts
interface Corpus {
  ingest(
    adapter: CollectionAdapter,
    options?: IngestOptions,
  ): AsyncIterable<IngestEvent>;

  release(spec: ReleaseSpec): Promise<ReleaseRef>;
}

interface CollectionAdapter {
  readonly key: string;
  readonly version: string;
  read(context: AdapterContext): AsyncIterable<IngestItem>;
}

interface CorpusReader {
  get(ref: CorpusRef): Promise<CorpusEnvelope | null>;
  trace(ref: CorpusRef): AsyncIterable<EvidenceEdge>;
  artifact(
    ref: ArtifactRef,
    range?: { start: number; end: number },
  ): AsyncIterable<Uint8Array>;
}
```

`Corpus` and `CorpusReader` are separate modules and test surfaces. The first
owns mutation invariants; the second supplies immutable records and traces to
Search, Graph, and ML Lab.

## Adapter context

Adapters must not perform unrecorded fetches and then hand parsed data to the
corpus. The module owns capture:

```ts
interface AdapterContext {
  checkpoint: JsonValue | null;
  signal: AbortSignal;

  capture(request: {
    sourceKey: string;
    role: string;
    request: CaptureRequest;
  }): Promise<CaptureHandle>;

  materialize(request: {
    artifactKey: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<ArtifactHandle>;

  readText(handle: CaptureHandle | ArtifactHandle): Promise<string>;
}
```

`capture` delegates retrieval policy (conditional requests, retries and
throttling) to the injected transport, then owns safe response metadata,
streaming hashing, Artifact storage, and Capture creation. An adapter interprets
archive-native structure but cannot mint public IDs or bypass raw evidence.
`materialize` is the corresponding narrow path for deterministic derived
bytes: the engine hashes and stores them, while the emitted Representation
must name its captured inputs in the Derivation. It never creates a fake
Capture for a locally derived Artifact.

```ts
type IngestItem = {
  externalKey: string;
  checkpointAfter: JsonValue;
  captures: CaptureHandle[];
  artifacts?: ArtifactHandle[];
  sourceItem: SourceItemDraft;
  witnesses: WitnessDraft[];
};

type WitnessDraft = {
  externalKey: string;
  kind: string;
  representations: Array<{
    externalKey: string;
    captureKey?: string;
    artifactKey?: string;
    kind: string;
    languageTag: string | null;
    scriptCode: string | null;
    dialect: string | null;
    derivation: DerivationDraft;
    passages: PassageDraft[];
  }>;
};
```

The checkpoint advances only after every Artifact is durable and the entire
item transaction commits.

## Executable v1 boundary

The contract is implemented in
`scripts/lib/collection-ingestion.mjs`. `ingestCollection(...)` is an async
generator that accepts one adapter, a PostgreSQL catalogue, an Artifact root,
and an engine-owned capture transport. Adapters receive only recorded Capture
handles and a read method over already stored Artifacts; they cannot perform a
hidden fetch through the public interface.

The committed fixture adapters prove two different shapes against the same
contract:

- `scripts/adapters/skvr-fixture.mjs` reads a captured TEI record and emits a
  Finnish text Witness with line selectors;
- `scripts/adapters/librivox-fixture.mjs` reads a captured catalogue, captures
  its referenced audio, and emits an English Witness with both catalogue and
  audio Representations, proving one-to-many Representation handling and time
  selectors.

These are contract fixtures, not the full acquisitions owned by issues #6 and
#7.

## LibriVox book 1837 production slice

The production audio adapter is implemented in
`scripts/adapters/librivox.mjs`. Its reviewed lock,
`data/librivox/book-1837.lock.json`, fixes book `1837`, section IDs
`153266–153292`, their source metadata, and the SHA-256 plus byte length of
every 64 kbps MP3. The lock also pins the exact LibriVox API, Internet Archive
metadata, LibriVox policy, Gutenberg 7885 rights page, and US jurisdiction
review used for release admission.

Acquire or verify the 32 source objects:

```bash
npm run source:librivox
```

Downloads use an atomic `.part` file, resume with an HTTP Range request, and
are admitted to the source cache only after both byte length and SHA-256 match
the lock. A server that ignores Range restarts the temporary file rather than
concatenating incompatible responses.

Import into a persistent catalogue and audit the result:

```bash
npm run ingest:librivox
npm run audit:librivox
```

The adapter emits one Source Item, audio Witness, source-provided MP3
Representation, and whole-section time Passage per LibriVox section. Catalogue
and media bytes remain separate Captures. Every section preserves the native
section ID, title, reader, duration, media URL/digest, Internet Archive item,
and relationship to Project Gutenberg 7885. No transcript or text/audio
alignment is asserted.

`data/librivox/rights-review-us.json` is an engineering release-gate record,
not legal advice. It keeps the recording declaration and source-text
jurisdiction decision explicit and warns users outside the United States to
perform their own review.

An `IngestItem` must provide:

- stable lowercase external keys for the item, Source Item, Witnesses,
  Representations, and Passages;
- Capture handles minted by this run's `AdapterContext`;
- materialized Artifact handles minted by this run for derived
  Representations;
- at least one Representation and source-anchored selector per Witness;
- one recorded Derivation per Representation;
- captured inputs for every derived Artifact Representation;
- captured rights evidence covering every emitted Artifact and
  Representation;
- explicit tri-state Rights Contract v2 decisions for evidence use, quotation,
  redistribution, access/private use, ML evaluation, and ML training;
- a serializable `checkpointAfter`.

Validation occurs before the item transaction. The engine, not the adapter,
mints canonical IDs, owns transaction boundaries, stores content-addressed
Artifacts, creates Captures, records rights assessments and advances the
checkpoint. It links each logical Source Item through an Edition and Document
to its Witnesses and includes that Source Item in every Representation
Derivation. Only an allowlist of non-secret response metadata is persisted.
No release primitive is present in the adapter context, and an item attempting
to include one is rejected.

Issue #6 adds the production SKVR I1 adapter. Its checked-in manifest pins
`skvr01100010` through `skvr01101000`, and its source lock pins the official
SKS190 repository commit and I1 volume digest. Because the per-record TEI
endpoint is not reproducibly reachable from clean builds, the release captures
the official volume XML, creates an exact per-record XML Representation, and
materializes deterministic Unicode plain text as a separate content-addressed
Representation. The electronic archive ID and printed citation are preserved
from captured bytes; a persistent URN is not asserted unless it appears in
captured evidence. Source XML and plain-text Representations share stable
Witness and Passage identities but never share a Representation identity.

## Run semantics

- The canonical request hash and adapter key/version identify a compatible
  unfinished run.
- Repeating `ingest` attaches to or resumes that run.
- A completed later synchronization is a new run and creates new Captures even
  if the bytes are unchanged.
- Remote retrieval is at-least-once; committed catalogue effects are
  idempotent.
- Item commits and their checkpoints are persisted; progress events are
  emitted from those commits.
- Unexpected adapter or transport failures pause the run at its last committed
  checkpoint. Contract/invariant failures mark it failed.
- Result events remain bounded to one committed item at a time.

## Invariants hidden by the module

1. Artifact bytes are content-addressed and never overwritten.
2. A Capture is one immutable retrieval observation; identical bytes may have
   several Captures.
3. Witness identity uses a collection namespace and permanent source key, not
   title, parser order, or text similarity.
4. A corrected OCR or transcript creates a new Representation and Derivation,
   not a rewritten Witness.
5. Passage identity uses a source anchor when available. The adapter seam
   rejects boundary reuse; a boundary-management workflow must publish an
   explicit split, merge, or replacement relation.
6. Claims are immutable and record method, version, asserting agent, and
   Evidence. Machine output never silently becomes reviewed fact.
7. Every released resource has a complete derivation path to captured
   Artifacts.
8. A Release is an immutable, canonically ordered manifest. Reusing its version
   with different contents is a conflict.
9. Search, graph, vectors, convenient current-value views, and ML datasets are
   rebuildable Projections.
10. Secrets and authentication headers never enter Capture metadata.

## Failure model

| Class | Examples | Result |
| --- | --- | --- |
| Invalid request | unknown adapter, incompatible configuration | fail before mutation |
| Resumable block | rate limit, authentication, archive or storage outage | persist checkpoint and pause |
| Invalid item | missing key, rights evidence, provenance, or selector | fail the run before that item commits |
| Invariant breach | digest mismatch, ID collision, broken provenance | stop the run; never publish |
| Release conflict | reused version with another manifest | reject publication |

Per-item rejection reports and continue policies are deferred until a real
archive demonstrates that fail-fast validation is too coarse.

## Performance contract

- bytes and records stream with bounded memory and backpressure;
- capture cost is linear in retrieved bytes;
- per-item catalogue writes and checkpoint advancement are transactional;
- crash replay cannot duplicate a committed logical item;
- global duplicate discovery uses indexed blocking, never unbounded all-pairs
  comparison;
- releases reference existing Artifacts instead of copying media;
- ingestion does not wait for embeddings, graph layout, or model training.

One PostgreSQL catalogue plus a filesystem or object Artifact store is a sound
starting deployment through millions of Witnesses and tens of millions of
Passages. Scaling media storage and disposable Projections is independent of
the public interface.
