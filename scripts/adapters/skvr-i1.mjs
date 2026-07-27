import manifest from "../../data/manifests/skvr-i1-pilot.json" with {
  type: "json",
};

import { XMLParser, XMLValidator } from "fast-xml-parser";

import { IngestValidationError } from
  "../lib/collection-ingestion.mjs";
import { RIGHTS_RELEASE_FIELDS } from "../lib/rights-contract-v2.mjs";

export const SKVR_I1_PILOT_IDS = Object.freeze([
  ...manifest.electronicIds,
]);

const SKVR_BASE =
  "https://aineistot.finlit.fi/exist/apps/skvr";
const RIGHTS_EVIDENCE_URI = `${SKVR_BASE}/ohjeet.html`;
const EXPECTED_IDS = Array.from(
  { length: 100 },
  (_, index) => `skvr011${String(index + 1).padStart(4, "0")}0`,
);
const parser = new XMLParser({
  attributeNamePrefix: "@",
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  removeNSPrefix: true,
  trimValues: false,
});
const orderedParser = new XMLParser({
  attributeNamePrefix: "@",
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: true,
  processEntities: true,
  removeNSPrefix: true,
  trimValues: false,
});

function assertManifest() {
  if (
    SKVR_I1_PILOT_IDS.length !== EXPECTED_IDS.length
    || SKVR_I1_PILOT_IDS.some((id, index) => id !== EXPECTED_IDS[index])
  ) {
    throw new IngestValidationError(
      "SKVR I1 pilot manifest must contain exactly base poems 1 through 100",
    );
  }
}

function valuesNamed(value, name, found = []) {
  if (Array.isArray(value)) {
    for (const child of value) valuesNamed(child, name, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === name) {
      for (const match of Array.isArray(child) ? child : [child]) {
        found.push(match);
      }
    }
    valuesNamed(child, name, found);
  }
  return found;
}

function cleanText(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/giu, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/gu, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function variantText(value, variant) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => variantText(child, variant)).join("");
  }
  if (typeof value !== "object") return "";
  if (value.choice != null) {
    return variantText(value.choice, variant);
  }
  const preferred = variant === "normalized" ? "reg" : "orig";
  if (value[preferred] != null) {
    return variantText(value[preferred], variant);
  }
  return Object.entries(value)
    .filter(([key]) =>
      !key.startsWith("@")
      && key !== (variant === "normalized" ? "orig" : "reg")
    )
    .map(([, child]) => variantText(child, variant))
    .join("");
}

function orderedElements(value, name, found = []) {
  if (Array.isArray(value)) {
    for (const child of value) orderedElements(child, name, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === name) {
      found.push({
        children: child,
        attributes: value[":@"] ?? {},
      });
    }
    if (key !== ":@" && key !== "#text") {
      orderedElements(child, name, found);
    }
  }
  return found;
}

function orderedVariant(value, variant) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((child) => orderedVariant(child, variant)).join("");
  }
  if (typeof value !== "object") return String(value);
  if (value["#text"] != null) return String(value["#text"]);
  const preferred = variant === "normalized" ? "reg" : "orig";
  return Object.entries(value)
    .filter(([key]) => key !== ":@" && key !== "#text")
    .map(([key, child]) => {
      if (key === "choice") {
        const choices = Array.isArray(child) ? child : [child];
        const selected = choices.find((choice) =>
          choice && typeof choice === "object" && choice[preferred] != null
        );
        return selected
          ? orderedVariant(selected[preferred], variant)
          : orderedVariant(child, variant);
      }
      if (key === (variant === "normalized" ? "orig" : "reg")) {
        return "";
      }
      return orderedVariant(child, variant);
    })
    .join("");
}

function firstText(nodes) {
  for (const node of nodes) {
    const text = cleanText(variantText(node, "source"));
    if (text) return text;
  }
  return null;
}

