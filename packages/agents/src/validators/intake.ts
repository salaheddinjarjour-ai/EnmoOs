import {
  PLATFORM_LABEL,
  type Brief,
  type IntakeClarify,
  type Issue,
  type ManagerIntakeInput,
  type ManagerIntakeOutput,
} from "@enmo/shared";

/*
 * manager.intake business rules (DESIGN §C): the post mix adds up, the window starts today or
 * later and doesn't run backwards, the client is one of the roster, and the platforms are enabled
 * for it. A clarify must be the ONE consolidated question, and only while it is still allowed.
 */

const QUESTION_MARKS = /[?？؟]/g;

function clarifyIssues(clarify: IntakeClarify, input: ManagerIntakeInput): Issue[] {
  const issues: Issue[] = [];
  if (!input.allowClarify) {
    issues.push({
      path: "result.kind",
      message:
        "The one clarifying question has already been asked. Return the brief now and record every remaining gap as an assumption.",
    });
  }
  const questionMarks = clarify.question.match(QUESTION_MARKS)?.length ?? 0;
  if (questionMarks > 1) {
    issues.push({
      path: "result.question",
      message: `Ask ONE consolidated question (this has ${questionMarks} question marks): fold every gap into a single sentence.`,
    });
  }
  const seen = new Set<string>();
  clarify.missing.forEach((gap, i) => {
    if (seen.has(gap))
      issues.push({ path: `result.missing[${i}]`, message: `"${gap}" is listed twice.` });
    seen.add(gap);
  });
  const { clientId } = clarify.draft;
  if (clientId !== null && !input.clients.some((client) => client.id === clientId)) {
    issues.push({
      path: "result.draft.clientId",
      message: `"${clientId}" is not a client id from the roster.`,
    });
  }
  return issues;
}

function briefIssues(brief: Brief, input: ManagerIntakeInput): Issue[] {
  const issues: Issue[] = [];
  const path = (field: string) => `result.brief.${field}`;

  const mixTotal = brief.postMix.reduce((sum, item) => sum + item.count, 0);
  if (mixTotal !== brief.postCount) {
    issues.push({
      path: path("postMix"),
      message: `The post mix adds up to ${mixTotal} but postCount is ${brief.postCount}; make them match.`,
    });
  }

  if (brief.window.start < input.today) {
    issues.push({
      path: path("window.start"),
      message: `The window starts ${brief.window.start}, before today (${input.today}); it must start today or later.`,
    });
  }
  if (brief.window.end < brief.window.start) {
    issues.push({
      path: path("window.end"),
      message: `The window ends ${brief.window.end}, before it starts (${brief.window.start}).`,
    });
  }

  const client = input.clients.find((candidate) => candidate.id === brief.clientId);
  if (!client) {
    const roster = input.clients.map((c) => `${c.name} (${c.id})`).join(", ") || "none";
    issues.push({
      path: path("clientId"),
      message: `"${brief.clientId}" is not a client id from the roster: ${roster}.`,
    });
  } else if (input.selectedClientId !== null && brief.clientId !== input.selectedClientId) {
    issues.push({
      path: path("clientId"),
      message: `This campaign was started for client ${input.selectedClientId}; the brief must use that id.`,
    });
  }

  const seen = new Set<string>();
  brief.platforms.forEach((platform, i) => {
    if (seen.has(platform)) {
      issues.push({
        path: path(`platforms[${i}]`),
        message: `${PLATFORM_LABEL[platform]} is listed twice.`,
      });
    } else if (client && !client.enabledPlatforms.includes(platform)) {
      const enabled = client.enabledPlatforms.map((p) => PLATFORM_LABEL[p]).join(", ") || "none";
      issues.push({
        path: path(`platforms[${i}]`),
        message: `${PLATFORM_LABEL[platform]} is not enabled for ${client.name} (enabled: ${enabled}).`,
      });
    }
    seen.add(platform);
  });
  return issues;
}

/** MANAGER.intake business rules; [] when the result can be posted to the thread. */
export function validateIntake(output: ManagerIntakeOutput, input: ManagerIntakeInput): Issue[] {
  return output.result.kind === "clarify"
    ? clarifyIssues(output.result, input)
    : briefIssues(output.result.brief, input);
}
