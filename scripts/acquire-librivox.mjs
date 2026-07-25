import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  openNoFollow,
  PinnedSourceError,
  resolveSafePath,
} from "./lib/safe-path.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultLockPath = join(
  repositoryRoot,
  "data/librivox/book-1837.lock.json",
);
const defaultSourceRoot = join(repositoryRoot, "source-cache/librivox");

async function sha256File(path) {
  const digest = createHash("sha256");
  const file = await openNoFollow(path, constants.O_RDONLY);
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      digest.update(chunk);
    }
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

async function verifySource(path, source) {
  let sourceStat;
  try {
    sourceStat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (
    sourceStat.isSymbolicLink()
    || !sourceStat.isFile()
    || sourceStat.size !== source.byteLength
  ) {
    return false;
  }
  return await sha256File(path) === source.sha256;
}

async function copyCommittedEvidence({ source, destination }) {
  const committedEvidence = source.uri
    === "urn:folklore:rights-review:librivox-1837-us-v1"
    ? join(repositoryRoot, "data/librivox/rights-review-us.json")
    : source.uri === "urn:folklore:rights-review:gutenberg-seed-us-v1"
    ? join(repositoryRoot, "data/gutenberg/rights-review-us.json")
    : null;
  if (committedEvidence == null) {
    throw new PinnedSourceError(
      `Unsupported committed evidence URI: ${source.uri}`,
    );
  }
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  const bytes = await readFile(committedEvidence);
  const file = await openNoFollow(
    partial,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
  );
  try {
    await file.write(bytes);
  } finally {
    await file.close();
  }
  await rename(partial, destination);
  if (!(await verifySource(destination, source))) {
    throw new PinnedSourceError(
      "Committed rights evidence does not match the release lock",
    );
  }
}

export async function acquireLockedSource({
  source,
  sourceRoot,
  fetchImpl = fetch,
}) {
  let destination = await resolveSafePath(sourceRoot, source.path, {
    allowMissingLeaf: true,
  });
  if (await verifySource(destination, source)) {
    return { path: destination, status: "verified-cache" };
  }
  if (source.uri.startsWith("urn:folklore:rights-review:")) {
    await copyCommittedEvidence({ source, destination });
    return { path: destination, status: "copied-review" };
  }
  const sourceUrl = new URL(source.uri);
  if (!["http:", "https:"].includes(sourceUrl.protocol)) {
    throw new PinnedSourceError(
      `Unsupported source protocol: ${sourceUrl.protocol}`,
    );
  }

  await mkdir(dirname(destination), { recursive: true });
  destination = await resolveSafePath(sourceRoot, source.path, {
    allowMissingLeaf: true,
  });
  const partial = `${destination}.part`;
  let offset = 0;
  try {
    const partialStat = await lstat(partial);
    if (partialStat.isSymbolicLink() || !partialStat.isFile()) {
      throw new PinnedSourceError(
        `Partial source is not a regular file: ${source.path}.part`,
      );
    }
    offset = partialStat.size;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (offset === source.byteLength) {
    if (await verifySource(partial, source)) {
      await rename(partial, destination);
      return { path: destination, status: "resumed-download" };
    }
    await unlink(partial);
    offset = 0;
  } else if (offset > source.byteLength) {
    await unlink(partial);
    offset = 0;
  }

  const headers = offset > 0 ? { range: `bytes=${offset}-` } : {};
  const response = await fetchImpl(source.uri, { headers });
  if (!response.ok) {
    throw new PinnedSourceError(
      `Source request failed (${response.status}) for ${source.uri}`,
    );
  }
  const append = offset > 0 && response.status === 206;
  if (append) {
    const contentRange = response.headers.get("content-range");
    if (!contentRange?.startsWith(`bytes ${offset}-`)) {
      throw new PinnedSourceError(
        `Invalid Content-Range while resuming ${source.uri}`,
      );
    }
  }
  if (offset > 0 && !append) offset = 0;
  if (!response.body) {
    throw new PinnedSourceError(`Source response has no body: ${source.uri}`);
  }
  const flags = append
    ? constants.O_WRONLY | constants.O_APPEND
    : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
  const partialFile = await openNoFollow(partial, flags);
  try {
    for await (const value of response.body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      await partialFile.write(chunk);
    }
  } finally {
    await partialFile.close();
  }
  if (!(await verifySource(partial, source))) {
    throw new PinnedSourceError(
      `Downloaded source does not match lock: ${source.path}`,
    );
  }
  await rename(partial, destination);
  return {
    path: destination,
    status: append ? "resumed-download" : "downloaded",
  };
}

export async function acquireLibriVoxSources({
  lockPath = defaultLockPath,
  sourceRoot = defaultSourceRoot,
  fetchImpl = fetch,
} = {}) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const sources = [
    ...Object.values(lock.sources),
    ...lock.sections.map(({ media }) => media),
  ];
  const results = [];
  for (const source of sources) {
    results.push(await acquireLockedSource({
      source,
      sourceRoot,
      fetchImpl,
    }));
  }
  return results;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await acquireLibriVoxSources({
    lockPath: argument("--lock", defaultLockPath),
    sourceRoot: argument("--source-root", defaultSourceRoot),
  });
  const counts = Object.groupBy(results, ({ status }) => status);
  process.stdout.write(`${JSON.stringify({
    sources: results.length,
    statuses: Object.fromEntries(
      Object.entries(counts).map(([key, values]) => [key, values.length]),
    ),
  })}\n`);
}
