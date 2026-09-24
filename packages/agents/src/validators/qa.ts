import {
  CopywriterOutput,
  type Issue,
  type ManagerQaInput,
  type ManagerQaOutput,
} from "@enmo/shared";

/*
 * manager.qa business rules: the verdict and its issues agree, every issue is routed to a
 * specialist whose work is actually under review and names a real field of it, and a failed
 * automated check never passes.
 */

const COPY_FIELDS = new Set(Object.keys(CopywriterOutput.shape));

/** The top-level key of a field path: "script.scenes[0].voiceover" → "script". */
function rootField(field: string): string {
  return field.trim().split(/[.[]/, 1)[0] ?? "";
}

export function validateQa(output: ManagerQaOutput, input: ManagerQaInput): Issue[] {
  const issues: Issue[] = [];

  if (output.verdict === "revise" && output.issues.length === 0) {
    issues.push({
      path: "issues",
      message: "A revise verdict needs at least one issue saying what to change.",
    });
  }
  if (output.verdict === "pass" && output.issues.length > 0) {
    issues.push({
      path: "issues",
      message: "A pass verdict has no issues; either leave issues empty or return revise.",
    });
  }
  const failed = input.automatedChecks.filter((check) => !check.passed);
  if (output.verdict === "pass" && failed.length > 0) {
    issues.push({
      path: "verdict",
      message: `Automated checks failed (${failed.map((check) => check.name).join(", ")}); return revise with an issue for each.`,
    });
  }
  if (!output.summaryForReviewer.trim()) {
    issues.push({
      path: "summaryForReviewer",
      message: "Write one or two sentences for the human reviewer.",
    });
  }

  output.issues.forEach((issue, i) => {
    switch (issue.target) {
      case "COPYWRITER":
        if (!COPY_FIELDS.has(rootField(issue.field))) {
          issues.push({
            path: `issues[${i}].field`,
            message: `"${issue.field}" is not a copy field; use one of ${[...COPY_FIELDS].join(", ")} (optionally with a sub-path).`,
          });
        }
        break;
      case "VISUAL_DIRECTOR":
        if (!input.visuals?.length) {
          issues.push({
            path: `issues[${i}].target`,
            message:
              "There are no visuals to review for this post; route copy problems to COPYWRITER.",
          });
        }
        break;
      case "ADAPTER":
        if (!input.variants?.length) {
          issues.push({
            path: `issues[${i}].target`,
            message:
              "There are no platform variants to review for this post; route copy problems to COPYWRITER.",
          });
        }
        break;
    }
    if (!issue.instruction.trim()) {
      issues.push({
        path: `issues[${i}].instruction`,
        message: "Say exactly what the specialist should change.",
      });
    }
  });
  return issues;
}
