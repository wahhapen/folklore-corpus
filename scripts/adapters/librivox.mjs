import { IngestValidationError } from "../lib/collection-ingestion.mjs";
import { XMLParser } from "fast-xml-parser";

const EXPECTED_IDS = Array.from(
  { length: 27 },
  (_, index) => String(153266 + index),
);
const PUBLIC_DOMAIN_MARKERS = new Set([
  "http://creativecommons.org/licenses/publicdomain/",
  "https://creativecommons.org/publicdomain/mark/1.0/",
]);

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestValidationError(`${field} is required`);
  }
  return value;
}

function validateSource(source, field) {
  requireObject(source, field);
  if (
    typeof source.uri !== "string"
    || typeof source.path !== "string"
    || typeof source.mediaType !== "string"
    || !Number.isSafeInteger(source.byteLength)
    || source.byteLength < 0
    || !/^[0-9a-f]{64}$/.test(source.sha256 ?? "")
  ) {
    throw new IngestValidationError(`${field} is not a complete source lock`);
  }
}

function validateLock(lock) {
  requireObject(lock, "lock");
  if (lock.version !== 1) {
    throw new IngestValidationError("LibriVox lock version must be 1");
  }
  if (
    lock.collection?.bookId !== "1837"
    || lock.collection?.sourceTextId !== "gutenberg-7885"
    || lock.collection?.internetArchiveId
      !== "celtic_fairy_tales_0903_librivox"
  ) {
    throw new IngestValidationError(
      "LibriVox lock does not identify the approved pilot",
    );
  }
  const sectionIds = lock.sections?.map(({ id }) => id);
  if (JSON.stringify(sectionIds) !== JSON.stringify(EXPECTED_IDS)) {
    throw new IngestValidationError(
      "LibriVox lock must contain exactly sections 153266–153292",
    );
  }
  for (const [key, source] of Object.entries(requireObject(
    lock.sources,
    "lock.sources",
  ))) {
    validateSource(source, `lock.sources.${key}`);
  }
  for (const [index, section] of lock.sections.entries()) {
    validateSource(section.media, `lock.sections[${index}].media`);
    if (
      section.sectionNumber !== index
      || !Number.isFinite(section.durationSeconds)
      || section.durationSeconds <= 0
      || typeof section.title !== "string"
      || typeof section.reader?.id !== "string"
      || typeof section.reader?.name !== "string"
    ) {
      throw new IngestValidationError(
        `lock.sections[${index}] has invalid metadata`,
      );
    }
  }
  requireObject(lock.rights, "lock.rights");
  return lock;
}

function captureRequest(source) {
  return {
    uri: source.uri,
    mediaType: source.mediaType,
    sourcePath: source.path,
    expectedByteLength: source.byteLength,
    expectedSha256: source.sha256,
  };
}

function isApprovedSourceTextUri(uri, sourceTextId) {
  try {
    const url = new URL(uri);
    const numericId = sourceTextId.replace(/^gutenberg-/, "");
    return url.protocol === "https:"
      && ["gutenberg.org", "www.gutenberg.org"].includes(url.hostname)
      && new RegExp(`/(?:ebooks|etext)/${numericId}/?$`).test(url.pathname);
  } catch {
    return false;
  }
}

function assertCatalogue(lock, catalogue) {
  const book = catalogue?.books?.[0];
  if (
    catalogue.books?.length !== 1
    || book.id !== lock.collection.bookId
    || String(book.num_sections) !== "27"
    || book.sections?.length !== 27
    || !isApprovedSourceTextUri(
      book.url_text_source,
      lock.collection.sourceTextId,
    )
  ) {
    throw new IngestValidationError(
      "Captured LibriVox catalogue does not describe book 1837 with 27 sections",
    );
  }
  for (const [index, expected] of lock.sections.entries()) {
    const section = book.sections[index];
    const reader = section?.readers?.[0];
    if (
      section?.id !== expected.id
      || Number(section.section_number) !== expected.sectionNumber
      || section.title !== expected.title
      || Number(section.playtime) !== expected.durationSeconds
      || section.listen_url !== expected.media.uri
      || String(reader?.reader_id) !== expected.reader.id
      || reader?.display_name !== expected.reader.name
    ) {
      throw new IngestValidationError(
        `Captured LibriVox section ${expected.id} differs from its lock`,
      );
    }
  }
}

function assertRightsReview(lock, review) {
  const rights = lock.rights;
  const scope = review?.scope;
  const expectedEvidence = new Map([
    ["recording-item", lock.sources.internetArchiveMetadata.sha256],
    ["source-text-jurisdiction", lock.sources.gutenbergRights.sha256],
  ]);
  const evidence = new Map(
    (review?.evidence ?? []).map((entry) => [
      entry.role,
      entry.capturedSha256,
    ]),
  );
  const permissions = [
    "redistributionAllowed",
    "commercialUseAllowed",
    "derivativesAllowed",
    "mlUseAllowed",
  ];
  if (
    review?.reviewId !== "librivox-1837-us-v1"
    || review?.reviewState !== rights.reviewState
    || review?.reviewedOn !== rights.reviewedOn
    || review?.jurisdiction !== rights.jurisdiction
    || review?.recording !== "public-domain"
    || review?.sourceText !== "public-domain"
    || scope?.bookId !== lock.collection.bookId
    || scope?.sourceTextId !== lock.collection.sourceTextId
    || scope?.internetArchiveId !== lock.collection.internetArchiveId
    || scope?.sectionIds?.first !== EXPECTED_IDS[0]
    || scope?.sectionIds?.last !== EXPECTED_IDS.at(-1)
    || scope?.sectionIds?.count !== EXPECTED_IDS.length
    || rights.controlledStatus !== "public-domain"
    || rights.statementUri
      !== "https://creativecommons.org/publicdomain/mark/1.0/"
    || permissions.some((field) =>
      review?.[field] !== true || rights[field] !== review[field]
    )
    || evidence.size !== expectedEvidence.size
    || [...expectedEvidence].some(([role, digest]) =>
      evidence.get(role) !== digest
    )
  ) {
    throw new IngestValidationError(
      "LibriVox source-text jurisdiction review is incomplete or disagrees with its lock",
    );
  }
}

