export const RIGHTS_USE_CASES = Object.freeze([
  Object.freeze({
    useCase: "evidence-use",
    releaseNoteName: "evidence use",
    releaseField: "evidenceUseAllowed",
    catalogueColumn: "evidence_use_allowed",
  }),
  Object.freeze({
    useCase: "quotation",
    releaseNoteName: "quotation",
    releaseField: "quotationAllowed",
    catalogueColumn: "quotation_allowed",
  }),
  Object.freeze({
    useCase: "redistribution",
    releaseNoteName: "redistribution",
    releaseField: "redistributionAllowed",
    catalogueColumn: "redistribution_allowed",
  }),
  Object.freeze({
    useCase: "access-private-use",
    releaseNoteName: "access/private use",
    releaseField: "accessPrivateUseAllowed",
    catalogueColumn: "access_private_use_allowed",
  }),
  Object.freeze({
    useCase: "ml-evaluation",
    releaseNoteName: "ML evaluation",
    releaseField: "mlEvaluationAllowed",
    catalogueColumn: "ml_evaluation_allowed",
  }),
  Object.freeze({
    useCase: "ml-training",
    releaseNoteName: "ML training",
    releaseField: "mlTrainingAllowed",
    catalogueColumn: "ml_training_allowed",
  }),
]);

export const RIGHTS_RELEASE_FIELDS = Object.freeze(
  RIGHTS_USE_CASES.map(({ releaseField }) => releaseField),
);

export function findRightsCoverageGaps({
  captures,
  representations,
  rightsAssessments,
}, requiredUseCase) {
  const contract = RIGHTS_USE_CASES.find(
    ({ useCase }) => useCase === requiredUseCase,
  );
  if (!contract) {
    throw new Error(`Unsupported rights use case: ${requiredUseCase}`);
  }
  const permittedSubjects = new Set(
    rightsAssessments
      .filter((rights) =>
        rights.reviewState === "accepted"
        && rights[contract.releaseField] === true
      )
      .map(({ subjectId }) => subjectId),
  );
  const governedSubjectIds = new Set([
    ...representations.flatMap(({ id, artifactId }) => [id, artifactId]),
    ...captures.map(({ rawSha256 }) =>
      `fa:artifact:sha256-${rawSha256}`),
  ]);
  return [...governedSubjectIds]
    .filter((id) => !permittedSubjects.has(id))
    .sort();
}

export function findRightsCoverageGapsByUseCase(release) {
  return Object.fromEntries(
    RIGHTS_USE_CASES.map(({ useCase }) => [
      useCase,
      findRightsCoverageGaps(release, useCase),
    ]),
  );
}

export function assertReleasePublicationRights(gapsByUseCase) {
  const evidenceUseGaps = gapsByUseCase["evidence-use"];
  if (!Array.isArray(evidenceUseGaps) || evidenceUseGaps.length > 0) {
    throw new Error(
      "Fail-closed evidence-use Rights coverage gaps: " +
      JSON.stringify(evidenceUseGaps),
    );
  }
}
