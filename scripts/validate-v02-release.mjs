import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

const run = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function jsonLines(path) {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function unique(records, key, label) {
  const values = records.map((record) => record[key]);
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}`);
  }
}

function requireCount(manifest, key, records) {
  if (manifest.counts[key] !== records.length) {
    throw new Error(
      `Manifest count mismatch for ${key}: ` +
      `${manifest.counts[key]} != ${records.length}`,
    );
  }
}

export async function validateV02Release({
  releaseRoot,
  checkProducer = true,
}) {
  const root = resolve(releaseRoot);
  const manifest = await json(join(root, "manifest.json"));
  const manifestSchema = await json(join(root, "manifest.schema.json"));
  const recordSchema = await json(join(root, "schema.json"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateManifest = ajv.compile(manifestSchema);
  if (!validateManifest(manifest)) {
    throw new Error(
      `Manifest schema mismatch: ${JSON.stringify(validateManifest.errors)}`,
    );
  }
  if (
    manifest.version !== "0.2.0"
    || manifest.releaseId !== "fa:release:corpus-v0.2.0"
  ) {
    throw new Error("Unexpected v0.2 Release identity");
  }
  if (checkProducer) {
    const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    if (head.trim() !== manifest.producer.commit) {
      throw new Error("Producer commit does not equal checked-out HEAD");
    }
    await run(
      "git",
      ["cat-file", "-e", `${manifest.producer.commit}^{commit}`],
      { cwd: repositoryRoot },
    );
    const { stdout: status } = await run(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    if (status.trim()) {
      throw new Error("Producer worktree is not clean");
    }
  }

  const artifactByPath = new Map();
  for (const artifact of manifest.artifacts) {
    if (artifactByPath.has(artifact.path)) {
      throw new Error(`Duplicate manifest Artifact: ${artifact.path}`);
    }
    artifactByPath.set(artifact.path, artifact);
    const path = join(root, artifact.path);
    const metadata = await stat(path);
    if (metadata.size !== artifact.byteLength) {
      throw new Error(`Artifact byte length mismatch: ${artifact.path}`);
    }
    if (await sha256File(path) !== artifact.sha256) {
      throw new Error(`Artifact digest mismatch: ${artifact.path}`);
    }
  }

  const files = {
    captures: await jsonLines(join(root, "captures.jsonl")),
    editions: await jsonLines(join(root, "editions.jsonl")),
    documents: await jsonLines(join(root, "documents.jsonl")),
    witnesses: await jsonLines(join(root, "witnesses.jsonl")),
    passages: await jsonLines(join(root, "passages.jsonl")),
    aliases: await jsonLines(join(root, "aliases.jsonl")),
    lineageEvents: await jsonLines(join(root, "lineage.jsonl")),
    splitAssignments: await jsonLines(join(root, "splits.jsonl")),
    representations: await jsonLines(join(root, "representations.jsonl")),
    derivations: await jsonLines(join(root, "derivations.jsonl")),
    rightsAssessments: await jsonLines(join(root, "rights.jsonl")),
  };
  const validateRecord = new Ajv2020({
    allErrors: true,
    strict: false,
  }).compile(recordSchema);
  for (const records of Object.values(files)) {
    for (const record of records) {
      if (!validateRecord(record)) {
        throw new Error(
          `Record schema mismatch for ` +
          `${record.id ?? record.outputId ?? record.alias}: ` +
          JSON.stringify(validateRecord.errors),
        );
      }
    }
  }
  for (const [key, records] of Object.entries(files)) {
    requireCount(manifest, key, records);
  }
  for (const [key, records] of Object.entries(files)) {
    const idKey = key === "lineageEvents"
      ? "outputId"
      : key === "splitAssignments"
        ? "documentId"
        : key === "aliases"
          ? "alias"
          : "id";
    unique(records, idKey, `${key} identity`);
  }

  const captureIds = new Set(files.captures.map(({ id }) => id));
  const editionIds = new Set(files.editions.map(({ id }) => id));
  const documentIds = new Set(files.documents.map(({ id }) => id));
  const witnessIds = new Set(files.witnesses.map(({ id }) => id));
  const representationIds = new Set(
    files.representations.map(({ id }) => id),
  );
  const derivationIds = new Set(files.derivations.map(({ id }) => id));
  const manifestDigests = new Set(
    manifest.artifacts.map(({ sha256 }) => sha256),
  );
  const artifactIds = new Set(
    [...manifestDigests].map((digest) => `fa:artifact:sha256-${digest}`),
  );

  for (const capture of files.captures) {
    const artifact = artifactByPath.get(capture.rawPath);
    if (
      !artifact
      || artifact.sha256 !== capture.rawSha256
      || artifact.byteLength !== capture.byteLength
    ) {
      throw new Error(`Capture Artifact mismatch: ${capture.id}`);
    }
  }
  for (const edition of files.editions) {
    if (!captureIds.has(edition.captureId)) {
      throw new Error(`Missing Capture for Edition: ${edition.id}`);
    }
  }
  for (const document of files.documents) {
    if (
      !editionIds.has(document.editionId)
      || !captureIds.has(document.captureId)
      || !document.witnessIds.every((id) => witnessIds.has(id))
    ) {
      throw new Error(`Broken Document references: ${document.id}`);
    }
  }
  for (const witness of files.witnesses) {
    if (
      !documentIds.has(witness.documentId)
      || !artifactByPath.has(witness.rawPath)
      || artifactByPath.get(witness.rawPath).sha256 !== witness.rawSha256
    ) {
      throw new Error(`Broken Witness evidence: ${witness.id}`);
    }
  }
  for (const passage of files.passages) {
    if (
      !documentIds.has(passage.documentId)
      || !witnessIds.has(passage.witnessId)
    ) {
      throw new Error(`Broken Passage references: ${passage.id}`);
    }
  }
  for (const representation of files.representations) {
    const artifact = artifactByPath.get(representation.artifactPath);
    if (
      !witnessIds.has(representation.witnessId)
      || !derivationIds.has(representation.derivationId)
      || !artifact
      || artifact.sha256 !== representation.artifactSha256
      || artifact.byteLength !== representation.byteLength
    ) {
      throw new Error(
        `Broken Representation evidence: ${representation.id}`,
      );
    }
  }
  for (const derivation of files.derivations) {
    if (
      !derivation.outputIds.length
      || !derivation.outputIds.every((id) =>
        representationIds.has(id) || artifactIds.has(id)
      )
    ) {
      throw new Error(`Broken Derivation outputs: ${derivation.id}`);
    }
  }
  for (const rights of files.rightsAssessments) {
    const evidenceDigest = rights.evidenceArtifactId.split(
      "fa:artifact:sha256-",
    )[1];
    if (
      rights.reviewState !== "accepted"
      || rights.redistributionAllowed !== true
      || rights.mlUseAllowed !== true
      || !manifestDigests.has(evidenceDigest)
    ) {
      throw new Error(`Fail-closed Rights mismatch: ${rights.id}`);
    }
  }

  const skvr = files.passages.filter(({ id }) =>
    id.startsWith("fa:passage:skvr:")
  );
  const librivox = files.passages.filter(({ id }) =>
    id.startsWith(
      "fa:passage:librivox-celtic-fairy-tales-1837:",
    )
  );
  if (skvr.length !== 100 || librivox.length !== 27) {
    throw new Error("Collection slice cardinality mismatch");
  }
  for (const passage of librivox) {
    if (
      passage.contentStatus !== "metadata-only-no-transcript"
      || passage.selector?.type !== "AudioTimeSelector"
      || passage.selector.startSeconds !== 0
      || !(passage.selector.endSeconds > 0)
    ) {
      throw new Error(`Unsupported LibriVox text claim: ${passage.id}`);
    }
  }

  const gate = await json(join(root, "gate-report.json"));
  if (
    gate.producerCommit !== manifest.producer.commit
    || gate.releaseRights.redistributionGaps !== 0
    || gate.releaseRights.mlUseGaps !== 0
    || gate.collectionGates.skvr.selectedRecords !== 100
    || gate.collectionGates.librivox.selectedSections !== 27
    || gate.collectionGates.librivox.totalDurationSeconds !== 23262
    || Object.values(gate.collectionGates).some((collection) =>
      Object.entries(collection).some(([key, value]) =>
        key.endsWith("Gaps") && value !== 0
      )
    )
  ) {
    throw new Error("Machine-readable gate report mismatch");
  }
  return {
    releaseId: manifest.releaseId,
    version: manifest.version,
    producerCommit: manifest.producer.commit,
    documentCount: files.documents.length,
    passageCount: files.passages.length,
    representationCount: files.representations.length,
    artifactCount: manifest.artifacts.length,
    rightsAssessmentCount: files.rightsAssessments.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await validateV02Release({
    releaseRoot: resolve(option(
      "--release",
      join(repositoryRoot, "build/releases/corpus-v0.2.0"),
    )),
    checkProducer: !process.argv.includes("--skip-producer-check"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
