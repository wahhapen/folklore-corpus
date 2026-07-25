import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

export class PinnedSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "PinnedSourceError";
  }
}

export async function resolveSafePath(root, requestedPath, {
  allowMissingLeaf = false,
} = {}) {
  if (
    typeof requestedPath !== "string"
    || requestedPath.length === 0
    || requestedPath === "."
    || requestedPath.includes("\\")
    || isAbsolute(requestedPath)
    || normalize(requestedPath) !== requestedPath
  ) {
    throw new PinnedSourceError("Pinned source path is required");
  }
  const rootPath = resolve(root);
  await mkdir(rootPath, { recursive: true });
  const destination = resolve(rootPath, requestedPath);
  const relativePath = relative(rootPath, destination);
  if (
    isAbsolute(relativePath)
    || relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
  ) {
    throw new PinnedSourceError(
      `Pinned source path escapes source root: ${requestedPath}`,
    );
  }

  const rootRealPath = await realpath(rootPath);
  const segments = relativePath.split(sep).filter(Boolean);
  let cursor = rootPath;
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (
        error.code === "ENOENT"
        && allowMissingLeaf
      ) {
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new PinnedSourceError(
        `Pinned source path contains a symlink: ${requestedPath}`,
      );
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new PinnedSourceError(
        `Pinned source parent is not a directory: ${requestedPath}`,
      );
    }
  }

  const existingParent = await realpath(
    segments.length > 1
      ? join(rootPath, ...segments.slice(0, -1))
      : rootPath,
  ).catch((error) => {
    if (allowMissingLeaf && error.code === "ENOENT") return rootRealPath;
    throw error;
  });
  const parentRelative = relative(rootRealPath, existingParent);
  if (
    isAbsolute(parentRelative)
    || parentRelative === ".."
    || parentRelative.startsWith(`..${sep}`)
  ) {
    throw new PinnedSourceError(
      `Pinned source real path escapes source root: ${requestedPath}`,
    );
  }
  return destination;
}

export async function openNoFollow(path, flags, mode = 0o600) {
  return open(path, flags | constants.O_NOFOLLOW, mode);
}
