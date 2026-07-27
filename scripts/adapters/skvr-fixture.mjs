function rights(evidenceCaptureKey) {
  return {
    evidenceCaptureKey,
    statementUri: "https://creativecommons.org/licenses/by/4.0/",
    controlledStatus: "licensed",
    rightsSource: "SKVR fixture rights declaration",
    attributionText: "Suomalaisen Kirjallisuuden Seura, SKVR",
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
    reviewedOn: "2026-07-25",
    reviewState: "accepted",
  };
}

export function createSkvrFixtureAdapter() {
  return {
    key: "skvr",
    version: "fixture-1",
    archive: {
      name: "Suomen Kansan Vanhat Runot",
      homepageUri: "https://skvr.fi/",
    },

    async *read(context) {
      const tei = await context.capture({
        sourceKey: "fixture-tei",
        role: "structured-text",
        request: {
          uri: "fixture://skvr/tei",
          mediaType: "application/tei+xml",
        },
      });
      const rightsEvidence = await context.capture({
        sourceKey: "fixture-rights",
        role: "rights-evidence",
        request: {
          uri: "fixture://skvr/rights",
          mediaType: "text/plain; charset=utf-8",
        },
      });

      if ((context.checkpoint?.index ?? 0) >= 1) return;
      const xml = await context.readText(tei);
      const record = xml.match(
        /<div type="poem" xml:id="([^"]+)">[\s\S]*?<head>([^<]+)<\/head>[\s\S]*?<lg>([\s\S]*?)<\/lg>/,
      );
      if (!record) throw new Error("SKVR fixture has no TEI poem");
      const lines = [...record[3].matchAll(/<l n="(\d+)">([^<]+)<\/l>/g)]
        .map((match) => ({ number: Number(match[1]), text: match[2] }));
      if (lines.length === 0) throw new Error("SKVR fixture has no TEI lines");

      yield {
        externalKey: "skvr-i1-1",
        checkpointAfter: { index: 1 },
        captures: [tei, rightsEvidence],
        sourceItem: {
          externalKey: "skvr-i1-1",
          nativeId: record[1],
          landingUri: "https://skvr.fi/poem/skvr-I1-1",
          metadata: { sourceFormat: "TEI" },
        },
        witnesses: [{
          externalKey: "poem",
          kind: "text",
          metadata: { title: record[2] },
          representations: [{
            externalKey: "tei-transcript",
            captureKey: tei.key,
            kind: "diplomatic-transcript",
            languageTag: "fi",
            scriptCode: "Latn",
            dialect: null,
            metadata: { xmlId: record[1] },
            derivation: {
              type: "transcription",
              method: "skvr-tei-record",
              methodVersion: "fixture-1",
              deterministic: true,
            },
            passages: [{
              externalKey: "lines-1-2",
              ordinal: 1,
              sourceAnchor: "skvr-I1-1:lines:1-2",
              citationLabel: "SKVR I1:1, lines 1–2",
              languageTag: null,
              selector: {
                type: "LineSelector",
                startLine: lines[0].number,
                endLine: lines.at(-1).number,
              },
              quotedText: lines.map(({ text }) => text).join("\n"),
            }],
          }],
        }],
        rights: rights(rightsEvidence.key),
      };
    },
  };
}
