import { describe, expect, it } from "vitest";

import {
  assertReleasePublicationRights,
  findRightsCoverageGaps,
  findRightsCoverageGapsByUseCase,
  RIGHTS_RELEASE_FIELDS,
} from "../scripts/lib/rights-contract-v2.mjs";

const digest = "01".repeat(32);
const representationId = "fa:representation:test";
const representationArtifactId = "fa:artifact:representation";
const captureArtifactId = `fa:artifact:sha256-${digest}`;
const permitted = (subjectId: string) => ({
  subjectId,
  reviewState: "accepted",
  ...Object.fromEntries(RIGHTS_RELEASE_FIELDS.map((field) => [field, true])),
});

describe("v0.3 release rights coverage", () => {
  it("recomputes coverage instead of trusting the candidate gate report", () => {
    const release = {
      captures: [{ rawSha256: digest }],
      representations: [{
        id: representationId,
        artifactId: representationArtifactId,
      }],
      rightsAssessments: [
        permitted(representationId),
        permitted(representationArtifactId),
        permitted(captureArtifactId),
      ],
    };
    expect(findRightsCoverageGaps(release, "evidence-use")).toEqual([]);

    release.rightsAssessments = release.rightsAssessments.filter(
      ({ subjectId }) => subjectId !== representationArtifactId,
    );
    expect(findRightsCoverageGaps(release, "evidence-use")).toEqual([
      representationArtifactId,
    ]);
  });

  it("publishes an evidence-covered source while preserving ML restrictions", () => {
    const rights = permitted(representationId);
    rights.mlEvaluationAllowed = false;
    rights.mlTrainingAllowed = false;
    const release = {
      captures: [],
      representations: [{
        id: representationId,
        artifactId: representationId,
      }],
      rightsAssessments: [rights],
    };

    expect(findRightsCoverageGaps(release, "evidence-use")).toEqual([]);
    expect(findRightsCoverageGaps(release, "quotation")).toEqual([]);
    expect(findRightsCoverageGaps(release, "ml-training")).toEqual([
      representationId,
    ]);
    const gaps = findRightsCoverageGapsByUseCase(release);
    expect(gaps).toMatchObject({
      "evidence-use": [],
      quotation: [],
      "ml-evaluation": [representationId],
      "ml-training": [representationId],
    });
    expect(() => assertReleasePublicationRights(gaps)).not.toThrow();
  });

  it("rejects publication when evidence use is not covered", () => {
    expect(() => assertReleasePublicationRights({
      "evidence-use": [representationId],
      quotation: [],
      redistribution: [],
      "access-private-use": [],
      "ml-evaluation": [],
      "ml-training": [],
    })).toThrow("Fail-closed evidence-use Rights coverage gaps");
  });

  it("treats unknown and prohibited requested uses as coverage gaps", () => {
    for (const decision of [null, false]) {
      const rights = permitted(representationId);
      rights.mlTrainingAllowed = decision;
      expect(findRightsCoverageGaps({
        captures: [],
        representations: [{
          id: representationId,
          artifactId: representationId,
        }],
        rightsAssessments: [rights],
      }, "ml-training")).toEqual([representationId]);
    }
  });
});