function typedText(root, name, acceptedTypes) {
  for (const node of valuesNamed(root, name)) {
    const type = String(
      node?.["@type"] ?? node?.["@unit"] ?? "",
    ).toLowerCase();
    if (acceptedTypes.has(type)) {
      const text = cleanText(variantText(node, "source"));
      if (text) return text;
    }
  }
  return null;
}

function metadataValue(root, names) {
  for (const name of names) {
    const value = firstText(valuesNamed(root, name));
    if (value) return value;
  }
  return null;
}

function parseSkvrTei(xml, expectedId) {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const detail = validation?.err?.msg ?? "invalid XML";
    throw new IngestValidationError(
      `SKVR ${expectedId} is malformed TEI/XML: ${detail}`,
    );
  }

  let root;
  let orderedRoot;
  try {
    root = parser.parse(xml);
    orderedRoot = orderedParser.parse(xml);
  } catch (error) {
    throw new IngestValidationError(
      `SKVR ${expectedId} cannot be parsed: ${error.message}`,
    );
  }
  const tei = root.TEI;
  if (!tei) {
    throw new IngestValidationError(
      `SKVR ${expectedId} has no TEI root`,
    );
  }

  const electronicIds = new Set([
    tei["@id"],
    tei["@xml:id"],
    ...valuesNamed(tei, "idno")
      .map((node) => cleanText(variantText(node, "source"))),
  ].filter(Boolean));
  if (!electronicIds.has(expectedId)) {
    throw new IngestValidationError(
      `SKVR record expected ${expectedId} but the TEI does not identify it`,
    );
  }

  const lines = orderedElements(orderedRoot, "l").map((line, index) => {
    const number = Number(line.attributes["@n"]);
    if (!Number.isInteger(number) || number < 1) {
      throw new IngestValidationError(
        `SKVR ${expectedId} line ${index + 1} has no usable source number`,
      );
    }
    const source = cleanText(orderedVariant(line.children, "source"));
    const normalized = cleanText(
      orderedVariant(line.children, "normalized"),
    );
    if (!source || !normalized) {
      throw new IngestValidationError(
        `SKVR ${expectedId} line ${number} has no text`,
      );
    }
    return { number, source, normalized };
  });
  if (lines.length === 0) {
    throw new IngestValidationError(
      `SKVR ${expectedId} has no citable verse lines`,
    );
  }
  for (const [index, line] of lines.entries()) {
    if (index > 0 && line.number <= lines[index - 1].number) {
      throw new IngestValidationError(
        `SKVR ${expectedId} line selectors are not strictly increasing`,
      );
    }
  }

  const poemNumber = Number(expectedId.slice(7, 11));
  const languageNode = valuesNamed(tei, "language")[0];
  const languageTag = languageNode?.["@ident"]
    ?? tei["@lang"]
    ?? tei["@xml:lang"]
    ?? "krl";
  const dialect = languageNode
    ? cleanText(variantText(languageNode, "source")) || null
    : null;
  const persistentUrn = valuesNamed(tei, "idno")
    .map((node) => cleanText(variantText(node, "source")))
    .find((value) => value.toLowerCase().startsWith("urn:"));
  if (!persistentUrn) {
    throw new IngestValidationError(
      `SKVR ${expectedId} has no persistent URN`,
    );
  }

  return {
    electronicId: expectedId,
    poemNumber,
    printedCitation: `SKVR I1 ${poemNumber}`,
    persistentUrn,
    title: firstText(valuesNamed(tei.text, "head"))
      ?? `SKVR I1 ${poemNumber}`,
    languageTag,
    scriptCode: "Latn",
    dialect,
    lines,
    metadata: {
      part: typedText(tei, "biblScope", new Set(["part"])) ?? "I1",
      poemNumber,
      archiveSignum: typedText(
        tei,
        "idno",
        new Set(["sgn", "signum"]),
      ),
      collector: metadataValue(tei, ["collector"]),
      performer: metadataValue(tei, ["performer", "informant"]),
      year: metadataValue(tei, ["dateSt", "date"]),
      region: metadataValue(tei, ["region"]),
      place: metadataValue(tei, ["place"]),
      village: metadataValue(tei, ["village"]),
    },
  };
}

