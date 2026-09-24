import { runIntake } from "../../orchestrator/intake";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * manager.intake (DESIGN §C "Manager intake", §D). Parses ManagerIntakeJob, loads the thread, the
 * clients and the campaign, and runs MANAGER.intake — with the clarify branch only while
 * Campaign.clarifyCount is 0. A clarify becomes one CLARIFY message and clarifyCount 1; a brief is
 * stored on the campaign (BRIEF message, briefLockedAt) and queues manager.plan version 1. A job
 * whose message a newer team message or a Manager reply overtook does nothing. When the
 * last attempt fails (provider or infrastructure down), the Manager says so in the thread and an
 * alert goes out, so the thread never waits on a job that is gone.
 */
export const managerIntakeProcessor: JobProcessor = async (job, deps) => {
  await runIntake(deps, parseJobData(JOB.managerIntake, job.data), runAttempt(job));
};
