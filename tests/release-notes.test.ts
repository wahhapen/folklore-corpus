import { describe, expect, it } from "vitest";

import { RIGHTS_USE_CASES } from "../scripts/lib/rights-contract-v2.mjs";
import { rightsContractReleaseNote } from "../scripts/release-notes.mjs";

describe("Corpus release notes", () => {
  it("derives all six public rights axes from the contract vocabulary", () => {
    const note = rightsContractReleaseNote();

    expect(note).toContain("six independent fail-closed decisions");
    expect(note).not.toContain("derivative use");
    for (const { releaseNoteName } of RIGHTS_USE_CASES) {
      expect(note).toContain(releaseNoteName);
    }
  });
});
