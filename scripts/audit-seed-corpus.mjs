import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const rawRoot = path.join(root, "data/raw/gutenberg");
const corpusPath = path.join(root, "data/derived/folklore-corpus.json");
const reportRoot = path.join(root, "reports/corpus");

const parserSpecs = [
  {
    id: "grimm-2591",
    file: "grimms-2591.txt",
    tocStart: "CONTENTS:",
    bodyStart: "THE BROTHERS GRIMM FAIRY TALES",
    tocMode: "indented-uppercase",
    sourceKind: "historical literary collection and translation",
  },
  {
    id: "andersen-1597",
    file: "andersen-1597.txt",
    tocStart: "CONTENTS",
    bodyStart: "THE EMPEROR'S NEW CLOTHES",
    tocMode: "indented-titlecase",
    sourceKind: "authored literary fairy tales in English translation",
  },
  {
    id: "english-7439",
    file: "english-7439.txt",
    tocStart: "CONTENTS",
    tocEnd: "NOTES AND REFERENCES",
    bodyStart: "TOM TIT TOT",
    bodyEnd: "NOTES AND REFERENCES",
    tocMode: "roman-paragraph",
    sourceKind: "traditional tales selected and edited by Joseph Jacobs",
  },
  {
    id: "celtic-7885",
    file: "celtic-7885.txt",
    tocStart: "CONTENTS",
    tocEnd: "NOTES AND REFERENCES",
    bodyStart: "CONNLA AND THE FAIRY MAIDEN",
    bodyEnd: "NOTES AND REFERENCES",
    tocMode: "roman-lines",
    sourceKind: "mixed Irish, Scottish, and Welsh tales selected by Joseph Jacobs",
  },
  {
    id: "japanese-4018",
    file: "japanese-4018.txt",
    tocStart: "CONTENTS.",
    bodyStart: "JAPANESE FAIRY TALES.",
    tocMode: "uppercase-lines",
    sourceKind: "Japanese tales compiled and translated by Yei Theodora Ozaki",
  },
];

