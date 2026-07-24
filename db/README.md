# Evidence catalogue

This directory contains the PostgreSQL working catalogue for the corpus. The
catalogue indexes durable resources and their relationships; it is not the
storage location for scans, recordings, release archives, or other large
Artifacts.

`migrations/0001_core.sql` establishes the first normalized model. It does not
yet include an importer or claim vocabulary. Those follow as the first vertical
slice described in [`docs/database-v1.md`](../docs/database-v1.md).

The migration deliberately uses plain PostgreSQL features and avoids extensions
so the first schema does not prematurely bind the corpus to a vector, graph, or
search implementation.
