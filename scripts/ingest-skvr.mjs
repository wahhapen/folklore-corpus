import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import {
  createSkvrI1Adapter,
  createSkvrI1VolumeAdapter,
} from "./adapters/skvr-i1.mjs";
import { ingestCollection } from "./lib/collection-ingestion.mjs";
import { createPinnedSourceTransport } from
  "./lib/pinned-source-transport.mjs";

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

function retryDelay(attempt) {
  return 500 * (2 ** attempt);
}

export function createHttpCaptureTransport({
  fetchImpl = fetch,
  maxAttempts = 3,
} = {}) {
  return async (request) => {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(request.uri, {
          headers: request.headers,
        });
        if (
          response.ok
          || (
            response.status < 500
            && response.status !== 429
          )
        ) {
          if (!response.ok) {
            throw new Error(
              `SKVR capture failed with HTTP ${response.status}: ${request.uri}`,
            );
          }
          return {
            body: response.body,
            responseMetadata: {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
            },
          };
        }
        lastError = new Error(
          `SKVR capture failed with HTTP ${response.status}: ${request.uri}`,
        );
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < maxAttempts) {
        await new Promise((accept) =>
          setTimeout(accept, retryDelay(attempt))
        );
      }
    }
    throw lastError;
  };
}

export async function runSkvrIngest({
  output,
  captureTransport = createHttpCaptureTransport(),
  onEvent = () => {},
  adapter = createSkvrI1Adapter(),
  request = {
    collection: "skvr",
    pilot: "I1-base-1-100",
  },
}) {
  const outputRoot = resolve(output);
  await mkdir(outputRoot, { recursive: true });
  const database = new PGlite(resolve(outputRoot, "pgdata"));
  try {
    const events = [];
    for await (const event of ingestCollection({
      database,
      artifactRoot: resolve(outputRoot, "artifacts"),
      adapter,
      captureTransport,
      request,
    })) {
      events.push(event);
      onEvent(event);
    }
    return events;
  } finally {
    await database.exec("CHECKPOINT");
    await database.close();
  }
}

export async function runPinnedSkvrIngest({
  output,
  sourceRoot,
  lockPath = defaultLockPath,
  onEvent = () => {},
}) {
  const lockBytes = await readFile(lockPath);
  const lock = JSON.parse(lockBytes);
  const lockSha256 = createHash("sha256")
    .update(lockBytes)
    .digest("hex");
  return runSkvrIngest({
    output,
    adapter: createSkvrI1VolumeAdapter(lock, { lockSha256 }),
    captureTransport: createPinnedSourceTransport({ sourceRoot }),
    onEvent,
    request: {
      collection: "skvr",
      pilot: "I1-base-1-100",
      lockSha256,
    },
  });
}

async function main() {
  const output = argument("--output", "build/catalogue-skvr-i1");
  const sourceRoot = resolve(
    argument("--source-root", "source-cache/skvr-i1"),
  );
  await runPinnedSkvrIngest({
    output,
    sourceRoot,
    lockPath: resolve(argument("--lock", defaultLockPath)),
    onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
