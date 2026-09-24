import {
  validateTaskGraph,
  type Issue,
  type ManagerPlanInput,
  type ManagerPlanOutput,
} from "@enmo/shared";

/**
 * manager.plan business rules: the shared task-graph validator, plus no post dated before today
 * (a re-plan can happen after the window has opened).
 */
export function validatePlan(output: ManagerPlanOutput, input: ManagerPlanInput): Issue[] {
  const issues = validateTaskGraph(output, input.brief, input.enabledActions);
  output.posts.forEach((post, i) => {
    if (post.targetDate < input.today) {
      issues.push({
        path: `posts[${i}].targetDate`,
        message: `${post.targetDate} is in the past (today is ${input.today}).`,
      });
    }
  });
  return issues;
}
