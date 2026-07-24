import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const releaseRoot = path.resolve("data/derived/releases/corpus-v0.1.0");

function readJsonLines(file: string) {
  return readFileSync(path.join(releaseRoot, file), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const manifest = JSON.parse(
  readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"),
);
const documents = readJsonLines("documents.jsonl");
const witnesses = readJsonLines("witnesses.jsonl");
const passages = readJsonLines("passages.jsonl");
const splits = readJsonLines("splits.jsonl");
const aliases = readJsonLines("aliases.jsonl");
const lineage = readJsonLines("lineage.jsonl");

describe("Corpus Release v0.1.0", () => {
  it("repairs the two audited segmentation defects", () => {
    expect(documents).toHaveLength(170);
    expect(documents.some((document) => document.title === "The Wedding Of Mrs Fox")).toBe(
      true,
    );
    expect(documents.some((document) => document.title === "First Story")).toBe(false);
    expect(documents.some((document) => document.title === "Second Story")).toBe(false);
    expect(documents.some((document) => document.title === "Conal Yellowclaw")).toBe(
      true,
    );
  });

  it("uses title-independent identities at every public citation level", () => {
    expect(documents.every((document) => /^fa:document:pg-\d+:toc-\d{3}$/.test(document.id))).toBe(
      true,
    );
    expect(
      witnesses.every((witness) =>
        /^fa:witness:pg-\d+:toc-\d{3}:text-en$/.test(witness.id),
      ),
    ).toBe(true);
    expect(
      passages.every((passage) =>
        /^fa:passage:pg-\d+:toc-\d{3}:text-en:p\d{4}$/.test(passage.id),
      ),
    ).toBe(true);
  });

  it("traces each passage to one witness, document, capture, and raw digest", () => {
    const witnessIds = new Set(witnesses.map((witness) => witness.id));
    const documentIds = new Set(documents.map((document) => document.id));
    const lineageByOutput = new Map(lineage.map((event) => [event.outputId, event]));

    for (const passage of passages) {
      expect(witnessIds.has(passage.witnessId)).toBe(true);
      expect(documentIds.has(passage.documentId)).toBe(true);
      const event = lineageByOutput.get(passage.id);
      expect(event?.inputIds).toContain(passage.witnessId);
      expect(event?.rawSha256).toMatch(/^[a-f0-9]{64}$/);
      const witness = witnesses.find(
        (candidate) => candidate.id === passage.witnessId,
      );
      expect(
        witness?.text.slice(passage.characterStart, passage.characterEnd),
      ).toBe(passage.text);
    }
    for (const witness of witnesses) {
      expect(witness.sourceSpan.rawByteEnd).toBeGreaterThan(
        witness.sourceSpan.rawByteStart,
      );
      expect(witness.sourceSpan.rawSliceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("ships stable task splits and compatibility aliases", () => {
    expect(splits).toHaveLength(documents.length);
    expect(new Set(splits.map((split) => split.documentId)).size).toBe(documents.length);
    expect(new Set(splits.map((split) => split.split))).toEqual(
      new Set(["train", "validation", "test"]),
    );
    expect(aliases.length).toBeGreaterThanOrEqual(170);
    expect(aliases.every((alias) => alias.kind === "legacy-story-id")).toBe(true);
  });

  it("publishes content-addressed, internally counted artifacts", () => {
    expect(manifest.releaseId).toBe("fa:release:corpus-v0.1.0");
    expect(manifest.counts.documents).toBe(documents.length);
    expect(manifest.counts.witnesses).toBe(witnesses.length);
    expect(manifest.counts.passages).toBe(passages.length);
    expect(
      manifest.artifacts.every((artifact: { sha256: string }) =>
        /^[a-f0-9]{64}$/.test(artifact.sha256),
      ),
    ).toBe(true);
  });
});
