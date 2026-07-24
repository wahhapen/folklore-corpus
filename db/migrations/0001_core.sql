BEGIN;

CREATE SCHEMA IF NOT EXISTS folklore;

CREATE TABLE folklore.resource (
    resource_pk bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_id text NOT NULL UNIQUE,
    resource_kind text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT resource_canonical_id_format
        CHECK (canonical_id ~ '^fa:[a-z][a-z0-9-]*:')
);

CREATE INDEX resource_kind_idx
    ON folklore.resource (resource_kind, resource_pk);

CREATE TABLE folklore.archive (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    name text NOT NULL,
    homepage_uri text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE folklore.source_item (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    archive_resource_pk bigint NOT NULL
        REFERENCES folklore.archive (resource_pk),
    native_id text NOT NULL,
    landing_uri text,
    native_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (archive_resource_pk, native_id)
);

CREATE TABLE folklore.artifact (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    digest_algorithm text NOT NULL DEFAULT 'sha256',
    digest bytea NOT NULL,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    media_type text,
    storage_key text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (digest_algorithm, digest),
    CONSTRAINT artifact_sha256_length
        CHECK (digest_algorithm <> 'sha256' OR octet_length(digest) = 32)
);

CREATE TABLE folklore.capture (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    source_item_resource_pk bigint NOT NULL
        REFERENCES folklore.source_item (resource_pk),
    artifact_resource_pk bigint NOT NULL
        REFERENCES folklore.artifact (resource_pk),
    captured_at timestamptz NOT NULL,
    retrieval_uri text,
    request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX capture_source_item_idx
    ON folklore.capture (source_item_resource_pk, captured_at);

CREATE INDEX capture_artifact_idx
    ON folklore.capture (artifact_resource_pk);

CREATE TABLE folklore.edition (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    source_item_resource_pk bigint
        REFERENCES folklore.source_item (resource_pk),
    title text NOT NULL,
    language_tag text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE folklore.document (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    edition_resource_pk bigint
        REFERENCES folklore.edition (resource_pk),
    source_ordinal integer,
    title text,
    language_tag text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (edition_resource_pk, source_ordinal)
);

CREATE TABLE folklore.witness (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    document_resource_pk bigint
        REFERENCES folklore.document (resource_pk),
    witness_kind text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX witness_document_idx
    ON folklore.witness (document_resource_pk);

CREATE TABLE folklore.representation (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    witness_resource_pk bigint NOT NULL
        REFERENCES folklore.witness (resource_pk),
    artifact_resource_pk bigint NOT NULL
        REFERENCES folklore.artifact (resource_pk),
    representation_kind text NOT NULL,
    language_tag text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX representation_witness_idx
    ON folklore.representation (witness_resource_pk);

CREATE INDEX representation_artifact_idx
    ON folklore.representation (artifact_resource_pk);

CREATE TABLE folklore.passage (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    witness_resource_pk bigint NOT NULL
        REFERENCES folklore.witness (resource_pk),
    ordinal integer NOT NULL CHECK (ordinal > 0),
    source_anchor text,
    citation_label text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (witness_resource_pk, ordinal),
    UNIQUE (witness_resource_pk, source_anchor)
);

CREATE INDEX passage_witness_idx
    ON folklore.passage (witness_resource_pk, ordinal);

CREATE TABLE folklore.passage_representation (
    passage_resource_pk bigint NOT NULL
        REFERENCES folklore.passage (resource_pk),
    representation_resource_pk bigint NOT NULL
        REFERENCES folklore.representation (resource_pk),
    selector jsonb NOT NULL,
    quoted_text text,
    slice_digest bytea,
    PRIMARY KEY (passage_resource_pk, representation_resource_pk),
    CONSTRAINT passage_slice_sha256_length
        CHECK (slice_digest IS NULL OR octet_length(slice_digest) = 32)
);

CREATE INDEX passage_representation_lookup_idx
    ON folklore.passage_representation (representation_resource_pk);

CREATE TABLE folklore.derivation (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    method text NOT NULL,
    method_version text NOT NULL,
    method_digest bytea,
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
    runtime jsonb NOT NULL DEFAULT '{}'::jsonb,
    deterministic boolean NOT NULL,
    completed_at timestamptz NOT NULL,
    CONSTRAINT derivation_method_digest_length
        CHECK (method_digest IS NULL OR octet_length(method_digest) = 32)
);

CREATE TABLE folklore.derivation_input (
    derivation_resource_pk bigint NOT NULL
        REFERENCES folklore.derivation (resource_pk),
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    input_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    role text,
    PRIMARY KEY (derivation_resource_pk, ordinal)
);

CREATE INDEX derivation_input_resource_idx
    ON folklore.derivation_input (input_resource_pk);

CREATE TABLE folklore.derivation_output (
    derivation_resource_pk bigint NOT NULL
        REFERENCES folklore.derivation (resource_pk),
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    output_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    role text,
    PRIMARY KEY (derivation_resource_pk, ordinal),
    UNIQUE (derivation_resource_pk, output_resource_pk)
);

CREATE INDEX derivation_output_resource_idx
    ON folklore.derivation_output (output_resource_pk);

CREATE TABLE folklore.claim (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    subject_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    predicate text NOT NULL,
    asserted_by_resource_pk bigint
        REFERENCES folklore.resource (resource_pk),
    method text NOT NULL,
    method_version text,
    confidence numeric(4, 3)
        CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    review_state text NOT NULL DEFAULT 'unreviewed'
        CHECK (review_state IN (
            'unreviewed',
            'accepted',
            'rejected',
            'disputed',
            'superseded'
        )),
    created_at timestamptz NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX claim_subject_predicate_idx
    ON folklore.claim (subject_resource_pk, predicate);

CREATE INDEX claim_review_state_idx
    ON folklore.claim (review_state, predicate);

CREATE TABLE folklore.claim_object (
    claim_resource_pk bigint PRIMARY KEY
        REFERENCES folklore.claim (resource_pk),
    object_resource_pk bigint
        REFERENCES folklore.resource (resource_pk),
    literal_value jsonb,
    CONSTRAINT claim_object_exactly_one_value
        CHECK (
            (object_resource_pk IS NOT NULL AND literal_value IS NULL)
            OR
            (object_resource_pk IS NULL AND literal_value IS NOT NULL)
        )
);

CREATE INDEX claim_object_resource_idx
    ON folklore.claim_object (object_resource_pk)
    WHERE object_resource_pk IS NOT NULL;

CREATE TABLE folklore.claim_evidence (
    claim_resource_pk bigint NOT NULL
        REFERENCES folklore.claim (resource_pk),
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    evidence_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    stance text NOT NULL DEFAULT 'supports'
        CHECK (stance IN ('supports', 'contradicts', 'context')),
    selector jsonb,
    PRIMARY KEY (claim_resource_pk, ordinal)
);

CREATE INDEX claim_evidence_resource_idx
    ON folklore.claim_evidence (evidence_resource_pk);

CREATE TABLE folklore.claim_relation (
    claim_resource_pk bigint NOT NULL
        REFERENCES folklore.claim (resource_pk),
    related_claim_resource_pk bigint NOT NULL
        REFERENCES folklore.claim (resource_pk),
    relation text NOT NULL
        CHECK (relation IN ('supersedes', 'retracts', 'agrees-with', 'disputes')),
    PRIMARY KEY (claim_resource_pk, related_claim_resource_pk, relation),
    CHECK (claim_resource_pk <> related_claim_resource_pk)
);

CREATE TABLE folklore.alias (
    alias_id text PRIMARY KEY,
    target_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    relation text NOT NULL
        CHECK (relation IN ('alias', 'replaced-by', 'merged-into', 'split-into')),
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE TABLE folklore.release (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    version text NOT NULL UNIQUE,
    manifest_artifact_resource_pk bigint NOT NULL
        REFERENCES folklore.artifact (resource_pk),
    parent_release_resource_pk bigint
        REFERENCES folklore.release (resource_pk),
    published_at timestamptz NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE folklore.release_member (
    release_resource_pk bigint NOT NULL
        REFERENCES folklore.release (resource_pk),
    member_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    member_role text NOT NULL,
    ordinal bigint,
    PRIMARY KEY (release_resource_pk, member_resource_pk, member_role),
    UNIQUE (release_resource_pk, member_role, ordinal)
);

CREATE INDEX release_member_resource_idx
    ON folklore.release_member (member_resource_pk);

CREATE TABLE folklore.split_assignment (
    release_resource_pk bigint NOT NULL
        REFERENCES folklore.release (resource_pk),
    member_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    group_id text NOT NULL,
    split text NOT NULL
        CHECK (split IN ('train', 'validation', 'test')),
    PRIMARY KEY (release_resource_pk, member_resource_pk)
);

CREATE INDEX split_assignment_group_idx
    ON folklore.split_assignment (release_resource_pk, group_id, split);

COMMIT;
