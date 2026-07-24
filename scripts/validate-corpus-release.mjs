import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

const run = promisify(execFile);
const root = process.cwd();
const releaseRoot = path.join(root, "data/derived/releases/corpus-v0.1.0");

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function parseJsonLines(contents) {
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const manifestPath = path.join(releaseRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const before = new Map();

for (const artifact of manifest.artifacts) {
  const contents = await readFile(path.join(releaseRoot, artifact.path));
  if (contents.byteLength !== artifact.byteLength) {
    throw new Error(`Byte length mismatch: ${artifact.path}`);
  }
  if (sha256(contents) !== artifact.sha256) {
    throw new Error(`Digest mismatch: ${artifact.path}`);
  }
  before.set(artifact.path, contents);
}
before.set("manifest.json", await readFile(manifestPath));

const rawBySha256 = new Map();
for (const input of manifest.inputs) {
  const contents = await readFile(path.join(root, input.path));
  if (contents.byteLength !== input.byteLength || sha256(contents) !== input.sha256) {
    throw new Error(`Raw capture mismatch: ${input.path}`);
  }
  rawBySha256.set(input.sha256, contents);
}

const documents = parseJsonLines(
  await readFile(path.join(releaseRoot, "documents.jsonl"), "utf8"),
);
const captures = parseJsonLines(
  await readFile(path.join(releaseRoot, "captures.jsonl"), "utf8"),
);
const editions = parseJsonLines(
  await readFile(path.join(releaseRoot, "editions.jsonl"), "utf8"),
);
const witnesses = parseJsonLines(
  await readFile(path.join(releaseRoot, "witnesses.jsonl"), "utf8"),
);
const passages = parseJsonLines(
  await readFile(path.join(releaseRoot, "passages.jsonl"), "utf8"),
);
const splits = parseJsonLines(
  await readFile(path.join(releaseRoot, "splits.jsonl"), "utf8"),
);
const aliases = parseJsonLines(
  await readFile(path.join(releaseRoot, "aliases.jsonl"), "utf8"),
);
const lineage = parseJsonLines(
  await readFile(path.join(releaseRoot, "lineage.jsonl"), "utf8"),
);

const schema = JSON.parse(
  await readFile(path.join(releaseRoot, "schema.json"), "utf8"),
);
const validateSchema = new Ajv2020({ allErrors: true }).compile(schema);
for (const record of [
  ...captures,
  ...editions,
  ...documents,
  ...witnesses,
  ...passages,
  ...splits,
  ...aliases,
  ...lineage,
]) {
  if (!validateSchema(record)) {
    throw new Error(
      `Schema validation failed for ${record.id ?? record.outputId ?? record.alias}: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
}

function requireUnique(records, key, label) {
  const values = records.map((record) => record[key]);
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}`);
  }
}

requireUnique(captures, "id", "capture ID");
requireUnique(editions, "id", "edition ID");
requireUnique(documents, "id", "document ID");
requireUnique(witnesses, "id", "witness ID");
requireUnique(passages, "id", "passage ID");
requireUnique(splits, "documentId", "split assignment");
requireUnique(aliases, "alias", "compatibility alias");
requireUnique(lineage, "outputId", "lineage output");

const captureIds = new Set(captures.map((record) => record.id));
const editionIds = new Set(editions.map((record) => record.id));
const documentIds = new Set(documents.map((record) => record.id));
const witnessIds = new Set(witnesses.map((record) => record.id));
const lineageIds = new Set(lineage.map((record) => record.outputId));

for (const edition of editions) {
  if (!captureIds.has(edition.captureId)) {
    throw new Error(`Missing capture for edition ${edition.id}`);
  }
}
for (const document of documents) {
  if (
    !editionIds.has(document.editionId) ||
    !captureIds.has(document.captureId) ||
    document.witnessIds.length !== 1 ||
    !document.witnessIds.every((id) => witnessIds.has(id)) ||
    !lineageIds.has(document.id)
  ) {
    throw new Error(`Incomplete document references ${document.id}`);
  }
}
for (const witness of witnesses) {
  if (!documentIds.has(witness.documentId) || !lineageIds.has(witness.id)) {
    throw new Error(`Incomplete witness references ${witness.id}`);
  }
  const raw = rawBySha256.get(witness.rawSha256);
  if (!raw) throw new Error(`Missing raw capture for witness ${witness.id}`);
  const { rawByteStart, rawByteEnd, rawSliceSha256 } = witness.sourceSpan;
  if (
    rawByteStart < 0 ||
    rawByteEnd > raw.byteLength ||
    rawByteStart >= rawByteEnd ||
    sha256(raw.subarray(rawByteStart, rawByteEnd)) !== rawSliceSha256
  ) {
    throw new Error(`Raw source span mismatch for witness ${witness.id}`);
  }
}
for (const passage of passages) {
  if (
    !documentIds.has(passage.documentId) ||
    !witnessIds.has(passage.witnessId) ||
    !lineageIds.has(passage.id)
  ) {
    throw new Error(`Broken passage reference ${passage.id}`);
  }
  const witness = witnesses.find((record) => record.id === passage.witnessId);
  if (
    witness.text.slice(passage.characterStart, passage.characterEnd) !==
    passage.text
  ) {
    throw new Error(`Passage offset/text mismatch ${passage.id}`);
  }
}
for (const split of splits) {
  if (!documentIds.has(split.documentId)) {
    throw new Error(`Missing split document ${split.documentId}`);
  }
}
for (const alias of aliases) {
  if (!documentIds.has(alias.targetId)) {
    throw new Error(`Missing alias target ${alias.alias}`);
  }
}

const actualCounts = {
  captures: captures.length,
  editions: editions.length,
  documents: documents.length,
  witnesses: witnesses.length,
  passages: passages.length,
  aliases: aliases.length,
  lineageEvents: lineage.length,
  splitAssignments: splits.length,
};
for (const [key, value] of Object.entries(actualCounts)) {
  if (manifest.counts[key] !== value) {
    throw new Error(`Manifest count mismatch for ${key}`);
  }
}

await run(process.execPath, ["scripts/build-folklore-corpus.mjs"], { cwd: root });
for (const [relativePath, expected] of before) {
  const actual = await readFile(path.join(releaseRoot, relativePath));
  if (!actual.equals(expected)) {
    throw new Error(`Non-deterministic rebuild: ${relativePath}`);
  }
}

console.log(
  `Validated schema, unique identities, ${documents.length} documents, ${passages.length} exact passage slices, raw source spans, complete references, and byte-identical rebuild.`,
);
