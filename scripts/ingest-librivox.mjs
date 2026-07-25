import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { createLibriVoxAdapter } from "./adapters/librivox.mjs";
import { ingestCollection } from "./lib/collection-ingestion.mjs";
import { createPinnedSourceTransport } from "./lib/pinned-source-transport.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultLockPath = join(
  repositoryRoot,
  "data/librivox/book-1837.lock.json",
);

export async function ingestLibriVox({
  database,
  artifactRoot,
  sourceRoot,
  lockPath = defaultLockPath,
}) {
  const lockBytes = await readFile(lockPath);
  const lock = JSON.parse(lockBytes);
  const lockSha256 = createHash("sha256")
    .update(lockBytes)
    .digest("hex");
  return ingestCollection({
    database,
    artifactRoot,
    adapter: createLibriVoxAdapter(lock),
    captureTransport: createPinnedSourceTransport({ sourceRoot }),
    request: {
      lockSha256,
      bookId: "1837",
    },
  });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalogueRoot = resolve(argument(
    "--catalogue-root",
    join(repositoryRoot, "build/catalogue-v0.2.0"),
  ));
  await mkdir(catalogueRoot, { recursive: true });
  const database = new PGlite(join(catalogueRoot, "pgdata"));
  try {
    const events = await ingestLibriVox({
      database,
      artifactRoot: join(catalogueRoot, "artifacts"),
      sourceRoot: resolve(argument(
        "--source-root",
        join(repositoryRoot, "source-cache/librivox"),
      )),
      lockPath: resolve(argument("--lock", defaultLockPath)),
    });
    for await (const event of events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  } finally {
    await database.exec("CHECKPOINT");
    await database.close();
  }
}
