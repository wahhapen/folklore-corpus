import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

const run = promisify(execFile);
const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestSchemaPath = join(
  moduleRoot,
  "schemas/release-manifest-v1.schema.json",
);
const maxArchiveBuffer = 128 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function gzipToFile(inputPath, outputPath) {
  const output = await open(outputPath, "w");
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        "gzip",
        ["-n", "-9", "-c", inputPath],
        {
          stdio: ["ignore", output.fd, "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", rejectPromise);
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(new Error(
            `gzip failed (${code ?? signal}): ${stderr.trim()}`,
          ));
        }
      });
    });
  } finally {
    await output.close();
  }
}

function assertSafeRelativePath(path) {
  const segments = path.split("/");
  if (
    !path
    || path.startsWith("/")
    || path.includes("\\")
    || segments.some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
}

async function readValidatedManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Release manifest is not valid JSON");
  }

  const schema = JSON.parse(await readFile(manifestSchemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    throw new Error(
      `Release manifest schema mismatch: ${JSON.stringify(validate.errors)}`,
    );
  }
  const expectedReleaseId = `fa:release:corpus-v${manifest.version}`;
  if (manifest.releaseId !== expectedReleaseId) {
    throw new Error(
      `Release identity mismatch: expected ${expectedReleaseId}`,
    );
  }

  const artifactPaths = manifest.artifacts.map((artifact) => artifact.path);
  for (const path of artifactPaths) assertSafeRelativePath(path);
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error("Release manifest contains duplicate artifact paths");
  }
  return manifest;
}

async function archiveEntries(archivePath) {
  const [{ stdout: namesOutput }, { stdout: verboseOutput }] = await Promise.all([
    run("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      maxBuffer: maxArchiveBuffer,
    }),
    run("tar", ["-tvzf", archivePath], {
      encoding: "utf8",
      maxBuffer: maxArchiveBuffer,
    }),
  ]);
  const names = namesOutput.split("\n").filter(Boolean);
  const verbose = verboseOutput.split("\n").filter(Boolean);
  if (names.length !== verbose.length) {
    throw new Error("Archive listing is inconsistent");
  }
  for (let index = 0; index < names.length; index += 1) {
    assertSafeRelativePath(names[index]);
    if (!verbose[index].startsWith("-")) {
      throw new Error(`Archive entry is not a regular file: ${names[index]}`);
    }
  }
  if (new Set(names).size !== names.length) {
    throw new Error("Archive contains duplicate paths");
  }
  return names;
}

export async function packRelease({ releaseRoot, outputRoot }) {
  const absoluteReleaseRoot = resolve(releaseRoot);
  const absoluteOutputRoot = resolve(outputRoot);
  const manifestBytes = await readFile(
    join(absoluteReleaseRoot, "manifest.json"),
  );
  const manifest = await readValidatedManifest(manifestBytes);
  const files = [
    "manifest.json",
    ...manifest.artifacts.map((artifact) => artifact.path),
  ].sort();
  const archiveName = `folklore-corpus-v${manifest.version}.tar.gz`;
  const archivePath = join(absoluteOutputRoot, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  await mkdir(absoluteOutputRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(
    join(absoluteOutputRoot, ".release-pack-"),
  );
  const tarPath = join(temporaryRoot, "release.tar");

  try {
    await run(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=ustar",
        "-C",
        absoluteReleaseRoot,
        "-cf",
        tarPath,
        ...files,
      ],
      { maxBuffer: maxArchiveBuffer },
    );
    await gzipToFile(tarPath, archivePath);
    const archiveSha256 = await sha256File(archivePath);
    await writeFile(
      checksumPath,
      `${archiveSha256}  ${archiveName}\n`,
      "utf8",
    );
    return {
      archivePath,
      checksumPath,
      archiveSha256,
      manifestSha256: sha256(manifestBytes),
      releaseId: manifest.releaseId,
      version: manifest.version,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function verifyReleaseArchive({
  archivePath,
  expectedArchiveSha256,
  expectedManifestSha256,
}) {
  if (!expectedArchiveSha256) {
    throw new Error("Expected archive SHA-256 is required");
  }
  const absoluteArchivePath = resolve(archivePath);
  const archiveDigest = await sha256File(absoluteArchivePath);
  if (
    expectedArchiveSha256
    && archiveDigest !== expectedArchiveSha256
  ) {
    throw new Error(
      `Archive digest mismatch: expected ${expectedArchiveSha256}, got ${archiveDigest}`,
    );
  }

  const entries = await archiveEntries(absoluteArchivePath);
  if (!entries.includes("manifest.json")) {
    throw new Error("Archive is missing manifest.json");
  }
  const { stdout: manifestBytes } = await run(
    "tar",
    ["-xOzf", absoluteArchivePath, "manifest.json"],
    { encoding: "buffer", maxBuffer: maxArchiveBuffer },
  );
  const manifestDigest = sha256(manifestBytes);
  if (
    expectedManifestSha256
    && manifestDigest !== expectedManifestSha256
  ) {
    throw new Error(
      `Manifest digest mismatch: expected ${expectedManifestSha256}, got ${manifestDigest}`,
    );
  }
  const manifest = await readValidatedManifest(manifestBytes);
  const expectedEntries = [
    "manifest.json",
    ...manifest.artifacts.map((artifact) => artifact.path),
  ].sort();
  if (JSON.stringify([...entries].sort()) !== JSON.stringify(expectedEntries)) {
    throw new Error("Archive entries do not exactly match the manifest");
  }

  const extractionRoot = await mkdtemp(
    join(tmpdir(), "folklore-release-verify-"),
  );
  try {
    await run(
      "tar",
      [
        "-xzf",
        absoluteArchivePath,
        "-C",
        extractionRoot,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      { maxBuffer: maxArchiveBuffer },
    );
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(join(extractionRoot, artifact.path));
      if (bytes.byteLength !== artifact.byteLength) {
        throw new Error(`Artifact byte length mismatch: ${artifact.path}`);
      }
      if (sha256(bytes) !== artifact.sha256) {
        throw new Error(`Artifact digest mismatch: ${artifact.path}`);
      }
    }
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }

  return {
    releaseId: manifest.releaseId,
    version: manifest.version,
    archiveSha256: archiveDigest,
    manifestSha256: manifestDigest,
    artifactCount: manifest.artifacts.length,
    archiveName: basename(absoluteArchivePath),
  };
}
