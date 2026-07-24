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
}
```

`capture` handles conditional requests, retries, throttling, safe response
metadata, streaming hashing, Artifact storage, and Capture creation. An adapter
interprets archive-native structure but cannot mint public IDs or bypass raw
evidence.

```ts
type IngestItem = {
  externalKey: string;
  checkpointAfter: JsonValue;
  captures: CaptureHandle[];
  witnesses: WitnessDraft[];
  representations: RepresentationDraft[];
  passages?: PassageDraft[];
  claims?: ClaimDraft[];
};
```

The checkpoint advances only after every Artifact is durable and the entire
item transaction commits.

## Run semantics

- The canonical request hash and adapter key/version identify a compatible
  unfinished run.
- Repeating `ingest` attaches to or resumes that run.
- A completed later synchronization is a new run and creates new Captures even
  if the bytes are unchanged.
- Remote retrieval is at-least-once; committed catalogue effects are
  idempotent.
- Progress events are persisted and cursor-addressable.
- Results remain bounded; detailed changed IDs and issues are stored as
  report Artifacts rather than returned as enormous arrays.

## Invariants hidden by the module

1. Artifact bytes are content-addressed and never overwritten.
2. A Capture is one immutable retrieval observation; identical bytes may have
   several Captures.
3. Witness identity uses a collection namespace and permanent source key, not
   title, parser order, or text similarity.
4. A corrected OCR or transcript creates a new Representation and Derivation,
   not a rewritten Witness.
5. Passage identity uses a source anchor when available. Boundary changes
   create explicit split, merge, or replacement relations.
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
| Rejected item | malformed record, unsupported media, invalid selector | record bounded issue; continue by policy |
| Invariant breach | digest mismatch, ID collision, broken provenance | stop the run; never publish |
| Release conflict | reused version with another manifest | reject publication |

Use **rejected item**, not “quarantine.” Bad source records remain observable
without turning the entire corpus into a permission bureaucracy.

## Performance contract

- bytes and records stream with bounded memory and backpressure;
- capture cost is linear in retrieved bytes;
- per-item catalogue writes are transactional and batched internally;
- crash replay cannot duplicate a committed logical item;
- global duplicate discovery uses indexed blocking, never unbounded all-pairs
  comparison;
- releases reference existing Artifacts instead of copying media;
- ingestion does not wait for embeddings, graph layout, or model training.

One PostgreSQL catalogue plus a filesystem or object Artifact store is a sound
starting deployment through millions of Witnesses and tens of millions of
Passages. Scaling media storage and disposable Projections is independent of
the public interface.