function assertRightsReview(review) {
  if (
    review?.schemaVersion !== "folklore-rights-review-v2"
    || review?.reviewId !== "skvr-i1-fi-v2"
    || review?.reviewedOn !== "2026-07-27"
    || review?.reviewState !== "accepted"
    || review?.jurisdiction !== "FI"
    || review?.assessment !== "cc-by-4.0"
    || RIGHTS_RELEASE_FIELDS.some((field) => review[field] !== true)
  ) {
    throw new IngestValidationError(
      "SKVR Rights Contract v2 review is incomplete",
    );
  }
}

function rights(evidenceCaptureKey, review) {
  if (review) assertRightsReview(review);
  return {
    evidenceCaptureKey,
    statementUri: "https://creativecommons.org/licenses/by/4.0/",
    controlledStatus: "licensed",
    rightsSource: RIGHTS_EVIDENCE_URI,
    attributionText:
      "Suomalaisen Kirjallisuuden Seura (SKS), Suomen Kansan Vanhat Runot (SKVR)",
    commercialUseAllowed: true,
    derivativesAllowed: true,
    evidenceUseAllowed: true,
    quotationAllowed: true,
    redistributionAllowed: true,
    accessPrivateUseAllowed: true,
    mlEvaluationAllowed: true,
    mlTrainingAllowed: true,
    mlUseAllowed: true,
    jurisdiction: "FI",
    reviewedOn: review?.reviewedOn ?? "2026-07-27",
    reviewState: review?.reviewState ?? "accepted",
  };
}

function lockedRequest(source) {
  if (
    !source
    || typeof source.uri !== "string"
    || typeof source.sourcePath !== "string"
    || typeof source.mediaType !== "string"
    || !Number.isSafeInteger(source.byteLength)
    || !/^[0-9a-f]{64}$/.test(source.sha256 ?? "")
  ) {
    throw new IngestValidationError("SKVR source lock is incomplete");
  }
  return {
    uri: source.uri,
    sourcePath: source.sourcePath,
    mediaType: source.mediaType,
    expectedByteLength: source.byteLength,
    expectedSha256: source.sha256,
  };
}

function xmlItems(volumeXml) {
  const validation = XMLValidator.validate(volumeXml);
  if (validation !== true) {
    const detail = validation?.err?.msg ?? "invalid XML";
    throw new IngestValidationError(
      `SKVR volume is malformed XML: ${detail}`,
    );
  }
  const matches = volumeXml.match(/<ITEM\b[\s\S]*?<\/ITEM>/gu) ?? [];
  if (matches.length === 0) {
    throw new IngestValidationError("SKVR volume contains no ITEM records");
  }
  return matches.map((xml, index) => {
    const item = parser.parse(xml).ITEM;
    const electronicId = item?.["@nro"];
    if (!electronicId) {
      throw new IngestValidationError(
        `SKVR volume item ${index + 1} has no electronic ID`,
      );
    }
    return { electronicId, item, ordinal: index + 1, xml };
  });
}

