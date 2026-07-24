import { describe, expect, it } from "vitest";

import audit from "../reports/corpus/seed-audit.json";

describe("seed corpus audit", () => {
  it("accounts for every current edition and emitted story", () => {
    expect(audit.summary.rawEditionCount).toBe(5);
    expect(audit.summary.emittedStoryCount).toBe(170);
    expect(
      audit.collectionAudits.reduce(
        (total, collection) => total + collection.emittedCount,
        0,
      ),
    ).toBe(170);
  });

  it("proves source boundaries are found without leaking ebook wrappers", () => {
    expect(
      audit.collectionAudits.every(
        (collection) =>
          collection.projectGutenbergStartMarkers === 1 &&
          collection.projectGutenbergEndMarkers === 1,
      ),
    ).toBe(true);
    expect(
      audit.collectionAudits.every(
        (collection) => !collection.emittedTextContainsGutenbergFooter,
      ),
    ).toBe(true);
  });

  it("records why the compatibility bundle is not the ML-ready release", () => {
    expect(audit.summary.currentIdsContainingMutableTitleSlug).toBe(169);
    expect(audit.summary.recordsWithStablePassageIds).toBe(0);
    expect(audit.summary.recordsWithReleaseSplitAssignment).toBe(0);
    expect(
      audit.fieldSuitability.find((item) => item.field === "motifs, beings, and roles")
        ?.unsafeUse,
    ).toBe("gold labels for supervised evaluation");
  });
});
