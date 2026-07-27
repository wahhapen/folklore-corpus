function rights(evidenceCaptureKey) {
  return {
    evidenceCaptureKey,
    statementUri: "https://creativecommons.org/publicdomain/mark/1.0/",
    controlledStatus: "public-domain",
    rightsSource: "LibriVox fixture rights declaration",
    attributionText: "LibriVox recording of Celtic Fairy Tales",
    commercialUseAllowed: true,
    derivativesAllowed: true,
    evidenceUseAllowed: true,
    quotationAllowed: true,
    redistributionAllowed: true,
    accessPrivateUseAllowed: true,
    mlEvaluationAllowed: true,
    mlTrainingAllowed: true,
    mlUseAllowed: true,
    jurisdiction: "US",
    reviewedOn: "2026-07-25",
    reviewState: "accepted",
  };
}

export function createLibriVoxFixtureAdapter() {
  return {
    key: "librivox",
    version: "fixture-1",
    archive: {
      name: "LibriVox",
      homepageUri: "https://librivox.org/",
    },

    async *read(context) {
      const catalogue = await context.capture({
        sourceKey: "celtic-fairy-tales-catalogue",
        role: "catalogue",
        request: {
          uri: "fixture://librivox/catalogue",
          mediaType: "application/json",
        },
      });
      const catalogueText = await context.readText(catalogue);
      const metadata = JSON.parse(catalogueText);
      const section = metadata.sections[0];
      const audioEncodings = [];
      for (const encoding of [
        {
          key: "audio-64kbps",
          bitrate: 64,
          uri: section.audio64Uri,
        },
        {
          key: "audio-128kbps",
          bitrate: 128,
          uri: section.audio128Uri,
        },
      ]) {
        const capture = await context.capture({
          sourceKey:
            `celtic-fairy-tales-section-01-${encoding.bitrate}kbps`,
          role: "audio",
          request: {
            uri: encoding.uri,
            mediaType: "audio/mpeg",
          },
        });
        audioEncodings.push({ ...encoding, capture });
      }
      const rightsEvidence = await context.capture({
        sourceKey: "fixture-rights",
        role: "rights-evidence",
        request: {
          uri: "fixture://librivox/rights",
          mediaType: "text/plain; charset=utf-8",
        },
      });

      if ((context.checkpoint?.index ?? 0) >= 1) return;

      yield {
        externalKey: "celtic-fairy-tales-section-01",
        checkpointAfter: { index: 1 },
        captures: [
          catalogue,
          ...audioEncodings.map(({ capture }) => capture),
          rightsEvidence,
        ],
        sourceItem: {
          externalKey: "celtic-fairy-tales-section-01",
          nativeId: section.id,
          landingUri: "https://librivox.org/celtic-fairy-tales/",
          metadata: {
            sourceFormat: "LibriVox catalogue",
            catalogueCapture: catalogue.captureId,
          },
        },
        witnesses: [{
          externalKey: "recording",
          kind: "audio-recording",
          metadata: { title: section.title },
          representations: audioEncodings.map((encoding) => ({
            externalKey: encoding.key,
            captureKey: encoding.capture.key,
            kind: "audio",
            languageTag: section.language,
            scriptCode: null,
            dialect: null,
            metadata: {
              section: 1,
              bitrateKbps: encoding.bitrate,
            },
            derivation: {
              type: null,
              method: "librivox-catalogue-link",
              methodVersion: "fixture-1",
              deterministic: true,
            },
            passages: [{
              externalKey: "opening",
              ordinal: 1,
              sourceAnchor: "section-01:t=0,12.5",
              citationLabel:
                "Celtic Fairy Tales, section 1, 00:00–00:12.5",
              languageTag: null,
              selector: {
                type: "AudioTimeSelector",
                startSeconds: 0,
                endSeconds: section.durationSeconds,
              },
              quotedText: null,
            }],
          })),
        }],
        rights: rights(rightsEvidence.key),
      };
    },
  };
}
