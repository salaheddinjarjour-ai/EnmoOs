import { z } from "zod";

/**
 * One reason an agent output (or a task graph) was rejected. The runner feeds these back to the
 * model verbatim, AgentEscalation carries them, and AgentRun.validationErrors stores them, so
 * every validator in the system speaks this one shape.
 */
export const Issue = z.object({
  /** JSON path into the checked value, e.g. `nodes[3].deps[0]`; "" for the value as a whole. */
  path: z.string(),
  message: z.string(),
});
export type Issue = z.infer<typeof Issue>;

/** `["script", "scenes", 2, "startSec"]` → `script.scenes[2].startSec`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out;
}

/** Prefixes each issue's path, for validators that check a nested part of a larger value. */
export function nestIssues(prefix: string, issues: readonly Issue[]): Issue[] {
  if (!prefix) return [...issues];
  return issues.map((issue) => ({
    path: !issue.path
      ? prefix
      : issue.path.startsWith("[")
        ? prefix + issue.path
        : `${prefix}.${issue.path}`,
    message: issue.message,
  }));
}

/** Zod failures in the shared Issue shape (the runner's retry prompt lists them). */
export function issuesFromZodError(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}
