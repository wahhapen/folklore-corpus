import {
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  ensureResource,
  registerArtifact,
  sha256,
} from "./lib/catalogue-storage.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReleasePath = join(
  repositoryRoot,
  "data/derived/releases/corpus-v0.1.0",
);
const defaultOutputPath = join(repositoryRoot, "build/catalogue-v0.1.0");

function parseJsonLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonLines(path) {
  return parseJsonLines(await readFile(path, "utf8"));
}

export async function putArtifact({
  database,
  artifactRoot,
  bytes,
  mediaType,
  sourcePath,
}) {
  const digest = sha256(bytes);
  const storageKey = join("sha256", digest.slice(0, 2), digest);
  const outputPath = join(artifactRoot, storageKey);

  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await stat(outputPath);
  } catch {
    if (sourcePath) {
      await copyFile(sourcePath, outputPath);
    } else {
      await writeFile(outputPath, bytes);
    }
  }

  const { canonicalId, resourcePk } = await registerArtifact({
    database,
    digest,
    byteLength: bytes.byteLength,
    mediaType,
    storageKey,
  });

  return { resourcePk, canonicalId, digest, storageKey };
}

async function tableExists(database, schema, table) {
  const result = await database.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) AS exists
    `,
    [schema, table],
  );
  return result.rows[0].exists;
}

async function columnExists(database, schema, table, column) {
  const result = await database.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND column_name = $3
      ) AS exists
    `,
    [schema, table, column],
  );
  return result.rows[0].exists;
}

export async function applyCatalogueMigrations(database) {
  if (!(await tableExists(database, "folklore", "resource"))) {
    await database.exec(
      await readFile(
        join(repositoryRoot, "db/migrations/0001_core.sql"),
        "utf8",
      ),
    );
  }
  if (!(await tableExists(database, "folklore", "rights_assessment"))) {
    await database.exec(
      await readFile(
        join(repositoryRoot, "db/migrations/0002_rights_gate.sql"),
        "utf8",
      ),
    );
  }
  if (
    !(await columnExists(
      database,
      "folklore",
      "representation",
      "script_code",
    ))
  ) {
    await database.exec(
      await readFile(
        join(
          repositoryRoot,
          "db/migrations/0003_multilingual_representations.sql",
        ),
        "utf8",
      ),
    );
  }
  if (!(await tableExists(database, "folklore", "ingest_run"))) {
    await database.exec(
      await readFile(
        join(repositoryRoot, "db/migrations/0004_ingestion_runs.sql"),
        "utf8",
      ),
    );
  }
  if (
    !(await columnExists(
      database,
      "folklore",
      "rights_assessment",
      "ml_training_allowed",
    ))
  ) {
    await database.exec(
      await readFile(
        join(repositoryRoot, "db/migrations/0005_rights_contract_v2.sql"),
        "utf8",
      ),
    );
  }
}

