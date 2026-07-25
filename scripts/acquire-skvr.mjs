import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultLockPath = join(
  repositoryRoot,
  "data/skvr/i1-source.lock.json",
);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function resolveInside(root, requestedPath) {
  const rootPath = resolve(root);
  const sourcePath = resolve(rootPath, requestedPath);
  const relativePath = relative(rootPath, sourcePath);
  if (
    isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(`SKVR source path escapes cache root: ${requestedPath}`);
  }
  return sourcePath;
}

async function digest(path) {
  const bytes = await readFile(path);
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function verify(path, source) {
  try {
    const sourceStat = await stat(path);
    if (!sourceStat.isFile() || sourceStat.size !== source.byteLength) {
      return false;
    }
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return (await digest(path)).sha256 === source.sha256;
}

async function installBytes(path, bytes, source) {
  if (
    bytes.byteLength !== source.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== source.sha256
  ) {
    throw new Error(`Pinned bytes do not match ${source.sourcePath}`);
  }
  await mkdir(dirname(path), { recursive: true });
  const partialPath = `${path}.part`;
  const file = await open(partialPath, "w");
  try {
    await file.write(bytes);
  } finally {
    await file.close();
  }
  await rename(partialPath, path);
}

async function acquireHttp(path, source, fetchImpl = fetch) {
  if (await verify(path, source)) return "verified-cache";
  const partialPath = `${path}.part`;
  await unlink(partialPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await mkdir(dirname(path), { recursive: true });
  const response = await fetchImpl(source.uri);
  if (!response.ok || !response.body) {
    throw new Error(
      `SKVR acquisition failed with HTTP ${response.status}: ${source.uri}`,
    );
  }
  const file = await open(partialPath, "wx");
  const hash = createHash("sha256");
  let byteLength = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk);
      byteLength += chunk.byteLength;
      await file.write(chunk);
    }
  } catch (error) {
    await file.close();
    await unlink(partialPath).catch(() => {});
    throw error;
  }
  await file.close();
  const actualSha256 = hash.digest("hex");
  if (
    byteLength !== source.byteLength
    || actualSha256 !== source.sha256
  ) {
    await unlink(partialPath);
    throw new Error(
      `SKVR acquisition digest mismatch for ${source.sourcePath}`,
    );
  }
  await rename(partialPath, path);
  return "downloaded";
}

export async function acquireSkvr({
  sourceRoot,
  lockPath = defaultLockPath,
  fetchImpl = fetch,
}) {
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const events = [];
  for (const key of ["volume", "readme"]) {
    const source = lock.sources[key];
    const path = resolveInside(sourceRoot, source.sourcePath);
    const status = await acquireHttp(path, source, fetchImpl);
    events.push({ source: key, status, path });
  }
  const reviewSource = lock.sources.rightsReview;
  const reviewPath = resolveInside(sourceRoot, reviewSource.sourcePath);
  if (await verify(reviewPath, reviewSource)) {
    events.push({
      source: "rightsReview",
      status: "verified-cache",
      path: reviewPath,
    });
  } else {
    const bytes = await readFile(
      join(repositoryRoot, "data/skvr/rights-review-fi.json"),
    );
    await installBytes(reviewPath, bytes, reviewSource);
    events.push({
      source: "rightsReview",
      status: "installed",
      path: reviewPath,
    });
  }
  return events;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sourceRoot = resolve(
    argument("--source-root", "source-cache/skvr-i1"),
  );
  const events = await acquireSkvr({
    sourceRoot,
    lockPath: resolve(argument("--lock", defaultLockPath)),
  });
  for (const event of events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}
