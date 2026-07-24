BEGIN;

CREATE TABLE folklore.rights_assessment (
    resource_pk bigint PRIMARY KEY
        REFERENCES folklore.resource (resource_pk),
    subject_resource_pk bigint NOT NULL
        REFERENCES folklore.resource (resource_pk),
    statement_uri text,
    controlled_status text,
    rights_source text NOT NULL,
    attribution_text text NOT NULL,
    commercial_use_allowed boolean,
    derivatives_allowed boolean,
    redistribution_allowed boolean,
    ml_use_allowed boolean,
    jurisdiction text NOT NULL,
    reviewed_on date NOT NULL,
    evidence_artifact_resource_pk bigint NOT NULL
        REFERENCES folklore.artifact (resource_pk),
    review_state text NOT NULL
        CHECK (review_state IN (
            'unreviewed',
            'accepted',
            'rejected',
            'superseded'
        )),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT rights_assessment_controlled_status
        CHECK (
            controlled_status IS NULL
            OR controlled_status IN (
                'copyrighted',
                'public-domain',
                'licensed',
                'permission',
                'unknown'
            )
        ),
    CONSTRAINT rights_assessment_has_statement
        CHECK (
            nullif(statement_uri, '') IS NOT NULL
            OR nullif(controlled_status, '') IS NOT NULL
        )
);

CREATE INDEX rights_assessment_subject_idx
    ON folklore.rights_assessment (
        subject_resource_pk,
        review_state,
        reviewed_on DESC
    );

CREATE INDEX rights_assessment_evidence_idx
    ON folklore.rights_assessment (evidence_artifact_resource_pk);

CREATE FUNCTION folklore.release_rights_gaps(
    target_release_resource_pk bigint,
    require_ml_use boolean DEFAULT false
)
RETURNS TABLE (
    resource_pk bigint,
    canonical_id text,
    resource_kind text
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        member.member_resource_pk,
        resource.canonical_id,
        resource.resource_kind
    FROM folklore.release_member member
    JOIN folklore.resource resource
      ON resource.resource_pk = member.member_resource_pk
    WHERE member.release_resource_pk = target_release_resource_pk
      AND resource.resource_kind IN ('artifact', 'representation')
      AND NOT EXISTS (
          SELECT 1
          FROM folklore.rights_assessment assessment
          WHERE assessment.subject_resource_pk = member.member_resource_pk
            AND assessment.review_state = 'accepted'
            AND assessment.redistribution_allowed IS TRUE
            AND EXISTS (
                SELECT 1
                FROM folklore.release_member assessment_member
                WHERE assessment_member.release_resource_pk =
                    target_release_resource_pk
                  AND assessment_member.member_resource_pk =
                    assessment.resource_pk
            )
            AND EXISTS (
                SELECT 1
                FROM folklore.release_member evidence_member
                WHERE evidence_member.release_resource_pk =
                    target_release_resource_pk
                  AND evidence_member.member_resource_pk =
                    assessment.evidence_artifact_resource_pk
            )
            AND (
                NOT require_ml_use
                OR assessment.ml_use_allowed IS TRUE
            )
      )
    ORDER BY resource.canonical_id
$$;

COMMIT;
