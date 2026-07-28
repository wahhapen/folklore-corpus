import { fileURLToPath } from "node:url";

import { RIGHTS_USE_CASES } from "./lib/rights-contract-v2.mjs";

function listWithAnd(values) {
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function rightsContractReleaseNote() {
  const axes = listWithAnd(
    RIGHTS_USE_CASES.map(({ releaseNoteName }) => releaseNoteName),
  );
  return "This release adds Rights Contract v2 with six independent " +
    `fail-closed decisions: ${axes}. It also records translation as an ` +
    "explicit provenance relationship between released Representations, " +
    "including source Representation, producer class, and review status.";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${rightsContractReleaseNote()}\n`);
}
