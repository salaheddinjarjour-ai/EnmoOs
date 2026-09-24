import type { Deps } from "../deps";

/*
 * Every queue processor, by queue and job name (DESIGN §D). A Step A file (DESIGN §I): B-units
 * never edit it; each phase's integration step registers the processors its units wrote, and
 * runtime.ts starts consumers for the queues that have any.
 */

export const QUEUE_NAMES = ["agents", "media", "ops"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** The parts of a queued job a processor may rely on (a BullMQ Job satisfies it). */
export interface QueuedJob {
  readonly id?: string;
  readonly name: string;
  /** Untrusted until the processor parses it with its own schema. */
  readonly data: unknown;
  readonly attemptsMade: number;
}

export type JobProcessor = (job: QueuedJob, deps: Deps) => Promise<unknown>;

export type ProcessorRegistry = {
  readonly [Queue in QueueName]: Readonly<Record<string, JobProcessor>>;
};

/** Phase 1 has no background work. */
export const processors: ProcessorRegistry = { agents: {}, media: {}, ops: {} };

/** Queues with at least one registered processor. */
export function activeQueues(registry: ProcessorRegistry = processors): QueueName[] {
  return QUEUE_NAMES.filter((queue) => Object.keys(registry[queue]).length > 0);
}
