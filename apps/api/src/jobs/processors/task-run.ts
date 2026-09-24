import { runTask } from "../../orchestrator/run-task";
import { JOB, parseJobData } from "../queues";
import { runAttempt, type JobProcessor } from "../types";

/**
 * task.run (DESIGN §D "Graph lifecycle"). Parses TaskRunJob; does nothing unless the AgentTask is
 * QUEUED or RUNNING. Marks it RUNNING, moves the post's status, builds the agent input from the
 * database, runs the agent, stores the output and advances the graph; AgentEscalation → ESCALATED,
 * BudgetExceeded → BLOCKED_BUDGET. On BullMQ's last attempt a transport failure marks the task
 * FAILED (with an alert) before the job fails.
 */
export const taskRunProcessor: JobProcessor = async (job, deps) => {
  await runTask(deps, parseJobData(JOB.taskRun, job.data), runAttempt(job));
};
