# Keep evidence in a catalogue and make specialized indexes rebuildable

The corpus will use PostgreSQL as its working evidence catalogue, while large
immutable Artifacts remain in content-addressed file or object storage. Search
indexes, vector stores, graph views, and training datasets are Projections
rebuilt from pinned Releases rather than competing sources of truth. This
separates durable evidence and provenance from replaceable retrieval and ML
technology, and prevents scans, audio, embeddings, and graph experiments from
forcing one database engine to do incompatible jobs.
