import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  packRelease,
  verifyReleaseArchive,
} from "./lib/release-archive.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const command = process.argv[2];

if (command === "pack") {
  const releaseRoot = option(
    "--release",
    "build/releases/corpus-v0.2.0",
  );
  const outputRoot = option("--output", "dist");
  const result = await packRelease({ releaseRoot, outputRoot });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "verify") {
  const archivePath = option("--archive");
  if (!archivePath) throw new Error("--archive is required");
  let archiveSha256 = option("--archive-sha256");
  if (!archiveSha256) {
    const checksum = await readFile(`${archivePath}.sha256`, "utf8");
    const [digest, filename] = checksum.trim().split(/\s+/);
    if (
      !/^[a-f0-9]{64}$/.test(digest)
      || filename !== path.basename(archivePath)
    ) {
      throw new Error("Invalid archive SHA-256 sidecar");
    }
    archiveSha256 = digest;
  }
  const result = await verifyReleaseArchive({
    archivePath,
    expectedArchiveSha256: archiveSha256,
    expectedManifestSha256: option("--manifest-sha256"),
  });
  console.log(JSON.stringify(result, null, 2));
} else if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  throw new Error("Expected command: pack or verify");
}
