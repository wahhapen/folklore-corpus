import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(
  readFileSync("schemas/corpus-release-v3.schema.json", "utf8"),
);
const previousSchema = JSON.parse(
  readFileSync("schemas/corpus-release-v2.schema.json", "utf8"),
);
const validate = new Ajv2020({ strict: false })
  .addSchema(previousSchema)
  .compile(schema);

const acceptedRights = {
  schemaVersion: "folklore-rights-assessment-v2",
  id: "fa:rights-assessment:test-v2",
  subjectId: "fa:artifact:test",
  rightsSource: "Test review",
  attributionText: "Test attribution",
  evidenceUseAllowed: true,
  quotationAllowed: true,
  redistributionAllowed: true,
  accessPrivateUseAllowed: true,
  mlEvaluationAllowed: true,
  mlTrainingAllowed: false,
  jurisdiction: "US",
  reviewedOn: "2026-07-27",
  reviewState: "accepted",
  evidenceArtifactId: "fa:artifact:evidence",
};

describe("Rights Contract v2 release records", () => {
  it("requires an explicit tri-state decision for every governed use", () => {
    expect(validate(acceptedRights)).toBe(true);

    for (const field of [
      "evidenceUseAllowed",
      "quotationAllowed",
      "redistributionAllowed",
      "accessPrivateUseAllowed",
      "mlEvaluationAllowed",
      "mlTrainingAllowed",
    ]) {
      const incomplete = { ...acceptedRights };
      delete incomplete[field as keyof typeof incomplete];
      expect(validate(incomplete), field).toBe(false);
    }
  });

  it("does not treat a v0.2 rights record as a v2 permission grant", () => {
    expect(validate({
      ...acceptedRights,
      schemaVersion: "folklore-rights-assessment-v1",
    })).toBe(false);
  });
});
