BEGIN;

CREATE TYPE folklore.rights_use_case AS ENUM (
    'evidence-use',
    'quotation',
    'redistribution',
    'access-private-use',
    'ml-evaluation',
    'ml-training'
);

ALTER TABLE folklore.rights_assessment
    ADD COLUMN evidence_use_allowed boolean,
    ADD COLUMN quotation_allowed boolean,
    ADD COLUMN access_private_use_allowed boolean,
    ADD COLUMN ml_evaluation_allowed boolean,
    ADD COLUMN ml_training_allowed boolean;

CREATE FUNCTION folklore.release_rights_gaps_v2(
    target_release_resource_pk bigint,
    required_use folklore.rights_use_case
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
            AND CASE required_use
                WHEN 'evidence-use' THEN
                    assessment.evidence_use_allowed IS TRUE
                WHEN 'quotation' THEN
                    assessment.quotation_allowed IS TRUE
                WHEN 'redistribution' THEN
                    assessment.redistribution_allowed IS TRUE
                WHEN 'access-private-use' THEN
                    assessment.access_private_use_allowed IS TRUE
                WHEN 'ml-evaluation' THEN
                    assessment.ml_evaluation_allowed IS TRUE
                WHEN 'ml-training' THEN
                    assessment.ml_training_allowed IS TRUE
                ELSE false
            END
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
      )
    ORDER BY resource.canonical_id
$$;

COMMENT ON COLUMN folklore.rights_assessment.evidence_use_allowed IS
    'Rights Contract v2 tri-state permission: TRUE allowed, FALSE prohibited, NULL unknown.';
COMMENT ON COLUMN folklore.rights_assessment.quotation_allowed IS
    'Rights Contract v2 tri-state permission: TRUE allowed, FALSE prohibited, NULL unknown.';
COMMENT ON COLUMN folklore.rights_assessment.access_private_use_allowed IS
    'Rights Contract v2 tri-state permission: TRUE allowed, FALSE prohibited, NULL unknown.';
COMMENT ON COLUMN folklore.rights_assessment.ml_evaluation_allowed IS
    'Rights Contract v2 tri-state permission: TRUE allowed, FALSE prohibited, NULL unknown.';
COMMENT ON COLUMN folklore.rights_assessment.ml_training_allowed IS
    'Rights Contract v2 tri-state permission: TRUE allowed, FALSE prohibited, NULL unknown.';

COMMIT;
