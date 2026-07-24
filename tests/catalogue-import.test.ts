import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogueStats,
  importRelease,
} from "../scripts/build-catalogue.mjs";

describe("v0.1 release catalogue import", () => {
  let database: PGlite | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    await database?.close();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    database = undefined;
    temporaryDirectory = undefined;
  });

  it("loads the release and preserves its provenance graph", async () => {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "folklore-catalogue-test-"),
    );
    database = new PGlite(join(temporaryDirectory, "pgdata"));

    const imported = await importRelease({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
    });

    expect(imported.resources).toMatchObject({
      archive: 1,
      artifact: 176,
      capture: 5,
      derivation: 3_631,
      document: 170,
      edition: 5,
      passage: 3_291,
      release: 1,
      representation: 170,
      "source-item": 5,
      witness: 170,
    });

    const passageTrace = await database.query<{ capture_count: number }>(`
      WITH RECURSIVE ancestors(resource_pk) AS (
        SELECT resource_pk
        FROM folklore.resource
        WHERE canonical_id =
          'fa:passage:pg-1597:toc-001:text-en:p0001'

        UNION

        SELECT input.input_resource_pk
        FROM ancestors
        JOIN folklore.derivation_output output
          ON output.output_resource_pk = ancestors.resource_pk
        JOIN folklore.derivation_input input
          ON input.derivation_resource_pk = output.derivation_resource_pk
      )
      SELECT count(DISTINCT capture.resource_pk)::integer AS capture_count
      FROM ancestors
      JOIN folklore.capture capture
        ON capture.resource_pk = ancestors.resource_pk
    `);

    expect(Number(passageTrace.rows[0].capture_count)).toBe(1);

    const releaseMembers = await database.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM folklore.release_member
    `);
    expect(Number(releaseMembers.rows[0].count)).toBe(3_641);

    await importRelease({
      database,
      artifactRoot: join(temporaryDirectory, "artifacts"),
    });
    expect(await catalogueStats(database)).toEqual(imported);
  }, 30_000);
});
