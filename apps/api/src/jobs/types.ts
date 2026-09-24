import type { Deps } from "../deps";
import { DEFAULT_JOB_OPTIONS } from "./queues";

/** The parts of a queued job a processor may rely on (a BullMQ Job satisfies it). */
export interface QueuedJob {
  readonly id?: string;
  readonly name: string;
  /** Untrusted until the processor parses it (queues.ts parseJobData). */
  readonly data: unknown;
  /** Attempts already made before this one (0 on the first run). */
  readonly attemptsMade: number;
  /** `attempts` tells a processor whether this run is its last (attemptsMade + 1 === attempts). */
  readonly opts: { readonly attempts?: number };
}

/**
 * Handles one job. Throwing makes BullMQ retry it (DEFAULT_JOB_OPTIONS); throw bullmq's
 * UnrecoverableError for a failure no retry can fix.
 */
export type JobProcessor = (job: QueuedJob, deps: Deps) => Promise<unknown>;

/** Where a processor's run sits among BullMQ's attempts. */
export interface RunAttempt {
  /** This is BullMQ's last attempt: a thrown error will not be retried. */
  isLast: boolean;
}

export function runAttempt(job: QueuedJob): RunAttempt {
  const attempts = job.opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts;
  return { isLast: job.attemptsMade + 1 >= attempts };
}