export function createLibriVoxAdapter(inputLock) {
  const lock = validateLock(structuredClone(inputLock));
  return {
    key: "librivox-celtic-fairy-tales-1837",
    version: "1",
    archive: {
      name: "LibriVox",
      homepageUri: "https://librivox.org/",
      metadata: {
        mediaHost: "Internet Archive",
        bookId: lock.collection.bookId,
      },
    },

    async *read(context) {
      const shared = {};
      for (const key of [
        "catalogue",
        "internetArchiveMetadata",
        "gutenbergRights",
        "jurisdictionReview",
      ]) {
        const source = lock.sources[key];
        if (!source) {
          throw new IngestValidationError(
            `LibriVox lock is missing ${key} evidence`,
          );
        }
        shared[key] = await context.capture({
          sourceKey: key.replaceAll(/[A-Z]/g, (letter) =>
            `-${letter.toLowerCase()}`),
          role: key.includes("Rights") || key === "jurisdictionReview"
            ? "rights-evidence"
            : "catalogue",
          request: captureRequest(source),
        });
      }
      const catalogue = JSON.parse(
        await context.readText(shared.catalogue),
      );
      assertCatalogue(lock, catalogue);
      const internetArchiveMetadata = new XMLParser().parse(
        await context.readText(shared.internetArchiveMetadata),
      );
      if (
        internetArchiveMetadata?.metadata?.identifier
          !== lock.collection.internetArchiveId
        || !PUBLIC_DOMAIN_MARKERS.has(
          internetArchiveMetadata?.metadata?.licenseurl,
        )
      ) {
        throw new IngestValidationError(
          "Internet Archive metadata does not identify the approved public-domain media item",
        );
      }
      const jurisdictionReview = JSON.parse(
        await context.readText(shared.jurisdictionReview),
      );
      assertRightsReview(lock, jurisdictionReview);

      const startIndex = context.checkpoint?.index ?? 0;
      for (const [index, section] of lock.sections.entries()) {
        if (index < startIndex) continue;
        const audio = await context.capture({
          sourceKey: `section-${section.id}-audio-64kbps`,
          role: "audio",
          request: captureRequest(section.media),
        });
        yield {
          externalKey: `book-1837-section-${section.id}`,
          checkpointAfter: { index: index + 1 },
          captures: [
            audio,
            shared.jurisdictionReview,
            shared.internetArchiveMetadata,
          ],
          sourceItem: {
            externalKey: `book-1837-section-${section.id}`,
            nativeId: section.id,
            landingUri:
              "https://librivox.org/celtic-fairy-tales-by-joseph-jacobs/",
            metadata: {
              title: section.title,
              bookId: lock.collection.bookId,
              sectionId: section.id,
              sectionNumber: section.sectionNumber,
              sourceTextId: lock.collection.sourceTextId,
              sourceTextUri: lock.collection.sourceTextUri,
              internetArchiveId: lock.collection.internetArchiveId,
              catalogueCaptureId: shared.catalogue.captureId,
              internetArchiveMetadataCaptureId:
                shared.internetArchiveMetadata.captureId,
            },
          },
          witnesses: [{
            externalKey: "recording",
            kind: "audio-recording",
            metadata: {
              title: section.title,
              reader: section.reader.name,
              readerId: section.reader.id,
              durationSeconds: section.durationSeconds,
              sourceTextId: lock.collection.sourceTextId,
            },
            representations: [{
              externalKey: "audio-64kbps",
              captureKey: audio.key,
              kind: "audio",
              languageTag: lock.collection.languageTag,
              scriptCode: lock.collection.scriptCode ?? null,
              dialect: null,
              metadata: {
                encoding: "MP3",
                bitrateKbps: 64,
                mediaUri: section.media.uri,
                mediaSha256: section.media.sha256,
                mediaByteLength: section.media.byteLength,
                internetArchiveId: lock.collection.internetArchiveId,
              },
              derivation: {
                type: null,
                method: "source-provided-encoding",
                methodVersion: "librivox-adapter-1",
                deterministic: true,
              },
              passages: [{
                externalKey: "whole-section",
                ordinal: 1,
                sourceAnchor:
                  `librivox:1837:section:${section.id}:` +
                  `t=0,${section.durationSeconds}`,
                citationLabel:
                  `Celtic Fairy Tales, ${section.title}, ` +
                  `00:00–${section.durationSeconds}s`,
                languageTag: null,
                selector: {
                  type: "AudioTimeSelector",
                  startSeconds: 0,
                  endSeconds: section.durationSeconds,
                },
                quotedText: null,
              }],
            }],
          }],
          rights: {
            ...lock.rights,
            evidenceCaptureKeys: [
              shared.jurisdictionReview.key,
              shared.internetArchiveMetadata.key,
            ],
          },
        };
      }
    },
  };
}
