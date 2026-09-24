import { runPlan } from "../../orchestrator/plan";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * manager.plan (DESIGN §C "Manager plan", §D). Parses ManagerPlanJob and runs MANAGER.plan with
 * the brief, PIPELINE_ACTIONS and the change request verbatim; stores TaskGraph `version`
 * (PROPOSED, code-computed estimate), supersedes the previous one and posts the PLAN message
 * (plan.proposed). Nothing is generated until a human approves the plan. When the last attempt
 * fails, the Manager says so in the thread and an alert goes out.
 */
export const managerPlanProcessor: JobProcessor = async (job, deps) => {
  await runPlan(deps, parseJobData(JOB.managerPlan, job.data), runAttempt(job));
};
