import { describe, expect, it } from "vitest";

import {
  findRightsCoverageGaps,
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
    expect(findRightsCoverageGaps(release)).toEqual([]);

    release.rightsAssessments = release.rightsAssessments.filter(
      ({ subjectId }) => subjectId !== representationArtifactId,
    );
    expect(findRightsCoverageGaps(release)).toEqual([
      representationArtifactId,
    ]);
  });

  it("treats unknown and prohibited use decisions as coverage gaps", () => {
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
      })).toEqual([representationId]);
    }
  });
});