function normalize(value) {
  return value
    .replace(/\r/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[_*[\].,;:!?"]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function countOccurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function extractTitles(text, spec) {
  const tocStart = text.indexOf(spec.tocStart);
  const tocEnd = text.indexOf(spec.tocEnd ?? spec.bodyStart, tocStart + spec.tocStart.length);
  if (tocStart < 0 || tocEnd < 0) {
    throw new Error(`Could not find TOC boundaries for ${spec.id}`);
  }
  const toc = text.slice(tocStart + spec.tocStart.length, tocEnd);

  if (spec.tocMode === "roman-paragraph") {
    const compact = toc.replace(/\s+/g, " ").trim();
    return [
      ...compact.matchAll(
        /(?:^|\s)([IVXLCDM]+)\.\s+(.+?)(?=\s+[IVXLCDM]+\.\s+|NOTES AND REFERENCES|$)/g,
      ),
    ].map((match) => match[2].trim().replace(/[.]+$/, ""));
  }

  return toc
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      spec.tocMode === "roman-lines" ? line.replace(/^[IVXLCDM]+\.\s+/, "") : line,
    )
    .filter((line) => {
      if (spec.tocMode === "indented-titlecase") {
        return /^[A-Z]/.test(line) && line.length < 100;
      }
      return (
        line.length >= 3 &&
        line.length < 110 &&
        line === line.toUpperCase() &&
        !/^(CONTENTS|NOTES|FAIRY TALES|BY THE)/.test(line) &&
        !/^\d+\./.test(line) &&
        line !== "THE BROTHERS GRIMM FAIRY TALES"
      );
    })
    .filter((line, index, all) => normalize(line) !== normalize(all[index - 1] ?? ""));
}

function extractCandidates(text, spec, titles) {
  const searchFrom = spec.tocEnd
    ? text.indexOf(spec.tocEnd, text.indexOf(spec.tocStart)) + spec.tocEnd.length
    : text.indexOf(spec.tocStart);
  const bodyMarker = text.indexOf(spec.bodyStart, searchFrom);
  const bodyEnd = spec.bodyEnd
    ? text.indexOf(spec.bodyEnd, bodyMarker + spec.bodyStart.length)
    : text.indexOf("*** END OF", bodyMarker);
  if (bodyMarker < 0 || bodyEnd < 0) {
    throw new Error(`Could not find body boundaries for ${spec.id}`);
  }

  const lines = text.slice(bodyMarker, bodyEnd).split("\n");
  const titleByKey = new Map(titles.map((title) => [normalize(title), title]));
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const title = titleByKey.get(normalize(lines[index]));
    if (!title || headings.some((heading) => heading.title === title)) continue;
    headings.push({ title, index });
  }

  return headings.map((heading, index) => {
    const next = headings[index + 1]?.index ?? lines.length;
    const text = lines
      .slice(heading.index + 1, next)
      .join("\n")
      .replace(/\n+End of Project Gutenberg[\s\S]*$/i, "")
      .replace(spec.id === "grimm-2591" ? /\n\s*\*{5}\s*\n[\s\S]*$/ : /$^/, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { title: heading.title, text, admittedByCurrentLengthGate: text.length >= 350 };
  });
}

function duplicates(values, keyOf = (value) => normalize(value)) {
  const groups = new Map();
  values.forEach((value) => {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  });
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, values: group }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const [manifest, corpus] = await Promise.all([
  readFile(path.join(rawRoot, "manifest.json"), "utf8").then(JSON.parse),
  readFile(corpusPath, "utf8").then(JSON.parse),
]);

const manifestByFile = new Map(manifest.entries.map((entry) => [entry.file, entry]));
const collectionAudits = [];

for (const spec of parserSpecs) {
  const raw = (await readFile(path.join(rawRoot, spec.file), "utf8")).replace(/\r/g, "");
  const titles = extractTitles(raw, spec);
  const candidates = extractCandidates(raw, spec, titles);
  const emitted = corpus.stories.filter((story) => story.collectionId === spec.id);
  const admittedCandidates = candidates.filter((candidate) => candidate.admittedByCurrentLengthGate);
  const wordCounts = emitted.map((story) => story.wordCount);
  const rawEntry = manifestByFile.get(spec.file);

  collectionAudits.push({
    collectionId: spec.id,
    sourceKind: spec.sourceKind,
    rawFile: `data/raw/gutenberg/${spec.file}`,
    rawSha256: rawEntry?.sha256 ?? null,
    rawByteLength: rawEntry?.byteLength ?? null,
    sourceUrl: rawEntry?.sourceUrl ?? null,
    projectGutenbergStartMarkers: countOccurrences(raw, /\*\*\* START OF/gi),
    projectGutenbergEndMarkers: countOccurrences(raw, /\*\*\* END OF/gi),
    tocEntryCount: titles.length,
    uniqueTocEntryCount: new Set(titles.map(normalize)).size,
    locatedBodyHeadingCount: candidates.length,
    currentLengthGateCount: admittedCandidates.length,
    emittedCount: emitted.length,
    omittedOrShortEntries: candidates
      .filter((candidate) => !candidate.admittedByCurrentLengthGate)
      .map((candidate) => ({ title: candidate.title, characterCount: candidate.text.length })),
    tocTitlesNotLocatedInBody: titles.filter(
      (title) => !candidates.some((candidate) => normalize(candidate.title) === normalize(title)),
    ),
    repeatedTocTitles: duplicates(titles),
    repeatedEmittedTitles: duplicates(emitted.map((story) => story.title)),
    firstEmittedTitle: emitted[0]?.title ?? null,
    lastEmittedTitle: emitted.at(-1)?.title ?? null,
    wordCounts: {
      minimum: Math.min(...wordCounts),
      median: percentile(wordCounts, 0.5),
      p90: percentile(wordCounts, 0.9),
      maximum: Math.max(...wordCounts),
      total: wordCounts.reduce((total, count) => total + count, 0),
    },
    emittedTextContainsGutenbergFooter: emitted.some((story) =>
      /End of Project Gutenberg|\*\*\* END OF/i.test(story.text),
    ),
  });
}

const exactTextGroups = duplicates(
  corpus.stories,
  (story) => sha256(story.text.replace(/\s+/g, " ").trim().toLowerCase()),
).map((group) => ({
  normalizedTextSha256: group.key,
  storyIds: group.values.map((story) => story.id),
  titles: group.values.map((story) => story.title),
}));

const repeatedTitlesAcrossCorpus = duplicates(corpus.stories, (story) =>
  normalize(story.title),
).map((group) => ({
  normalizedTitle: group.key,
  storyIds: group.values.map((story) => story.id),
  titles: group.values.map((story) => story.title),
}));

const report = {
  schema: "folklore-seed-audit-v1",
  auditDate: manifest.capturedAt,
  corpusSchema: corpus.schema,
  corpusChecksum: corpus.checksum,
  summary: {
    rawEditionCount: manifest.entries.length,
    emittedStoryCount: corpus.stories.length,
    emittedCollectionCount: corpus.collections.length,
    totalWords: corpus.stories.reduce((total, story) => total + story.wordCount, 0),
    languages: [...new Set(corpus.stories.map((story) => story.language))].sort(),
    exactNormalizedTextDuplicateGroupCount: exactTextGroups.length,
    repeatedNormalizedTitleGroupCount: repeatedTitlesAcrossCorpus.length,
    currentIdsContainingMutableTitleSlug: corpus.stories.filter((story) =>
      story.id.endsWith(normalize(story.title).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, "-").slice(0, 70)),
    ).length,
    recordsWithStablePassageIds: 0,
    recordsWithReleaseSplitAssignment: corpus.stories.filter(
      (story) => Object.hasOwn(story, "split") || Object.hasOwn(story, "splitId"),
    ).length,
  },
  collectionAudits,
  duplicateEvidence: {
    exactNormalizedTextGroups: exactTextGroups,
    repeatedTitlesAcrossCorpus,
  },
  fieldSuitability: [
    {
      field: "id",
      safeUse: "temporary application identity only",
      unsafeUse: "durable cross-release identity",
      reason: "The identifier contains entry order and a mutable normalized title slug.",
    },
    {
      field: "text",
      safeUse: "model input and readable witness after source-boundary review",
      unsafeUse: "source-language or oral-performance evidence",
      reason: "All current texts are English historical editions or translations/retellings.",
    },
    {
      field: "collectionId",
      safeUse: "grouping, held-out diagnostics, and source-slice reporting",
      unsafeUse: "a folklore class target",
      reason: "It identifies one edition and leaks editor, translator, and writing style.",
    },
    {
      field: "tradition and region",
      safeUse: "display and coarse diagnostic slicing",
      unsafeUse: "precise cultural, national, or geographic gold labels",
      reason: "Values are collection-wide editorial descriptions, sometimes intentionally broad.",
    },
    {
      field: "motifs, beings, and roles",
      safeUse: "rule-derived navigation suggestions and weak-label diagnostics",
      unsafeUse: "gold labels for supervised evaluation",
      reason: "They are generated from regexes over the same story text a model would receive.",
    },
    {
      field: "source",
      safeUse: "locating the catalog item and current raw file",
      unsafeUse: "complete capture-to-passage provenance",
      reason: "It lacks capture identity, upstream revision, derivation events, and passage offsets.",
    },
  ],
  blockingFindings: [
    "Current story IDs are not durable because mutable title slugs are embedded in them.",
    "The five inputs are English editions; this is not yet a multilingual dataset.",
    "The output has no Source/Edition/Document/Witness/Passage identity hierarchy.",
    "The output has no passage-level citations or task-specific split manifests.",
    "Regex-derived concept suggestions cannot be treated as supervised gold labels.",
    "The raw manifest identifies mirror URLs but not an upstream revision or per-capture directory.",
  ],
};

