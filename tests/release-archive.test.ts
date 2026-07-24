import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  packRelease,
  verifyReleaseArchive,
} from "../scripts/lib/release-archive.mjs";

const releaseRoot = resolve("data/derived/releases/corpus-v0.1.0");

describe("Corpus Release archive boundary", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("packs identical release contents into one deterministic verified archive", async () => {
    const firstOutput = await mkdtemp(join(tmpdir(), "folklore-pack-a-"));
    const secondOutput = await mkdtemp(join(tmpdir(), "folklore-pack-b-"));
    temporaryDirectories.push(firstOutput, secondOutput);

    const first = await packRelease({ releaseRoot, outputRoot: firstOutput });
    const second = await packRelease({ releaseRoot, outputRoot: secondOutput });

    expect(first.archiveSha256).toBe(second.archiveSha256);
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(await readFile(first.checksumPath, "utf8")).toBe(
      `${first.archiveSha256}  folklore-corpus-v0.1.0.tar.gz\n`,
    );

    const verified = await verifyReleaseArchive({
      archivePath: first.archivePath,
      expectedArchiveSha256: first.archiveSha256,
      expectedManifestSha256: first.manifestSha256,
    });
    expect(verified.releaseId).toBe("fa:release:corpus-v0.1.0");
    expect(verified.artifactCount).toBe(13);
  }, 30_000);

  it("rejects changed archive bytes before extraction", async () => {
    const output = await mkdtemp(join(tmpdir(), "folklore-pack-tamper-"));
    temporaryDirectories.push(output);
    const packed = await packRelease({ releaseRoot, outputRoot: output });
    const changed = Buffer.concat([
      await readFile(packed.archivePath),
      Buffer.from("changed"),
    ]);
    await writeFile(packed.archivePath, changed);

    await expect(
      verifyReleaseArchive({
        archivePath: packed.archivePath,
        expectedArchiveSha256: packed.archiveSha256,
      }),
    ).rejects.toThrow("Archive digest mismatch");
  }, 30_000);
});
