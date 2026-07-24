import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const rawRoot = path.join(root, "data/raw/gutenberg");
const outputPath = path.join(root, "data/derived/folklore-corpus.json");
const releaseRoot = path.join(
  root,
  "data/derived/releases/corpus-v0.1.0",
);

const collections = [
  {
    id: "grimm-2591",
    file: "grimms-2591.txt",
    title: "Grimms' Fairy Tales",
    author: "Jacob and Wilhelm Grimm",
    editor: "Edgar Taylor and Marian Edwardes, translators",
    tradition: "German",
    region: "Central Europe",
    gutenbergId: 2591,
    sourceUrl: "https://www.gutenberg.org/ebooks/2591",
    tocStart: "CONTENTS:",
    bodyStart: "THE BROTHERS GRIMM FAIRY TALES",
    tocMode: "indented-uppercase",
    nonDocumentHeadings: ["FIRST STORY", "SECOND STORY"],
  },
  {
    id: "andersen-1597",
    file: "andersen-1597.txt",
    title: "Andersen's Fairy Tales",
    author: "Hans Christian Andersen",
    editor: "English-language Project Gutenberg edition",
    tradition: "Danish literary folklore",
    region: "Nordic Europe",
    gutenbergId: 1597,
    sourceUrl: "https://www.gutenberg.org/ebooks/1597",
    tocStart: "CONTENTS",
    bodyStart: "THE EMPEROR'S NEW CLOTHES",
    tocMode: "indented-titlecase",
  },
  {
    id: "english-7439",
    file: "english-7439.txt",
    title: "English Fairy Tales",
    author: "Traditional",
    editor: "Joseph Jacobs, collector and editor",
    tradition: "English",
    region: "Britain",
    gutenbergId: 7439,
    sourceUrl: "https://www.gutenberg.org/ebooks/7439",
    tocStart: "CONTENTS",
    tocEnd: "NOTES AND REFERENCES",
    bodyStart: "TOM TIT TOT",
    tocMode: "roman-paragraph",
    bodyEnd: "NOTES AND REFERENCES",
  },
  {
    id: "celtic-7885",
    file: "celtic-7885.txt",
    title: "Celtic Fairy Tales",
    author: "Traditional",
    editor: "Joseph Jacobs, selector and editor",
    tradition: "Irish, Scottish, Welsh and Celtic",
    region: "Ireland and Britain",
    gutenbergId: 7885,
    sourceUrl: "https://www.gutenberg.org/ebooks/7885",
    tocStart: "CONTENTS",
    tocEnd: "NOTES AND REFERENCES",
    bodyStart: "CONNLA AND THE FAIRY MAIDEN",
    tocMode: "roman-lines",
    bodyEnd: "NOTES AND REFERENCES",
    bodyHeadingAliases: {
      "CONALL YELLOWCLAW": "CONAL YELLOWCLAW",
    },
  },
  {
    id: "japanese-4018",
    file: "japanese-4018.txt",
    title: "Japanese Fairy Tales",
    author: "Traditional",
    editor: "Yei Theodora Ozaki, compiler and translator",
    tradition: "Japanese",
    region: "Japan",
    gutenbergId: 4018,
    sourceUrl: "https://www.gutenberg.org/ebooks/4018",
    tocStart: "CONTENTS.",
    bodyStart: "JAPANESE FAIRY TALES.",
    tocMode: "uppercase-lines",
  },
];