function parseVolumeItem(entry, expectedId) {
  if (entry.electronicId !== expectedId) {
    throw new IngestValidationError(
      `SKVR record expected ${expectedId} but got ${entry.electronicId}`,
    );
  }
  const metadata = entry.item.META ?? {};
  const text = entry.item.TEXT ?? {};
  const primaryText = text.V ?? text.L;
  const verses = Array.isArray(primaryText)
    ? primaryText
    : [primaryText].filter(Boolean);
  const lines = verses.map((verse, index) => {
    const source = cleanText(variantText(verse, "source"));
    if (!source) {
      throw new IngestValidationError(
        `SKVR ${expectedId} line ${index + 1} has no text`,
      );
    }
    return {
      number: index + 1,
      source,
      normalized: source,
    };
  });
  if (lines.length === 0) {
    throw new IngestValidationError(
      `SKVR ${expectedId} has no citable verse lines`,
    );
  }
  const printedId = cleanText(variantText(metadata.ID, "source"));
  const poemNumber = Number.parseInt(printedId, 10);
  if (!Number.isInteger(poemNumber)) {
    throw new IngestValidationError(
      `SKVR ${expectedId} has no printed poem number`,
    );
  }
  return {
    electronicId: expectedId,
    poemNumber,
    printedCitation: `SKVR I1 ${poemNumber}`,
    archiveRecordId: expectedId,
    title: `SKVR I1 ${poemNumber}`,
    languageTag: "krl",
    scriptCode: "Latn",
    dialect: null,
    lines,
    metadata: {
      part: cleanText(variantText(metadata.OSA, "source")) || "I1",
      poemNumber,
      archiveSignum:
        cleanText(variantText(metadata.SGN, "source")) || null,
      collector: cleanText(variantText(metadata.COL, "source")) || null,
      performer: cleanText(variantText(metadata.INF, "source")) || null,
      year: entry.item["@y"] || null,
      region: cleanText(variantText(metadata.LOC, "source")) || null,
      sourceVolumeOrdinal: entry.ordinal,
    },
  };
}