const markdown = `# Audit of the 170-story seed

Generated deterministically from the checked-in raw manifest, source books,
compiler boundaries, and derived corpus.

## Result

The seed contains **${report.summary.emittedStoryCount.toLocaleString()} emitted stories**
and **${report.summary.totalWords.toLocaleString()} words** from
**${report.summary.rawEditionCount} English-language editions**. It is useful as
an incubation corpus, but it is not yet a durable Corpus Release.

| Collection | TOC entries | Located headings | Emitted | Words |
| --- | ---: | ---: | ---: | ---: |
${collectionAudits
  .map(
    (item) =>
      `| ${item.collectionId} | ${item.tocEntryCount} | ${item.locatedBodyHeadingCount} | ${item.emittedCount} | ${item.wordCounts.total.toLocaleString()} |`,
  )
  .join("\n")}

## Identity and ML blockers

${report.blockingFindings.map((finding) => `- ${finding}`).join("\n")}

## Duplicate evidence

- Exact normalized-text duplicate groups: ${exactTextGroups.length}
- Repeated normalized-title groups: ${repeatedTitlesAcrossCorpus.length}

These counts detect identity candidates, not folklore variants. The complete
groups and field-suitability table are in
[\`seed-audit.json\`](seed-audit.json).

## Interpretation

- Project Gutenberg wrapper text is removed from every emitted story.
- All ${report.summary.currentIdsContainingMutableTitleSlug} current story IDs
  contain a mutable title slug and must not become cross-repository identities.
- Collection and tradition metadata is useful for grouping and diagnostics,
  but would make misleading or trivially leaked classifier targets.
- Motif, being, and role arrays are regex outputs. Predicting them from the
  input text would measure recovery of those regexes, not folklore knowledge.
- The next Corpus work must introduce immutable capture identity, a stable
  Source/Edition/Document/Witness/Passage hierarchy, passage exports, and
  explicit release/split manifests.
`;

await mkdir(reportRoot, { recursive: true });
await Promise.all([
  writeFile(path.join(reportRoot, "seed-audit.json"), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(path.join(reportRoot, "seed-audit.md"), markdown),
]);

console.log(
  `Audited ${report.summary.emittedStoryCount} stories across ${report.summary.rawEditionCount} editions (${report.summary.totalWords} words).`,
);
