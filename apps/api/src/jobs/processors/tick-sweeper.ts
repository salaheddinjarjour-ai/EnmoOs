import { sweep } from "../../orchestrator/sweeper";
import type { JobProcessor } from "../types";

/**
 * tick.sweeper, every 5 minutes (DESIGN §D "Sweeper"): re-queue QUEUED/RUNNING tasks stuck for
 * more than 15 minutes with no live job once (then FAILED with an alert), re-queue BLOCKED_BUDGET
 * tasks once today's budget has room, i.e. after the UTC day rolls over, queue ready PENDING
 * tasks of approved graphs that nothing queued, and drive stale renders.
 */
export const tickSweeperProcessor: JobProcessor = async (_job, deps) => {
  const report = await sweep(deps);
  if (Object.values(report).some((count) => count > 0)) {
    deps.logger.info(report, "sweeper acted on tasks");
  }
  return report;
};
