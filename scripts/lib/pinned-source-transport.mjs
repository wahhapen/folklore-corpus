import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat } from "node:fs/promises";

import {
  openNoFollow,
  PinnedSourceError,
  resolveSafePath,
} from "./safe-path.mjs";

export { PinnedSourceError } from "./safe-path.mjs";

async function digestFile(path) {
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

export function createPinnedSourceTransport({ sourceRoot }) {
  return async function pinnedSourceTransport(request) {
    if (!/^[0-9a-f]{64}$/.test(request?.expectedSha256 ?? "")) {
      throw new PinnedSourceError(
        `Expected SHA-256 is missing for ${request?.uri ?? "source"}`,
      );
    }
    if (
      !Number.isSafeInteger(request?.expectedByteLength)
      || request.expectedByteLength < 0
    ) {
      throw new PinnedSourceError(
        `Expected byte length is missing for ${request?.uri ?? "source"}`,
      );
    }
    let sourcePath;
    try {
      sourcePath = await resolveSafePath(
        sourceRoot,
        request.sourcePath,
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new PinnedSourceError(
          `Pinned source is missing: ${request.sourcePath}`,
        );
      }
      throw error;
    }
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new PinnedSourceError(
          `Pinned source is missing: ${request.sourcePath}`,
        );
      }
      throw error;
    }
    if (!sourceStat.isFile()) {
      throw new PinnedSourceError(
        `Pinned source is not a regular file: ${request.sourcePath}`,
      );
    }
    if (sourceStat.size !== request.expectedByteLength) {
      throw new PinnedSourceError(
        `Byte length mismatch for ${request.sourcePath}: ` +
        `${sourceStat.size} != ${request.expectedByteLength}`,
      );
    }
    const actualDigest = await digestFile(sourcePath);
    if (actualDigest !== request.expectedSha256) {
      throw new PinnedSourceError(
        `SHA-256 mismatch for ${request.sourcePath}: ` +
        `${actualDigest} != ${request.expectedSha256}`,
      );
    }
    return {
      body: (async function* readPinnedFile() {
        const file = await openNoFollow(sourcePath, constants.O_RDONLY);
        try {
          for await (const chunk of file.createReadStream({
            autoClose: false,
          })) {
            yield chunk;
          }
        } finally {
          await file.close();
        }
      })(),
      responseMetadata: {
        status: 200,
        headers: {
          "content-length": String(sourceStat.size),
          "content-type": request.mediaType,
        },
      },
    };
  };
}
