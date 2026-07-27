import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { buildReleaseCandidate } from "./build-release-candidate.mjs";
import { validateReleaseCandidate } from "./validate-release-candidate.mjs";

const run = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);

const validationRoot = await mkdtemp(
  join(tmpdir(), "folklore-corpus-v03-validate-"),
);

try {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const producerCommit = stdout.trim();
  const build = await buildReleaseCandidate({
    outputRoot: join(validationRoot, "catalogue"),
    skvrSourceRoot: join(repositoryRoot, "source-cache/skvr-i1"),
    librivoxSourceRoot: join(repositoryRoot, "source-cache/librivox"),
    releaseRoot: join(validationRoot, "release"),
    producerCommit,
  });
  const validation = await validateReleaseCandidate({
    releaseRoot: join(validationRoot, "release"),
  });
  process.stdout.write(`${JSON.stringify({ build, validation }, null, 2)}\n`);
} finally {
  await rm(validationRoot, { recursive: true, force: true });
}
