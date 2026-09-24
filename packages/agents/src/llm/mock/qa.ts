import {
  PLATFORM_LABEL,
  type AutomatedCheck,
  type ManagerQaInput,
  type ManagerQaOutput,
  type QaIssue,
} from "@enmo/shared";
import { POST_TYPE_NOUN, joinList } from "./text";

/*
 * manager.qa for MockLlm: passes unless an automated check failed, in which case each failure
 * goes back to the Copywriter as a concrete instruction. The `weak` fault forces one revise.
 */

/** The copy field an automated check is about, by its name. */
function fieldFor(check: AutomatedCheck): string {
  const name = check.name.toLowerCase();
  if (name.includes("hashtag")) return "hashtags";
  if (name.includes("script") || name.includes("hook") || name.includes("scene")) return "script";
  if (name.includes("slide")) return "slides";
  if (name.includes("platform")) return "platformCaptions";
  if (name.includes("screen")) return "onScreenText";
  return "caption";
}

function describe(input: ManagerQaInput): string {
  const [singular] = POST_TYPE_NOUN[input.post.type];
  return `${singular} for ${joinList(input.post.platforms.map((p) => PLATFORM_LABEL[p]))}`;
}

export function mockQa(input: ManagerQaInput): ManagerQaOutput {
  const failed = input.automatedChecks.filter((check) => !check.passed);
  if (failed.length === 0) {
    return {
      verdict: "pass",
      issues: [],
      summaryForReviewer: `On brief and on voice: this ${describe(input)} lands the angle "${input.post.angle}" and clears every automated check.`,
    };
  }
  const issues: QaIssue[] = failed.map((check) => ({
    target: "COPYWRITER",
    field: fieldFor(check),
    problem: `Automated check "${check.name}" failed${check.detail ? `: ${check.detail}` : "."}`,
    instruction: `Fix the ${fieldFor(check)} so "${check.name}" passes, keeping the angle and voice intact.`,
  }));
  return {
    verdict: "revise",
    issues,
    summaryForReviewer: `Sent back once: ${failed.length} automated check${failed.length === 1 ? "" : "s"} failed on this ${describe(input)}.`,
  };
}

/** A revise verdict on otherwise clean copy (the `weak` fault). */
export function mockWeakQa(input: ManagerQaInput): ManagerQaOutput {
  return {
    verdict: "revise",
    issues: [
      {
        target: "COPYWRITER",
        field: "caption",
        problem: "The opening line is generic; it could belong to any brand.",
        instruction: `Rewrite the first line of the caption so it names the ${input.brief.productFocus ?? "product"} and earns the stop in under five words.`,
      },
    ],
    summaryForReviewer: `Sent back once to sharpen the hook of this ${describe(input)}.`,
  };
}