const conceptVocabulary = {
  motifs: [
    ["transformation", /\b(transform|changed? into|turned? into|shape-shift|became a)\b/i],
    ["magical helper", /\b(helped him|helped her|magic(?:al)? gift|gave him|gave her)\b/i],
    ["impossible task", /\b(impossible|three tasks?|task was|before sunrise|before night)\b/i],
    ["forbidden action", /\b(must not|forbidden|never open|do not look|should not)\b/i],
    ["otherworld journey", /\b(other world|underworld|fairy land|plain of pleasure|moon-child)\b/i],
    ["enchanted sleep", /\b(slept for|deep sleep|enchanted sleep|hundred years)\b/i],
    ["lost or endangered child", /\b(lost child|children were|child was|abandoned|stepmother)\b/i],
    ["sibling rescue", /\b(brother and sister|brothers and sisters|save (?:his|her) brother|save (?:his|her) sister)\b/i],
    ["clever trick", /\b(trick|outwit|clever|deceiv|pretend)\b/i],
    ["quest", /\b(set out|went forth|in search of|journey|adventure)\b/i],
    ["royal marriage", /\b(marry the princess|married the princess|marry the prince|became queen|became king)\b/i],
    ["death and return", /\b(came back to life|restored to life|rose from the dead|killed and)\b/i],
    ["three wishes", /\bthree wishes\b|\bthird wish\b/i],
    ["magical object", /\bmagic(?:al)? (?:ring|sword|wand|mirror|cloak|cap|stone|box|book)\b|\benchanted (?:ring|sword|mirror|object)\b/i],
    ["kindness rewarded", /\b(?:kindness|good deed).{0,50}(?:reward|fortune)|\brewarded (?:him|her|them)\b/i],
    ["greed punished", /\bgreed(?:y|iness).{0,80}(?:punish|ruin|lost)|\bpunish(?:ed|ment).{0,60}greed/i],
    ["disguise", /\bdisguis(?:e|ed|ing)\b|\bdressed (?:himself|herself) as\b/i],
    ["riddle or name guessing", /\briddles?\b|\bguess (?:my|his|her) name\b/i],
    ["bargain or pact", /\b(?:made|struck) a bargain\b|\bpromise me\b|\bin exchange for\b/i],
    ["prophecy", /\bprophes(?:y|ied)|\bforetold\b|\bit was predicted\b/i],
    ["test of character", /\bput (?:him|her|them) to the test\b|\btest (?:his|her|their) (?:heart|kindness|courage)\b/i],
    ["animal spouse", /\bmarried (?:the|a) (?:frog|bear|serpent|beast|animal)\b|\b(?:frog|bear|serpent|beast) (?:husband|wife|bridegroom|bride)\b/i],
    ["monster defeat", /\b(?:slew|killed|defeated|conquered) (?:the|a) (?:dragon|giant|ogre|monster|demon)\b/i],
    ["stolen treasure", /\bstole[n]? (?:the )?(?:gold|treasure|jewels?)\b|\bstolen treasure\b/i],
    ["supernatural prohibition", /\b(?:fairy|witch|spirit|ghost).{0,80}(?:must not|forbade|forbidden|never)\b/i],
    ["miraculous birth", /\b(?:born|birth).{0,70}(?:miracle|marvellous|wonder|peach|egg)\b/i],
    ["humble hero", /\bpoor (?:boy|girl|lad|youth|woodcutter|fisherman)\b|\byoungest son\b/i],
    ["jealous sibling", /\bjealous (?:brother|sister|brothers|sisters)\b|\b(?:brother|sister).{0,50}jealous\b/i],
    ["dangerous gift", /\b(?:gift|present).{0,80}(?:danger|death|poison|curse)|\bpoisoned (?:gift|apple|comb)\b/i],
    ["rescue", /\brescued?\b|\bsave (?:him|her|them|the princess|the prince)\b/i],
    ["revenge", /\brevenge\b|\bavenge[ds]?\b/i],
    ["trickster contest", /\bcontest\b.{0,100}\b(?:clever|trick|outwit)\b|\b(?:clever|trick|outwit).{0,100}\bcontest\b/i],
    ["magical food", /\bmagic(?:al)? (?:bean|beans|apple|fruit|food|cake|bread)\b|\benchanted (?:apple|fruit|food)\b/i],
    ["flight and pursuit", /\b(?:fled|ran away|flew away).{0,120}(?:pursu|chased|followed)\b|\b(?:pursu|chased).{0,120}(?:fled|ran away)\b/i],
    ["false bride", /\bfalse bride\b|\bwrong bride\b|\bbride was (?:changed|exchanged)\b/i],
    ["recognition token", /\b(?:ring|shoe|slipper|token).{0,80}(?:recogniz|knew her|knew him)\b/i],
    ["secret room", /\bsecret (?:room|chamber|door)\b|\bforbidden (?:room|chamber|door)\b/i],
    ["homecoming", /\breturned home\b|\bcame home at last\b|\bhome again\b/i],
    ["abandoned in the forest", /\b(?:left|abandoned|lost).{0,80}\b(?:forest|wood)\b|\bforest.{0,80}\b(?:abandoned|lost)\b/i],
    ["helpful dead", /\bdead (?:man|woman|person|father|mother).{0,100}\bhelp|\bghost.{0,80}\bhelp/i],
    ["curse broken", /\b(?:curse|spell|enchantment).{0,100}\b(?:broken|ended|lifted)\b|\bfreed from (?:the )?(?:curse|spell|enchantment)\b/i],
    ["sacrifice", /\bsacrific(?:e|ed|ing)\b|\bgave (?:his|her) life\b/i],
    ["hospitality tested", /\b(?:guest|stranger|traveller).{0,100}\b(?:food|shelter|welcome|door)\b/i],
  ],
  beings: [
    ["fairy", /\bfair(?:y|ies)\b/i],
    ["witch", /\bwitch(?:es)?\b/i],
    ["giant", /\bgiants?\b/i],
    ["dragon", /\bdragons?\b/i],
    ["ogre", /\bogres?\b/i],
    ["ghost", /\bghosts?\b/i],
    ["demon", /\bdemons?\b/i],
    ["mermaid", /\b(?:mermaids?|sea-maiden)\b/i],
    ["dwarf", /\bdwar(?:f|ves)\b/i],
    ["serpent", /\bserpents?\b/i],
    ["fox", /\bfox(?:es)?\b/i],
    ["wolf", /\bwol(?:f|ves)\b/i],
    ["bear", /\bbears?\b/i],
    ["raven", /\bravens?\b/i],
    ["monkey", /\bmonkeys?\b/i],
    ["badger", /\bbadgers?\b/i],
    ["talking animal", /\b(?:fox|wolf|bear|bird|horse|cat|dog|monkey|badger) (?:said|answered|spoke)\b/i],
  ],
  roles: [
    ["king", /\bkings?\b/i],
    ["queen", /\bqueens?\b/i],
    ["princess", /\bprincess(?:es)?\b/i],
    ["prince", /\bprinces?\b/i],
    ["youngest child", /\byoungest (?:son|daughter|child|brother|sister)\b/i],
    ["old woman", /\bold wom[ae]n\b/i],
    ["fisher", /\bfisher(?:man| lad|men)?\b/i],
    ["trickster", /\btrickster\b|\boutwit\b|\bclever fox\b/i],
  ],
};

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

