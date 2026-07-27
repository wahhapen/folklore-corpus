export const RIGHTS_USE_CASES = Object.freeze([
  Object.freeze({
    useCase: "evidence-use",
    releaseField: "evidenceUseAllowed",
    catalogueColumn: "evidence_use_allowed",
  }),
  Object.freeze({
    useCase: "quotation",
    releaseField: "quotationAllowed",
    catalogueColumn: "quotation_allowed",
  }),
  Object.freeze({
    useCase: "redistribution",
    releaseField: "redistributionAllowed",
    catalogueColumn: "redistribution_allowed",
  }),
  Object.freeze({
    useCase: "access-private-use",
    releaseField: "accessPrivateUseAllowed",
    catalogueColumn: "access_private_use_allowed",
  }),
  Object.freeze({
    useCase: "ml-evaluation",
    releaseField: "mlEvaluationAllowed",
    catalogueColumn: "ml_evaluation_allowed",
  }),
  Object.freeze({
    useCase: "ml-training",
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
}) {
  const fullyPermittedSubjects = new Set(
    rightsAssessments
      .filter((rights) =>
        rights.reviewState === "accepted"
        && RIGHTS_RELEASE_FIELDS.every((field) => rights[field] === true)
      )
      .map(({ subjectId }) => subjectId),
  );
  const governedSubjectIds = new Set([
    ...representations.flatMap(({ id, artifactId }) => [id, artifactId]),
    ...captures.map(({ rawSha256 }) =>
      `fa:artifact:sha256-${rawSha256}`),
  ]);
  return [...governedSubjectIds]
    .filter((id) => !fullyPermittedSubjects.has(id))
    .sort();
}