export async function importRelease({
  database,
  releasePath = defaultReleasePath,
  artifactRoot,
}) {
  await applyCatalogueMigrations(database);

  const manifest = await readJson(join(releasePath, "manifest.json"));
  const captures = await readJsonLines(join(releasePath, "captures.jsonl"));
  const editions = await readJsonLines(join(releasePath, "editions.jsonl"));
  const documents = await readJsonLines(join(releasePath, "documents.jsonl"));
  const witnesses = await readJsonLines(join(releasePath, "witnesses.jsonl"));
  const passages = await readJsonLines(join(releasePath, "passages.jsonl"));
  const lineage = await readJsonLines(join(releasePath, "lineage.jsonl"));
  const aliases = await readJsonLines(join(releasePath, "aliases.jsonl"));
  const splits = await readJsonLines(join(releasePath, "splits.jsonl"));

  const archiveId = "fa:archive:project-gutenberg";
  const archivePk = await ensureResource(database, archiveId, "archive");
  await database.query(
    `
      INSERT INTO folklore.archive (resource_pk, name, homepage_uri)
      VALUES ($1, 'Project Gutenberg', 'https://www.gutenberg.org/')
      ON CONFLICT (resource_pk) DO NOTHING
    `,
    [archivePk],
  );

  const sourceItemByCapture = new Map();
  const resourcePkById = new Map([[archiveId, archivePk]]);
  const representationPkByWitness = new Map();

  await database.exec("BEGIN");
  try {
    for (const capture of captures) {
      const sourceItemId =
        `fa:source-item:project-gutenberg:${capture.sourceId}`;
      const sourceItemPk = await ensureResource(
        database,
        sourceItemId,
        "source-item",
      );
      resourcePkById.set(sourceItemId, sourceItemPk);
      sourceItemByCapture.set(capture.id, sourceItemPk);

      await database.query(
        `
          INSERT INTO folklore.source_item (
            resource_pk,
            archive_resource_pk,
            native_id,
            landing_uri,
            native_metadata
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          sourceItemPk,
          archivePk,
          capture.sourceId,
          capture.landingPage,
          JSON.stringify({ institution: capture.institution }),
        ],
      );

      const rawPath = resolve(repositoryRoot, capture.rawPath);
      const rawBytes = await readFile(rawPath);
      if (sha256(rawBytes) !== capture.rawSha256) {
        throw new Error(`Raw digest mismatch for ${capture.id}`);
      }
      const artifact = await putArtifact({
        database,
        artifactRoot,
        bytes: rawBytes,
        mediaType: "text/plain; charset=utf-8",
        sourcePath: rawPath,
      });
      resourcePkById.set(artifact.canonicalId, artifact.resourcePk);

      const capturePk = await ensureResource(database, capture.id, "capture");
      resourcePkById.set(capture.id, capturePk);
      await database.query(
        `
          INSERT INTO folklore.capture (
            resource_pk,
            source_item_resource_pk,
            artifact_resource_pk,
            captured_at,
            retrieval_uri,
            response_metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          capturePk,
          sourceItemPk,
          artifact.resourcePk,
          capture.capturedAt,
          capture.retrievalUrl,
          JSON.stringify({
            rawSha256: capture.rawSha256,
            byteLength: capture.byteLength,
          }),
        ],
      );
    }

    for (const edition of editions) {
      const editionPk = await ensureResource(database, edition.id, "edition");
      resourcePkById.set(edition.id, editionPk);
      await database.query(
        `
          INSERT INTO folklore.edition (
            resource_pk,
            source_item_resource_pk,
            title,
            language_tag,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          editionPk,
          sourceItemByCapture.get(edition.captureId),
          edition.title,
          edition.language,
          JSON.stringify(edition),
        ],
      );
    }

    for (const document of documents) {
      const documentPk = await ensureResource(
        database,
        document.id,
        "document",
      );
      resourcePkById.set(document.id, documentPk);
      await database.query(
        `
          INSERT INTO folklore.document (
            resource_pk,
            edition_resource_pk,
            source_ordinal,
            title,
            language_tag,
            metadata
          )
          VALUES (
            $1,
            (SELECT resource_pk FROM folklore.resource WHERE canonical_id = $2),
            $3,
            $4,
            $5,
            $6
          )
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          documentPk,
          document.editionId,
          document.sourceOrdinal,
          document.title,
          document.language,
          JSON.stringify(document),
        ],
      );
    }

    for (const witness of witnesses) {
      const witnessPk = await ensureResource(
        database,
        witness.id,
        "witness",
      );
      resourcePkById.set(witness.id, witnessPk);
      await database.query(
        `
          INSERT INTO folklore.witness (
            resource_pk,
            document_resource_pk,
            witness_kind,
            metadata
          )
          VALUES (
            $1,
            (SELECT resource_pk FROM folklore.resource WHERE canonical_id = $2),
            $3,
            $4
          )
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          witnessPk,
          witness.documentId,
          witness.kind,
          JSON.stringify({
            rawPath: witness.rawPath,
            rawSha256: witness.rawSha256,
            sourceSpan: witness.sourceSpan,
          }),
        ],
      );

      const textBytes = Buffer.from(witness.text, "utf8");
      const textArtifact = await putArtifact({
        database,
        artifactRoot,
        bytes: textBytes,
        mediaType: "text/plain; charset=utf-8",
      });
      resourcePkById.set(textArtifact.canonicalId, textArtifact.resourcePk);

      const representationId =
        witness.id.replace("fa:witness:", "fa:representation:") + ":v0.1";
      const representationPk = await ensureResource(
        database,
        representationId,
        "representation",
      );
      representationPkByWitness.set(witness.id, representationPk);
      resourcePkById.set(representationId, representationPk);
      await database.query(
        `
          INSERT INTO folklore.representation (
            resource_pk,
            witness_resource_pk,
            artifact_resource_pk,
            representation_kind,
            language_tag,
            metadata
          )
          VALUES ($1, $2, $3, 'normalized-text', $4, $5)
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          representationPk,
          witnessPk,
          textArtifact.resourcePk,
          witness.language,
          JSON.stringify({ normalization: witness.normalization }),
        ],
      );
    }

    for (const passage of passages) {
      const passagePk = await ensureResource(
        database,
        passage.id,
        "passage",
      );
      resourcePkById.set(passage.id, passagePk);
      const witnessPk = resourcePkById.get(passage.witnessId);
      const representationPk = representationPkByWitness.get(
        passage.witnessId,
      );
      const sliceDigest = sha256(Buffer.from(passage.text, "utf8"));

      await database.query(
        `
          INSERT INTO folklore.passage (
            resource_pk,
            witness_resource_pk,
            ordinal,
            source_anchor,
            citation_label
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          passagePk,
          witnessPk,
          passage.ordinal,
          `ordinal:${passage.ordinal}`,
          passage.citationLabel,
        ],
      );
      await database.query(
        `
          INSERT INTO folklore.passage_representation (
            passage_resource_pk,
            representation_resource_pk,
            selector,
            quoted_text,
            slice_digest
          )
          VALUES ($1, $2, $3, $4, decode($5, 'hex'))
          ON CONFLICT (passage_resource_pk, representation_resource_pk)
          DO NOTHING
        `,
        [
          passagePk,
          representationPk,
          JSON.stringify({
            type: "TextPositionSelector",
            start: passage.characterStart,
            end: passage.characterEnd,
          }),
          passage.text,
          sliceDigest,
        ],
      );
    }

    for (const event of lineage) {
      const eventDigest = sha256(
        Buffer.from(JSON.stringify(event), "utf8"),
      );
      const derivationId = `fa:derivation:sha256-${eventDigest}`;
      const derivationPk = await ensureResource(
        database,
        derivationId,
        "derivation",
      );
      resourcePkById.set(derivationId, derivationPk);
      await database.query(
        `
          INSERT INTO folklore.derivation (
            resource_pk,
            method,
            method_version,
            parameters,
            runtime,
            deterministic,
            completed_at
          )
          VALUES ($1, $2, $3, $4, '{}'::jsonb, true, $5)
          ON CONFLICT (resource_pk) DO NOTHING
        `,
        [
          derivationPk,
          event.method,
          event.methodVersion,
          JSON.stringify({ sourceSpan: event.sourceSpan }),
          manifest.publishedAt,
        ],
      );

      for (const [ordinal, inputId] of event.inputIds.entries()) {
        await database.query(
          `
            INSERT INTO folklore.derivation_input (
              derivation_resource_pk,
              ordinal,
              input_resource_pk
            )
            VALUES (
              $1,
              $2,
              (SELECT resource_pk FROM folklore.resource WHERE canonical_id = $3)
            )
            ON CONFLICT (derivation_resource_pk, ordinal) DO NOTHING
          `,
          [derivationPk, ordinal, inputId],
        );
      }

      const outputIds = [event.outputId];
      if (event.outputKind === "witness") {
        const representationPk = representationPkByWitness.get(event.outputId);
        const representation = await database.query(
          "SELECT canonical_id FROM folklore.resource WHERE resource_pk = $1",
          [representationPk],
        );
        outputIds.push(representation.rows[0].canonical_id);
      }
      for (const [ordinal, outputId] of outputIds.entries()) {
        await database.query(
          `
            INSERT INTO folklore.derivation_output (
              derivation_resource_pk,
              ordinal,
              output_resource_pk
            )
            VALUES (
              $1,
              $2,
              (SELECT resource_pk FROM folklore.resource WHERE canonical_id = $3)
            )
            ON CONFLICT (derivation_resource_pk, ordinal) DO NOTHING
          `,
          [derivationPk, ordinal, outputId],
        );
      }
    }

    const manifestBytes = await readFile(join(releasePath, "manifest.json"));
    const manifestArtifact = await putArtifact({
      database,
      artifactRoot,
      bytes: manifestBytes,
      mediaType: "application/json",
      sourcePath: join(releasePath, "manifest.json"),
    });
    const releasePk = await ensureResource(
      database,
      manifest.releaseId,
      "release",
    );
    resourcePkById.set(manifest.releaseId, releasePk);
    await database.query(
      `
        INSERT INTO folklore.release (
          resource_pk,
          version,
          manifest_artifact_resource_pk,
          published_at,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (resource_pk) DO NOTHING
      `,
      [
        releasePk,
        manifest.version,
        manifestArtifact.resourcePk,
        manifest.publishedAt,
        JSON.stringify({ compiler: manifest.compiler }),
      ],
    );

    const releaseMembers = [
      ...captures.map((record) => [record.id, "capture"]),
      ...editions.map((record) => [record.id, "edition"]),
      ...documents.map((record) => [record.id, "document"]),
      ...witnesses.map((record) => [record.id, "witness"]),
      ...passages.map((record) => [record.id, "passage"]),
    ];
    for (const [ordinal, [memberId, role]] of releaseMembers.entries()) {
      await database.query(
        `
          INSERT INTO folklore.release_member (
            release_resource_pk,
            member_resource_pk,
            member_role,
            ordinal
          )
          VALUES (
            $1,
            (SELECT resource_pk FROM folklore.resource WHERE canonical_id = $2),
            $3,
            $4
          )
          ON CONFLICT (release_resource_pk, member_resource_pk, member_role)
          DO NOTHING
        `,
        [releasePk, memberId, role, ordinal],
      );
    }

    for (const alias of aliases) {
      await database.query(
        `
          INSERT INTO folklore.alias (
            alias_id,
            target_resource_pk,
            relation,
            reason
          )
          VALUES (
            $1,
            (SELECT resource_pk FROM folklore.resource WHERE canonical_id = $2),
            'alias',
            $3
          )
          ON CONFLICT (alias_id) DO NOTHING
        `,
        [alias.alias, alias.targetId, alias.reason],
      );
    }

    for (const split of splits) {
      await database.query(
        `
          INSERT INTO folklore.split_assignment (
            release_resource_pk,
            member_resource_pk,
            group_id,
            split
          )
          VALUES (
            $1,
            (SELECT resource_pk FROM folklore.resource WHERE canonical_id = $2),
            $3,
            $4
          )
          ON CONFLICT (release_resource_pk, member_resource_pk) DO NOTHING
        `,
        [releasePk, split.documentId, split.groupId, split.split],
      );
    }

    await database.exec("COMMIT");
  } catch (error) {
    await database.exec("ROLLBACK");
    throw error;
  }

  return catalogueStats(database);
}

export async function catalogueStats(database) {
  const counts = await database.query(`
    SELECT resource_kind, count(*)::integer AS count
    FROM folklore.resource
    GROUP BY resource_kind
    ORDER BY resource_kind
  `);
  const artifacts = await database.query(`
    SELECT
      count(*)::integer AS count,
      coalesce(sum(byte_length), 0)::bigint AS bytes
    FROM folklore.artifact
  `);

  return {
    resources: Object.fromEntries(
      counts.rows.map(({ resource_kind, count }) => [
        resource_kind,
        Number(count),
      ]),
    ),
    artifacts: {
      count: Number(artifacts.rows[0].count),
      bytes: Number(artifacts.rows[0].bytes),
    },
  };
}

function parseArguments(argv) {
  const values = {
    releasePath: defaultReleasePath,
    outputPath: defaultOutputPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--release") {
      values.releasePath = resolve(argv[++index]);
    } else if (argv[index] === "--output") {
      values.outputPath = resolve(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return values;
}

async function main() {
  const { releasePath, outputPath } = parseArguments(process.argv.slice(2));
  const databasePath = join(outputPath, "pgdata");
  const artifactRoot = join(outputPath, "artifacts");
  await mkdir(outputPath, { recursive: true });

  const database = new PGlite(databasePath);
  try {
    const stats = await importRelease({
      database,
      releasePath,
      artifactRoot,
    });
    console.log(JSON.stringify({
      databasePath,
      artifactRoot,
      ...stats,
    }, null, 2));
  } finally {
    await database.exec("CHECKPOINT");
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