function slugify(value) {
  return normalize(value)
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 70);
}

function extractTitles(text, collection) {
  const tocStart = text.indexOf(collection.tocStart);
  const bodyStart = text.indexOf(
    collection.tocEnd ?? collection.bodyStart,
    tocStart + collection.tocStart.length,
  );
  if (tocStart < 0 || bodyStart < 0) {
    throw new Error(`Could not find TOC/body markers for ${collection.id}`);
  }
  const toc = text.slice(tocStart + collection.tocStart.length, bodyStart);

  if (collection.tocMode === "roman-paragraph") {
    const compact = toc.replace(/\s+/g, " ").trim();
    const matches = [
      ...compact.matchAll(/(?:^|\s)([IVXLCDM]+)\.\s+(.+?)(?=\s+[IVXLCDM]+\.\s+|NOTES AND REFERENCES|$)/g),
    ];
    return matches.map((match) => match[2].trim().replace(/[.]+$/, ""));
  }

  return toc
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      collection.tocMode === "roman-lines"
        ? line.replace(/^[IVXLCDM]+\.\s+/, "")
        : line,
    )
    .filter((line) => {
      if (collection.tocMode === "indented-titlecase") {
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

function extractStories(text, collection, titles) {
  const searchFrom = collection.tocEnd
    ? text.indexOf(collection.tocEnd, text.indexOf(collection.tocStart)) +
      collection.tocEnd.length
    : text.indexOf(collection.tocStart);
  const bodyMarker = text.indexOf(collection.bodyStart, searchFrom);
  const body = text.slice(
    bodyMarker,
    collection.bodyEnd
      ? text.indexOf(collection.bodyEnd, bodyMarker + collection.bodyStart.length)
      : text.indexOf("*** END OF", bodyMarker),
  );
  const lines = body.split("\n");
  const lineStarts = [];
  let lineOffset = 0;
  for (const line of lines) {
    lineStarts.push(lineOffset);
    lineOffset += line.length + 1;
  }
  const documentTitles = titles
    .map((title, index) => ({ title, sourceOrdinal: index + 1 }))
    .filter(
      ({ title }) =>
        !(collection.nonDocumentHeadings ?? []).some(
          (heading) => normalize(heading) === normalize(title),
        ),
    );
  const titleByKey = new Map(
    documentTitles.map((entry) => [normalize(entry.title), entry]),
  );
  for (const [bodyHeading, tocHeading] of Object.entries(
    collection.bodyHeadingAliases ?? {},
  )) {
    const entry = titleByKey.get(normalize(tocHeading));
    if (entry) titleByKey.set(normalize(bodyHeading), entry);
  }
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const key = normalize(lines[index]);
    const entry = titleByKey.get(key);
    if (
      !entry ||
      headings.some((heading) => heading.sourceOrdinal === entry.sourceOrdinal)
    ) {
      continue;
    }
    headings.push({ ...entry, index });
  }

  return headings
    .map((heading, index) => {
      const next = headings[index + 1]?.index ?? lines.length;
      const text = lines
        .slice(heading.index + 1, next)
        .join("\n")
        .replace(/\n+End of Project Gutenberg[\s\S]*$/i, "")
        .replace(
          collection.id === "grimm-2591" ? /\n\s*\*{5}\s*\n[\s\S]*$/ : /$^/,
          "",
        )
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return {
        title: heading.title,
        sourceOrdinal: heading.sourceOrdinal,
        text,
        normalizedCaptureCharacterStart:
          bodyMarker + lineStarts[heading.index],
        normalizedCaptureCharacterEnd:
          bodyMarker + (lineStarts[next] ?? body.length),
      };
    })
    .filter((story) => story.text.length >= 350);
}

function detectConcepts(storyText, entries, limit = 6) {
  return entries
    .map(([label, pattern]) => ({ label, present: pattern.test(storyText) }))
    .filter((entry) => entry.present)
    .map((entry) => entry.label)
    .slice(0, limit);
}

function firstParagraph(text) {
  const paragraph = text.split(/\n\s*\n/).find((value) => value.trim().length > 80) ?? text;
  return `${paragraph.replace(/\s+/g, " ").trim().slice(0, 260)}${paragraph.length > 260 ? "…" : ""}`;
}

function titleCase(value) {
  return value
    .toLowerCase()
    .replace(/(^|[\s(—-])([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`)
    .replace(/'S\b/g, "'s");
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function sourceKey(collection) {
  return `pg-${collection.gutenbergId}`;
}

function documentId(collection, sourceOrdinal) {
  return `fa:document:${sourceKey(collection)}:toc-${pad(sourceOrdinal, 3)}`;
}

function witnessId(collection, sourceOrdinal) {
  return `fa:witness:${sourceKey(collection)}:toc-${pad(sourceOrdinal, 3)}:text-en`;
}

function legacyStoryIds(collection, story, sequenceIndex) {
  if (collection.id === "grimm-2591") {
    if (story.title === "THE WEDDING OF MRS FOX") {
      return ["grimm-2591:056:first-story", "grimm-2591:057:second-story"];
    }
    const legacyIndex = sequenceIndex + (story.sourceOrdinal > 56 ? 1 : 0);
    return [`${collection.id}:${pad(legacyIndex, 3)}:${slugify(story.title)}`];
  }

  if (collection.id === "celtic-7885") {
    if (story.sourceOrdinal === 5) return [];
    const legacyIndex = sequenceIndex - (story.sourceOrdinal > 5 ? 1 : 0);
    return [`${collection.id}:${pad(legacyIndex, 3)}:${slugify(story.title)}`];
  }

  return [`${collection.id}:${pad(sequenceIndex, 3)}:${slugify(story.title)}`];
}

function applicationStoryId(collection, story, sequenceIndex) {
  return (
    legacyStoryIds(collection, story, sequenceIndex)[0] ??
    `${collection.id}:${pad(sequenceIndex, 3)}:${slugify(story.title)}`
  );
}

function stableSplit(id) {
  const bucket =
    Number.parseInt(
      createHash("sha256").update(id).digest("hex").slice(0, 8),
      16,
    ) % 10;
  if (bucket === 0) return "test";
  if (bucket === 1) return "validation";
  return "train";
}

function passageSlices(text, maximumWords = 220) {
  const paragraphs = [
    ...text.matchAll(/(?:^|\n\s*\n)([^\n][\s\S]*?)(?=\n\s*\n|$)/g),
  ]
    .map((match) => {
      const raw = match[1];
      const untrimmedStart = (match.index ?? 0) + match[0].indexOf(raw);
      const leadingWhitespace = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      const start = untrimmedStart + leadingWhitespace;
      return { text: trimmed, start, end: start + trimmed.length };
    })
    .filter((paragraph) => paragraph.text);

  const slices = [];
  for (const paragraph of paragraphs) {
    if (paragraph.text.split(/\s+/).length <= maximumWords) {
      slices.push(paragraph);
      continue;
    }

    const sentences = [
      ...paragraph.text.matchAll(/[^.!?]+(?:[.!?]+["']?|$)\s*/g),
    ];
    let bufferStart = null;
    let bufferEnd = null;
    let bufferWords = 0;
    for (const sentenceMatch of sentences) {
      const rawSentence = sentenceMatch[0];
      const leadingWhitespace =
        rawSentence.length - rawSentence.trimStart().length;
      const sentence = rawSentence.trim();
      if (!sentence) continue;
      const sentenceStart = (sentenceMatch.index ?? 0) + leadingWhitespace;
      const sentenceEnd = sentenceStart + sentence.length;
      const sentenceWords = sentence.split(/\s+/).length;
      if (bufferStart !== null && bufferWords + sentenceWords > maximumWords) {
        const absoluteStart = paragraph.start + bufferStart;
        const absoluteEnd = paragraph.start + bufferEnd;
        slices.push({
          text: text.slice(absoluteStart, absoluteEnd),
          start: absoluteStart,
          end: absoluteEnd,
        });
        bufferStart = sentenceStart;
        bufferWords = 0;
      }
      if (bufferStart === null) bufferStart = sentenceStart;
      bufferEnd = sentenceEnd;
      bufferWords += sentenceWords;
    }
    if (bufferStart !== null && bufferEnd !== null) {
      const absoluteStart = paragraph.start + bufferStart;
      const absoluteEnd = paragraph.start + bufferEnd;
      slices.push({
        text: text.slice(absoluteStart, absoluteEnd),
        start: absoluteStart,
        end: absoluteEnd,
      });
    }
  }

  const merged = [];
  for (const slice of slices) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.text.split(/\s+/).length < 55 &&
      `${previous.text} ${slice.text}`.split(/\s+/).length <= maximumWords
    ) {
      previous.end = slice.end;
      previous.text = text.slice(previous.start, previous.end);
    } else {
      merged.push({ ...slice });
    }
  }
  return merged;
}

function jsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function normalizedCharacterToRawByte(text, characterOffset) {
  const prefix = text.slice(0, characterOffset);
  const newlineCount = (prefix.match(/\n/g) ?? []).length;
  return Buffer.byteLength(prefix, "utf8") + newlineCount;
}

const stories = [];
const collectionSummaries = [];
const releaseDocuments = [];
const releaseWitnesses = [];
const releasePassages = [];
const releaseSplits = [];
const releaseAliases = [];
const releaseLineage = [];
const releaseCaptures = [];
const releaseEditions = [];
const rawManifest = JSON.parse(
  await readFile(path.join(rawRoot, "manifest.json"), "utf8"),
);
const rawManifestByFile = new Map(
  rawManifest.entries.map((entry) => [entry.file, entry]),
);

for (const collection of collections) {
  const rawBytes = await readFile(path.join(rawRoot, collection.file));
  const raw = rawBytes.toString("utf8").replace(/\r/g, "");
  const titles = extractTitles(raw, collection);
  const extracted = extractStories(raw, collection, titles);
  const rawEntry = rawManifestByFile.get(collection.file);
  if (!rawEntry) throw new Error(`Raw manifest entry missing for ${collection.file}`);
  const captureId = `fa:capture:${sourceKey(collection)}:${rawManifest.capturedAt}:sha256-${rawEntry.sha256}`;

  releaseCaptures.push({
    schemaVersion: "folklore-capture-v1",
    id: captureId,
    sourceId: sourceKey(collection),
    capturedAt: rawManifest.capturedAt,
    institution: "Project Gutenberg",
    landingPage: collection.sourceUrl,
    retrievalUrl: rawEntry.sourceUrl,
    rawPath: `data/raw/gutenberg/${collection.file}`,
    rawSha256: rawEntry.sha256,
    byteLength: rawEntry.byteLength,
  });
  releaseEditions.push({
    schemaVersion: "folklore-edition-v1",
    id: `fa:edition:${sourceKey(collection)}`,
    captureId,
    title: collection.title,
    creditedAuthor: collection.author,
    creditedEditorOrTranslator: collection.editor,
    representedTradition: collection.tradition,
    representedRegion: collection.region,
    language: "en",
    sourceUrl: collection.sourceUrl,
  });

  collectionSummaries.push({
    ...collection,
    file: undefined,
    tocStart: undefined,
    bodyStart: undefined,
    bodyEnd: undefined,
    tocMode: undefined,
    nonDocumentHeadings: undefined,
    bodyHeadingAliases: undefined,
    storyCount: extracted.length,
  });

  extracted.forEach((story, index) => {
    const sequenceIndex = index + 1;
    const id = applicationStoryId(collection, story, sequenceIndex);
    const stableDocumentId = documentId(collection, story.sourceOrdinal);
    const stableWitnessId = witnessId(collection, story.sourceOrdinal);
    const legacyIds = legacyStoryIds(collection, story, sequenceIndex);
    const displayTitle = titleCase(story.title);
    const searchable = `${story.title}\n${story.text}`;

    stories.push({
      id,
      documentId: stableDocumentId,
      witnessId: stableWitnessId,
      title: displayTitle,
      collectionId: collection.id,
      collectionTitle: collection.title,
      tradition: collection.tradition,
      region: collection.region,
      author: collection.author,
      editor: collection.editor,
      language: "English",
      sourceLanguageNote:
        collection.id === "english-7439"
          ? "English retelling"
          : "English translation or retelling",
      excerpt: firstParagraph(story.text),
      text: story.text,
      wordCount: story.text.split(/\s+/).filter(Boolean).length,
      motifs: detectConcepts(searchable, conceptVocabulary.motifs),
      beings: detectConcepts(searchable, conceptVocabulary.beings),
      roles: detectConcepts(searchable, conceptVocabulary.roles),
      source: {
        institution: "Project Gutenberg",
        ebookId: collection.gutenbergId,
        url: collection.sourceUrl,
        rawFile: `data/raw/gutenberg/${collection.file}`,
      },
    });

    const split = stableSplit(stableDocumentId);
    const rawByteStart = normalizedCharacterToRawByte(
      raw,
      story.normalizedCaptureCharacterStart,
    );
    const rawByteEnd = normalizedCharacterToRawByte(
      raw,
      story.normalizedCaptureCharacterEnd,
    );
    const sourceSpan = {
      rawByteStart,
      rawByteEnd,
      rawSliceSha256: createHash("sha256")
        .update(rawBytes.subarray(rawByteStart, rawByteEnd))
        .digest("hex"),
    };
    releaseDocuments.push({
      schemaVersion: "folklore-document-v1",
      id: stableDocumentId,
      editionId: `fa:edition:${sourceKey(collection)}`,
      sourceOrdinal: story.sourceOrdinal,
      recordType:
        collection.id === "andersen-1597"
          ? "authored-literary-tale"
          : "published-folklore-text",
      title: displayTitle,
      language: "en",
      representedTradition: collection.tradition,
      representedRegion: collection.region,
      citation: {
        institution: "Project Gutenberg",
        collection: collection.title,
        sourceUrl: collection.sourceUrl,
        preferred: `${displayTitle}. In ${collection.title}, ${collection.editor}. Project Gutenberg #${collection.gutenbergId}.`,
      },
      captureId,
      sourceSpan,
      witnessIds: [stableWitnessId],
    });
    releaseWitnesses.push({
      schemaVersion: "folklore-witness-v1",
      id: stableWitnessId,
      documentId: stableDocumentId,
      kind:
        collection.id === "english-7439"
          ? "english-retelling"
          : "english-translation-or-retelling",
      language: "en",
      text: story.text,
      rawPath: `data/raw/gutenberg/${collection.file}`,
      rawSha256: rawEntry.sha256,
      sourceSpan,
      normalization: {
        method: "gutenberg-story-parser-v2",
        transformations: [
          "normalize CRLF to LF",
          "segment by declared TOC/body headings",
          "remove Project Gutenberg wrapper from derived text",
          "collapse runs of three or more blank lines",
        ],
      },
    });
    releaseSplits.push({
      schemaVersion: "folklore-split-v1",
      splitId: "fa:split:general-v1",
      documentId: stableDocumentId,
      groupId: stableDocumentId,
      split,
      assignmentMethod: "sha256-document-id-mod10-v1",
    });

    for (const legacyId of legacyIds) {
      releaseAliases.push({
        schemaVersion: "folklore-alias-v1",
        kind: "legacy-story-id",
        alias: legacyId,
        targetId: stableDocumentId,
        reason:
          story.title === "THE WEDDING OF MRS FOX"
            ? "Two former subsection records now resolve to their source parent document."
            : "Compatibility alias from the v0.2 reader identifier.",
      });
    }
    if (legacyIds.length === 0) {
      releaseAliases.push({
        schemaVersion: "folklore-alias-v1",
        kind: "legacy-story-id",
        alias: id,
        targetId: stableDocumentId,
        reason: "First compatible reader identifier for a recovered source document.",
      });
    }

    releaseLineage.push(
      {
        schemaVersion: "folklore-lineage-v1",
        outputId: stableDocumentId,
        outputKind: "document",
        inputIds: [captureId],
        method: "toc-body-segmentation-v2",
        methodVersion: "2.0.0",
        rawSha256: rawEntry.sha256,
        sourceSpan,
      },
      {
        schemaVersion: "folklore-lineage-v1",
        outputId: stableWitnessId,
        outputKind: "witness",
        inputIds: [stableDocumentId],
        method: "derived-reading-text-v1",
        methodVersion: "1.0.0",
        rawSha256: rawEntry.sha256,
        sourceSpan,
      },
    );

    passageSlices(story.text).forEach((passage, passageIndex) => {
      const stablePassageId = `fa:passage:${sourceKey(collection)}:toc-${pad(story.sourceOrdinal, 3)}:text-en:p${pad(passageIndex + 1, 4)}`;
      releasePassages.push({
        schemaVersion: "folklore-passage-v1",
        id: stablePassageId,
        documentId: stableDocumentId,
        witnessId: stableWitnessId,
        ordinal: passageIndex + 1,
        characterStart: passage.start,
        characterEnd: passage.end,
        text: passage.text,
        citationLabel: `${displayTitle}, passage ${passageIndex + 1}`,
      });
      releaseLineage.push({
        schemaVersion: "folklore-lineage-v1",
        outputId: stablePassageId,
        outputKind: "passage",
        inputIds: [stableWitnessId],
        method: "paragraph-window-v1",
        methodVersion: "1.0.0",
        rawSha256: rawEntry.sha256,
      });
    });
  });
}

const corpus = {
  schema: "atlas-story-v1",
  generatedAt: "2026-07-24",
  sourceNote:
    "Five complete Project Gutenberg editions split into their constituent stories. Editorial descriptions and concept tags are deterministic heuristics, not scholarly classifications.",
  checksum: "",
  collections: collectionSummaries,
  stories,
  aliases: releaseAliases.map(({ alias, targetId }) => ({ alias, targetId })),
};

corpus.checksum = createHash("sha256")
  .update(JSON.stringify({ collections: corpus.collections, stories: corpus.stories }))
  .digest("hex");

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`);

function compareById(left, right) {
  return String(left.id ?? left.outputId ?? left.alias).localeCompare(
    String(right.id ?? right.outputId ?? right.alias),
  );
}

const releaseArtifacts = new Map([
  ["captures.jsonl", jsonLines(releaseCaptures.sort(compareById))],
  ["editions.jsonl", jsonLines(releaseEditions.sort(compareById))],
  ["documents.jsonl", jsonLines(releaseDocuments.sort(compareById))],
  ["witnesses.jsonl", jsonLines(releaseWitnesses.sort(compareById))],
  ["passages.jsonl", jsonLines(releasePassages.sort(compareById))],
  [
    "splits.jsonl",
    jsonLines(
      releaseSplits.sort((left, right) =>
        left.documentId.localeCompare(right.documentId),
      ),
    ),
  ],
  ["aliases.jsonl", jsonLines(releaseAliases.sort(compareById))],
  ["lineage.jsonl", jsonLines(releaseLineage.sort(compareById))],
  ["duplicate-candidates.jsonl", ""],
  [
    "schema.json",
    await readFile(path.join(root, "schemas/corpus-release-v1.schema.json"), "utf8"),
  ],
  [
    "manifest.schema.json",
    await readFile(
      path.join(root, "schemas/release-manifest-v1.schema.json"),
      "utf8",
    ),
  ],
  [
    "dataset-card.md",
    await readFile(path.join(root, "docs/dataset-card-v0.1.md"), "utf8"),
  ],
  ["compatibility/folklore-corpus.json", `${JSON.stringify(corpus, null, 2)}\n`],
]);

await mkdir(path.join(releaseRoot, "compatibility"), { recursive: true });
for (const [relativePath, contents] of releaseArtifacts) {
  await writeFile(path.join(releaseRoot, relativePath), contents);
}

const splitCounts = Object.fromEntries(
  ["train", "validation", "test"].map((split) => [
    split,
    releaseSplits.filter((record) => record.split === split).length,
  ]),
);
const artifactManifest = [...releaseArtifacts].map(
  ([relativePath, contents]) => ({
    path: relativePath,
    byteLength: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
  }),
);
const releaseManifest = {
  schemaVersion: "folklore-release-manifest-v1",
  releaseId: "fa:release:corpus-v0.1.0",
  version: "0.1.0",
  publishedAt: "2026-07-24",
  producer: {
    repository: "wahhapen/folklore-corpus",
    commit: "e8cb8a3d60031c2e15eaa3b278ca6353208ecb39",
  },
  compiler: {
    command: "npm run build:corpus",
    parser: "gutenberg-story-parser-v2",
    node: ">=22.13.0",
  },
  counts: {
    captures: releaseCaptures.length,
    editions: releaseEditions.length,
    documents: releaseDocuments.length,
    witnesses: releaseWitnesses.length,
    passages: releasePassages.length,
    aliases: releaseAliases.length,
    lineageEvents: releaseLineage.length,
    splitAssignments: releaseSplits.length,
  },
  splitCounts,
  inputs: rawManifest.entries.map((entry) => ({
    path: `data/raw/gutenberg/${entry.file}`,
    sourceUrl: entry.sourceUrl,
    byteLength: entry.byteLength,
    sha256: entry.sha256,
  })),
  artifacts: artifactManifest,
};
await writeFile(
  path.join(releaseRoot, "manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);

console.log(
  `Built ${stories.length} documents and ${releasePassages.length} citable passages across ${collectionSummaries.length} collections: ${collectionSummaries.map((collection) => `${collection.id}=${collection.storyCount}`).join(", ")}`,
);
