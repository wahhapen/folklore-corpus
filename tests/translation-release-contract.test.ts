import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  findTranslationContractGaps,
  supportsLanguageSensitiveUse,
} from "../scripts/lib/translation-contract-v1.mjs";

const schema = JSON.parse(
  readFileSync("schemas/corpus-release-v3.schema.json", "utf8"),
);
const previousSchema = JSON.parse(
  readFileSync("schemas/corpus-release-v2.schema.json", "utf8"),
);
const validate = new Ajv2020({ strict: false })
  .addSchema(previousSchema)
  .compile(schema);

const acceptedTranslation = {
  schemaVersion: "folklore-translation-v1",
  id: "fa:translation:test",
  translationRepresentationId: "fa:representation:translation",
  sourceRepresentationId: "fa:representation:source",
  producerClass: "expert-produced",
  reviewStatus: "accepted",
  reviewedById: "fa:agent:reviewer",
  reviewEvidenceArtifactId: "fa:artifact:review",
};

describe("translation release contract", () => {
  it("enumerates producer origin and keeps review status independent", () => {
    for (const producerClass of [
      "source-published",
      "expert-produced",
      "user-produced",
      "machine-generated",
    ]) {
      expect(validate({
        ...acceptedTranslation,
        producerClass,
      }), producerClass).toBe(true);
    }

    expect(validate({
      ...acceptedTranslation,
      producerClass: "machine-generated",
      reviewStatus: "unreviewed",
      reviewedById: null,
      reviewEvidenceArtifactId: null,
    })).toBe(true);
  });

  it("rejects invalid review provenance combinations", () => {
    expect(validate({
      ...acceptedTranslation,
      reviewedById: null,
    })).toBe(false);
    expect(validate({
      ...acceptedTranslation,
      reviewStatus: "unreviewed",
    })).toBe(false);
  });

  it("rejects orphaned links and derivations that do not preserve originals", () => {
    const release = {
      translations: [acceptedTranslation],
      representations: [
        { id: "fa:representation:translation" },
      ],
      derivations: [{
        id: "fa:derivation:translation",
        type: "translation",
        inputIds: ["fa:representation:other"],
        outputIds: ["fa:representation:translation"],
      }],
      manifestArtifactIds: new Set(["fa:artifact:review"]),
    };

    expect(findTranslationContractGaps(release)).toEqual([
      {
        id: "fa:translation:test",
        reasons: [
          "missing-source-representation",
          "missing-translation-derivation",
        ],
      },
    ]);
  });

  it("rejects a release-level self-link even with a matching derivation", () => {
    const selfLinked = {
      ...acceptedTranslation,
      sourceRepresentationId: "fa:representation:translation",
    };
    expect(findTranslationContractGaps({
      translations: [selfLinked],
      representations: [{
        id: "fa:representation:translation",
      }],
      derivations: [{
        id: "fa:derivation:translation",
        type: "translation",
        inputIds: ["fa:representation:translation"],
        outputIds: ["fa:representation:translation"],
      }],
      manifestArtifactIds: new Set(["fa:artifact:review"]),
    })).toEqual([{
      id: "fa:translation:test",
      reasons: ["source-equals-translation"],
    }]);
  });

  it("rejects contradictory records for one translated Representation", () => {
    const contradictory = {
      ...acceptedTranslation,
      id: "fa:translation:contradictory",
      producerClass: "machine-generated",
    };
    const gaps = findTranslationContractGaps({
      translations: [acceptedTranslation, contradictory],
      representations: [
        { id: "fa:representation:source" },
        { id: "fa:representation:translation" },
      ],
      derivations: [{
        id: "fa:derivation:translation",
        type: "translation",
        inputIds: ["fa:representation:source"],
        outputIds: ["fa:representation:translation"],
      }],
      manifestArtifactIds: new Set(["fa:artifact:review"]),
    });
    expect(gaps).toEqual([
      {
        id: "fa:translation:test",
        reasons: ["duplicate-translation-representation"],
      },
      {
        id: "fa:translation:contradictory",
        reasons: ["duplicate-translation-representation"],
      },
    ]);
  });

  it("fails visibly for unreviewed machine translations", () => {
    const translation = {
      ...acceptedTranslation,
      producerClass: "machine-generated",
      reviewStatus: "unreviewed",
      reviewedById: null,
      reviewEvidenceArtifactId: null,
    };
    expect(supportsLanguageSensitiveUse(translation)).toBe(false);
    expect(supportsLanguageSensitiveUse(acceptedTranslation)).toBe(true);
  });
});