export function createSkvrI1VolumeAdapter(lock, { lockSha256 } = {}) {
  assertManifest();
  if (
    lock?.schemaVersion !== 1
    || lock?.collection !== "SKVR"
    || lock?.upstream?.commit !==
      "2cfd7db101e79eb1446d0d2dbb108af1e8b2a18a"
  ) {
    throw new IngestValidationError("SKVR source lock identity is invalid");
  }
  const volumeRequest = lockedRequest(lock.sources?.volume);
  const readmeRequest = lockedRequest(lock.sources?.readme);
  const reviewRequest = lockedRequest(lock.sources?.rightsReview);

  return {
    key: "skvr",
    version:
      `i1-pilot-volume-${lock.upstream.commit.slice(0, 12)}-` +
      `${lockSha256?.slice(0, 12) ?? "unlocked-fixture"}`,
    archive: {
      name: "Suomen Kansan Vanhat Runot",
      homepageUri: "https://aineistot.finlit.fi/exist/apps/skvr/",
      metadata: {
        institution: "Suomalaisen Kirjallisuuden Seura",
        sourceRepository: lock.upstream.url,
        sourceCommit: lock.upstream.commit,
      },
    },

    async *read(context) {
      const startIndex = context.checkpoint?.nextIndex ?? 0;
      if (
        !Number.isInteger(startIndex)
        || startIndex < 0
        || startIndex > SKVR_I1_PILOT_IDS.length
      ) {
        throw new IngestValidationError(
          "SKVR checkpoint has an invalid nextIndex",
        );
      }
      const volume = await context.capture({
        sourceKey: "skvr-i1-volume",
        role: "structured-text-volume",
        request: volumeRequest,
      });
      await context.capture({
        sourceKey: "skvr-repository-readme",
        role: "rights-source",
        request: readmeRequest,
      });
      const rightsEvidence = await context.capture({
        sourceKey: "skvr-i1-rights-review",
        role: "rights-evidence",
        request: reviewRequest,
      });
      let rightsReview;
      try {
        rightsReview = JSON.parse(await context.readText(rightsEvidence));
      } catch {
        throw new IngestValidationError(
          "SKVR Rights Contract v2 review is not valid JSON",
        );
      }
      assertRightsReview(rightsReview);
      const entries = xmlItems(await context.readText(volume));
      const byId = new Map(entries.map((entry) => [entry.electronicId, entry]));
      const missing = SKVR_I1_PILOT_IDS.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new IngestValidationError(
          `SKVR volume is missing pilot IDs: ${missing.join(", ")}`,
        );
      }

      for (
        let index = startIndex;
        index < SKVR_I1_PILOT_IDS.length;
        index += 1
      ) {
        const electronicId = SKVR_I1_PILOT_IDS[index];
        const entry = byId.get(electronicId);
        const record = parseVolumeItem(entry, electronicId);
        const sourceXml = await context.materialize({
          artifactKey: `${electronicId}-source-xml`,
          mediaType: "application/xml",
          bytes: Buffer.from(`${entry.xml}\n`),
        });
        const normalized = await context.materialize({
          artifactKey: `${electronicId}-plain-text`,
          mediaType: "text/plain; charset=utf-8",
          bytes: Buffer.from(
            `${record.lines.map(({ normalized: line }) => line).join("\n")}\n`,
          ),
        });
        const firstLine = 1;
        const lastLine = record.lines.length;
        const passage = {
          externalKey: `lines-${firstLine}-${lastLine}`,
          ordinal: 1,
          sourceAnchor: `${electronicId}:lines:${firstLine}-${lastLine}`,
          citationLabel:
            `${record.printedCitation}, lines ${firstLine}–${lastLine}`,
          languageTag: null,
          selector: {
            type: "LineSelector",
            startLine: firstLine,
            endLine: lastLine,
          },
        };
        const commonMetadata = {
          electronicId,
          archiveRecordId: record.archiveRecordId,
          sourceRepository: lock.upstream.url,
          sourceCommit: lock.upstream.commit,
          sourceVolumePath: lock.sources.volume.sourcePath,
          sourceVolumeSha256: lock.sources.volume.sha256,
        };

        yield {
          externalKey: electronicId,
          checkpointAfter: {
            nextIndex: index + 1,
            electronicId,
          },
          captures: [volume, rightsEvidence],
          artifacts: [sourceXml, normalized],
          sourceItem: {
            externalKey: electronicId,
            nativeId: electronicId,
            landingUri: `${SKVR_BASE}/main/${electronicId}.xml`,
            metadata: {
              sourceFormat: "SKVR volume XML",
              title: record.title,
              printedCitation: record.printedCitation,
              archiveRecordId: record.archiveRecordId,
              ...record.metadata,
              ...commonMetadata,
            },
          },
          witnesses: [{
            externalKey: "poem",
            kind: "text",
            metadata: {
              title: record.title,
              printedCitation: record.printedCitation,
              archiveRecordId: record.archiveRecordId,
            },
            representations: [
              {
                externalKey: "source-xml",
                artifactKey: sourceXml.key,
                kind: "source-xml",
                languageTag: record.languageTag,
                scriptCode: record.scriptCode,
                dialect: record.dialect,
                metadata: commonMetadata,
                derivation: {
                  type: null,
                  method: "skvr-volume-item-extraction",
                  methodVersion: "1",
                  deterministic: true,
                  inputCaptureKeys: [volume.key],
                },
                passages: [{
                  ...passage,
                  quotedText: record.lines
                    .map(({ source }) => source)
                    .join("\n"),
                }],
              },
              {
                externalKey: "plain-text",
                artifactKey: normalized.key,
                kind: "plain-text",
                languageTag: record.languageTag,
                scriptCode: record.scriptCode,
                dialect: record.dialect,
                metadata: {
                  ...commonMetadata,
                  sourceRepresentation: "source-xml",
                },
                derivation: {
                  type: "normalization",
                  method: "skvr-volume-plain-text-extraction",
                  methodVersion: "1",
                  deterministic: true,
                  inputCaptureKeys: [volume.key],
                },
                passages: [{
                  ...passage,
                  quotedText: record.lines
                    .map(({ normalized: line }) => line)
                    .join("\n"),
                }],
              },
            ],
          }],
          rights: rights(rightsEvidence.key, rightsReview),
        };
      }
    },
  };
}

