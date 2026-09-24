import { managerIntakeProcessor } from "./processors/manager-intake";
import { managerPlanProcessor } from "./processors/manager-plan";
import { taskRunProcessor } from "./processors/task-run";
import { tickPruneProcessor } from "./processors/tick-prune";
import { tickSweeperProcessor } from "./processors/tick-sweeper";
import { JOB, QUEUE_NAMES, type QueueName } from "./queues";
import type { JobProcessor } from "./types";

export type { JobProcessor, QueuedJob } from "./types";

/*
 * Every queue processor, by queue and job name (DESIGN §D). A Step A file (DESIGN §I): B-units
 * never edit it; each phase's Step A registers the processors its units fill in, and runtime.ts
 * starts consumers for the queues that have any. queues.ts JOB_QUEUE says which queue each job
 * name belongs on (registry.test.ts keeps the two in step).
 */

export type ProcessorRegistry = {
  readonly [Queue in QueueName]: Readonly<Record<string, JobProcessor>>;
};

export const processors: ProcessorRegistry = {
  agents: {
    [JOB.managerIntake]: managerIntakeProcessor,
    [JOB.managerPlan]: managerPlanProcessor,
    [JOB.taskRun]: taskRunProcessor,
  },
  media: {},
  ops: {
    [JOB.tickSweeper]: tickSweeperProcessor,
    [JOB.tickPrune]: tickPruneProcessor,
  },
};

/** Queues with at least one registered processor. */
export function activeQueues(registry: ProcessorRegistry = processors): QueueName[] {
  return QUEUE_NAMES.filter((queue) => Object.keys(registry[queue]).length > 0);
}

/** The processor for `name` on `queue`, or undefined when none is registered there. */
export function processorFor(
  registry: ProcessorRegistry,
  queue: QueueName,
  name: string,
): JobProcessor | undefined {
  return Object.hasOwn(registry[queue], name) ? registry[queue][name] : undefined;
}
