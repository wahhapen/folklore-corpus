BEGIN;

CREATE TYPE folklore.translation_producer_class AS ENUM (
    'source-published',
    'expert-produced',
    'user-produced',
    'machine-generated'
);

CREATE TYPE folklore.translation_review_status AS ENUM (
    'unreviewed',
    'accepted',
    'rejected',
    'superseded'
);

CREATE TABLE folklore.translation (
    translation_representation_resource_pk bigint PRIMARY KEY
        REFERENCES folklore.representation (resource_pk),
    source_representation_resource_pk bigint NOT NULL
        REFERENCES folklore.representation (resource_pk),
    producer_class folklore.translation_producer_class NOT NULL,
    review_status folklore.translation_review_status NOT NULL,
    reviewed_by_resource_pk bigint
        REFERENCES folklore.resource (resource_pk),
    review_evidence_artifact_resource_pk bigint
        REFERENCES folklore.artifact (resource_pk),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT translation_preserves_distinct_source
        CHECK (
            translation_representation_resource_pk
                <> source_representation_resource_pk
        ),
    CONSTRAINT translation_review_provenance_matches_status
        CHECK (
            (
                review_status = 'unreviewed'
                AND reviewed_by_resource_pk IS NULL
                AND review_evidence_artifact_resource_pk IS NULL
            )
            OR (
                review_status <> 'unreviewed'
                AND reviewed_by_resource_pk IS NOT NULL
                AND review_evidence_artifact_resource_pk IS NOT NULL
            )
        )
);

CREATE INDEX translation_source_representation_idx
    ON folklore.translation (source_representation_resource_pk);

COMMENT ON TABLE folklore.translation IS
    'A provenance-bearing relation from an immutable source Representation to a distinct translated Representation.';
COMMENT ON COLUMN folklore.translation.producer_class IS
    'Who produced the translation; never implies its review status.';
COMMENT ON COLUMN folklore.translation.review_status IS
    'Explicit review status. Unreviewed output is fail-visible for language-sensitive use.';

COMMIT;