export function createSkvrI1Adapter() {
  assertManifest();
  return {
    key: "skvr",
    version: "i1-pilot-1",
    archive: {
      name: "Suomen Kansan Vanhat Runot",
      homepageUri: `${SKVR_BASE}/index.html`,
      metadata: {
        institution: "Suomalaisen Kirjallisuuden Seura",
      },
    },

    async *read(context) {
      const startIndex = context.checkpoint?.nextIndex ?? 0;
      if (
        !Number.isInteger(startIndex)
        || startIndex < 0
        || startIndex > SKVR_I1_PILOT_IDS.length
      ) {
        throw new IngestValidationError(
          "SKVR checkpoint has an invalid nextIndex",
        );
      }
      const rightsEvidence = await context.capture({
        sourceKey: "cc-by-4.0-rights",
        role: "rights-evidence",
        request: {
          uri: RIGHTS_EVIDENCE_URI,
          mediaType: "text/html; charset=utf-8",
        },
      });

      for (
        let index = startIndex;
        index < SKVR_I1_PILOT_IDS.length;
        index += 1
      ) {
        const electronicId = SKVR_I1_PILOT_IDS[index];
        const tei = await context.capture({
          sourceKey: `${electronicId}-tei`,
          role: "structured-text",
          request: {
            uri: `${SKVR_BASE}/main/${electronicId}.xml`,
            mediaType: "application/tei+xml",
            headers: {
              accept: "application/tei+xml, application/xml;q=0.9",
            },
          },
        });
        const xml = await context.readText(tei);
        const record = parseSkvrTei(xml, electronicId);
        const normalizedBytes = Buffer.from(
          `${record.lines.map(({ normalized }) => normalized).join("\n")}\n`,
        );
        const normalized = await context.materialize({
          artifactKey: `${electronicId}-normalized-text`,
          mediaType: "text/plain; charset=utf-8",
          bytes: normalizedBytes,
        });
        const firstLine = record.lines[0].number;
        const lastLine = record.lines.at(-1).number;
        const passageKey = `lines-${firstLine}-${lastLine}`;
        const passage = {
          externalKey: passageKey,
          ordinal: 1,
          sourceAnchor: `${electronicId}:lines:${firstLine}-${lastLine}`,
          citationLabel:
            `${record.printedCitation}, lines ${firstLine}–${lastLine}`,
          languageTag: null,
          selector: {
            type: "LineSelector",
            startLine: firstLine,
            endLine: lastLine,
          },
        };

        yield {
          externalKey: electronicId,
          checkpointAfter: {
            nextIndex: index + 1,
            electronicId,
          },
          captures: [tei, rightsEvidence],
          artifacts: [normalized],
          sourceItem: {
            externalKey: electronicId,
            nativeId: electronicId,
            landingUri: `${SKVR_BASE}/main/${electronicId}.xml`,
            metadata: {
              sourceFormat: "TEI",
              title: record.title,
              printedCitation: record.printedCitation,
              persistentUrn: record.persistentUrn,
              ...record.metadata,
            },
          },
          witnesses: [{
            externalKey: "poem",
            kind: "text",
            metadata: {
              title: record.title,
              printedCitation: record.printedCitation,
              persistentUrn: record.persistentUrn,
            },
            representations: [
              {
                externalKey: "tei-source",
                captureKey: tei.key,
                kind: "tei-source",
                languageTag: record.languageTag,
                scriptCode: record.scriptCode,
                dialect: record.dialect,
                metadata: {
                  electronicId,
                  persistentUrn: record.persistentUrn,
                },
                derivation: {
                  type: null,
                  method: "skvr-tei-capture",
                  methodVersion: "1",
                  deterministic: true,
                },
                passages: [{
                  ...passage,
                  quotedText: record.lines
                    .map(({ source }) => source)
                    .join("\n"),
                }],
              },
              {
                externalKey: "normalized-text",
                artifactKey: normalized.key,
                kind: "normalized-text",
                languageTag: record.languageTag,
                scriptCode: record.scriptCode,
                dialect: record.dialect,
                metadata: {
                  electronicId,
                  persistentUrn: record.persistentUrn,
                  sourceRepresentation: "tei-source",
                },
                derivation: {
                  type: "normalization",
                  method: "skvr-tei-choice-normalization",
                  methodVersion: "1",
                  deterministic: true,
                  inputCaptureKeys: [tei.key],
                },
                passages: [{
                  ...passage,
                  quotedText: record.lines
                    .map(({ normalized: text }) => text)
                    .join("\n"),
                }],
              },
            ],
          }],
          rights: rights(rightsEvidence.key),
        };
      }
    },
  };
}
