export function supportsLanguageSensitiveUse(translation) {
  return translation.reviewStatus === "accepted";
}

export function findTranslationContractGaps({
  translations,
  representations,
  derivations,
  manifestArtifactIds,
}) {
  const representationIds = new Set(
    representations.map(({ id }) => id),
  );
  const translationDerivationPairs = new Set(
    derivations.filter(({ type }) => type === "translation")
      .flatMap(({ inputIds, outputIds }) =>
        inputIds.flatMap((inputId) =>
          outputIds.map((outputId) => `${inputId}\0${outputId}`)
        )
      ),
  );
  const outputCounts = new Map();
  for (const { translationRepresentationId } of translations) {
    outputCounts.set(
      translationRepresentationId,
      (outputCounts.get(translationRepresentationId) ?? 0) + 1,
    );
  }
  return translations.flatMap((translation) => {
    const reasons = [];
    if (
      outputCounts.get(translation.translationRepresentationId) > 1
    ) {
      reasons.push("duplicate-translation-representation");
    }
    if (
      translation.translationRepresentationId
        === translation.sourceRepresentationId
    ) {
      reasons.push("source-equals-translation");
    }
    if (!representationIds.has(translation.translationRepresentationId)) {
      reasons.push("missing-translation-representation");
    }
    if (!representationIds.has(translation.sourceRepresentationId)) {
      reasons.push("missing-source-representation");
    }
    const hasDerivation = translationDerivationPairs.has(
      `${translation.sourceRepresentationId}\0` +
      translation.translationRepresentationId,
    );
    if (!hasDerivation) reasons.push("missing-translation-derivation");
    if (
      translation.reviewEvidenceArtifactId
      && !manifestArtifactIds.has(translation.reviewEvidenceArtifactId)
    ) {
      reasons.push("missing-review-evidence");
    }
    return reasons.length > 0 ? [{ id: translation.id, reasons }] : [];
  });
}
