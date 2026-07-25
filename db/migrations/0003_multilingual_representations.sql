BEGIN;

ALTER TABLE folklore.representation
    ADD COLUMN script_code text,
    ADD COLUMN dialect text,
    ADD CONSTRAINT representation_language_tag_bcp47_shape
        CHECK (
            language_tag IS NULL
            OR language_tag ~
                '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'
        ),
    ADD CONSTRAINT representation_script_code_iso15924
        CHECK (
            script_code IS NULL
            OR script_code ~ '^[A-Z][a-z]{3}$'
        );

ALTER TABLE folklore.passage
    ADD COLUMN language_tag text,
    ADD CONSTRAINT passage_language_tag_bcp47_shape
        CHECK (
            language_tag IS NULL
            OR language_tag ~
                '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'
        );

ALTER TABLE folklore.derivation
    ADD COLUMN derivation_type text,
    ADD CONSTRAINT derivation_type_supported
        CHECK (
            derivation_type IS NULL
            OR derivation_type IN (
                'translation',
                'transliteration',
                'normalization',
                'transcription'
            )
        );

COMMENT ON COLUMN folklore.representation.language_tag IS
    'BCP 47 language tag for this immutable representation.';
COMMENT ON COLUMN folklore.representation.script_code IS
    'ISO 15924 script code when it is known and useful.';
COMMENT ON COLUMN folklore.representation.dialect IS
    'Source-described dialect or language variety; intentionally not an ontology.';
COMMENT ON COLUMN folklore.passage.language_tag IS
    'Optional BCP 47 override when a passage differs from its representation.';
COMMENT ON COLUMN folklore.derivation.derivation_type IS
    'Typed language transformation; NULL for other provenance operations.';

COMMIT;
