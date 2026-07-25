BEGIN;

CREATE TABLE folklore.ingest_run (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    adapter_key text NOT NULL,
    adapter_version text NOT NULL,
    request_hash bytea NOT NULL,
    status text NOT NULL
        CHECK (status IN ('running', 'paused', 'failed', 'completed')),
    checkpoint jsonb,
    started_at timestamptz NOT NULL DEFAULT current_timestamp,
    updated_at timestamptz NOT NULL DEFAULT current_timestamp,
    completed_at timestamptz,
    error jsonb,
    CONSTRAINT ingest_run_request_hash_sha256
        CHECK (octet_length(request_hash) = 32)
);

CREATE UNIQUE INDEX ingest_run_active_request_idx
    ON folklore.ingest_run (adapter_key, adapter_version, request_hash)
    WHERE status IN ('running', 'paused');

CREATE TABLE folklore.ingest_item_commit (
    run_resource_pk bigint NOT NULL
        REFERENCES folklore.ingest_run (resource_pk),
    external_key text NOT NULL,
    item_digest bytea NOT NULL,
    checkpoint_after jsonb NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT current_timestamp,
    PRIMARY KEY (run_resource_pk, external_key),
    CONSTRAINT ingest_item_digest_sha256
        CHECK (octet_length(item_digest) = 32)
);

COMMIT;
