import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PGlite compiles and starts PostgreSQL/WASM independently in several test
    // files. Cold, parallel workers on constrained runners can exceed Vitest's
    // five-second default even though the same tests finish normally.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
