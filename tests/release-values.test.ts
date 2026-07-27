import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  isIsoCalendarDate,
  serializeReviewedOn,
} from "../scripts/lib/release-values.mjs";

describe("Release value serialization", () => {
  it("serializes a PGlite Date without locale-dependent truncation", () => {
    expect(
      serializeReviewedOn(new Date("2026-07-25T00:00:00.000Z")),
    ).toBe("2026-07-25");
  });

  it("preserves an ISO SQL date", () => {
    expect(serializeReviewedOn("2026-07-25")).toBe("2026-07-25");
  });

  it("rejects malformed or locale-formatted dates", () => {
    expect(() => serializeReviewedOn("Sat Jul 25")).toThrow(
      "Invalid rights reviewed_on value",
    );
  });

  it("rejects impossible calendar dates", () => {
    expect(isIsoCalendarDate("2026-02-28")).toBe(true);
    expect(isIsoCalendarDate("2026-02-30")).toBe(false);
    expect(isIsoCalendarDate("2026-99-99")).toBe(false);
    expect(() => serializeReviewedOn("2026-02-30")).toThrow(
      "Invalid rights reviewed_on value",
    );
  });

  it("rejects malformed reviewedOn values in release records", () => {
    const schema = JSON.parse(
      readFileSync("schemas/corpus-release-v2.schema.json", "utf8"),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate({
      schemaVersion: "folklore-rights-assessment-v1",
      id: "fa:rights-assessment:test",
      subjectId: "fa:artifact:test",
      rightsSource: "Test review",
      attributionText: "Test attribution",
      jurisdiction: "US",
      reviewedOn: "Sat Jul 25",
      reviewState: "accepted",
      evidenceArtifactId: "fa:artifact:evidence",
    })).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: "/reviewedOn",
          keyword: "pattern",
        }),
      ]),
    );
  });
});
