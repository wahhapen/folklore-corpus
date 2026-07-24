import { describe, expect, it } from "vitest";

import corpus from "../data/derived/folklore-corpus.json";

describe("content-first corpus", () => {
  it("contains substantial readable collections", () => {
    expect(corpus.stories.length).toBeGreaterThanOrEqual(100);
    expect(
      corpus.collections.filter((collection) => collection.storyCount > 0),
    ).toHaveLength(5);
    expect(corpus.stories.every((story) => story.text.length >= 350)).toBe(true);
  });

  it("spans distinct traditions with complete known stories", () => {
    expect(new Set(corpus.stories.map((story) => story.collectionId)).size).toBe(5);
    expect(corpus.stories.some((story) => story.title === "Hansel And Gretel")).toBe(
      true,
    );
    expect(
      corpus.stories.some((story) => story.title.startsWith("Momotaro")),
    ).toBe(true);
    expect(
      corpus.stories.some((story) => story.title === "Connla And The Fairy Maiden"),
    ).toBe(true);
    expect(corpus.stories.some((story) => story.title === "The Wedding Of Mrs Fox")).toBe(
      true,
    );
    expect(corpus.stories.some((story) => story.title === "Conal Yellowclaw")).toBe(
      true,
    );
    expect(corpus.stories.some((story) => story.title === "First Story")).toBe(false);
    expect(corpus.stories.some((story) => story.title === "Second Story")).toBe(false);
  });

  it("keeps exploration concepts secondary and source links attached", () => {
    expect(new Set(corpus.stories.flatMap((story) => story.motifs)).size).toBeGreaterThanOrEqual(
      30,
    );
    expect(
      corpus.stories.filter(
        (story) => story.motifs.length + story.beings.length + story.roles.length >= 2,
      ).length,
    ).toBeGreaterThan(100);
    expect(
      corpus.stories.every((story) => story.source.institution === "Project Gutenberg"),
    ).toBe(true);
  });

  it("removes ebook boilerplate and preserves natural apostrophe casing", () => {
    expect(
      corpus.stories.every((story) => !story.text.includes("End of Project Gutenberg")),
    ).toBe(true);
    expect(corpus.stories.every((story) => !story.title.includes("'S"))).toBe(true);
  });
});
