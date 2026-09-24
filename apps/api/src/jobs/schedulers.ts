import type { RepeatOptions } from "bullmq";
import { DAY_MS, MINUTE_MS } from "../lib/clock";
import type { Logger } from "../lib/logger";
import { JOB, JOB_OPTIONS, JOB_QUEUE, type JobQueues, type TickJobName } from "./queues";

/*
 * The scheduler ticks (DESIGN §D "Queues and schedulers"), registered with upsertJobScheduler on
 * worker boot unless SCHEDULERS_ENABLED=false (tests call the tick processors directly). Upserting
 * is idempotent, so every worker process may register them; the scheduler id is the job name, so
 * a changed interval replaces the old schedule instead of adding a second one. Later phases add
 * tick.publish, tick.metrics, tick.tokens and tick.analyst here.
 */

export interface TickSchedule {
  name: TickJobName;
  repeat: Omit<RepeatOptions, "key">;
}

export const TICK_SCHEDULES: readonly TickSchedule[] = [
  { name: JOB.tickSweeper, repeat: { every: 5 * MINUTE_MS } },
  { name: JOB.tickPrune, repeat: { every: DAY_MS } },
];

export async function registerSchedulers(queues: JobQueues, logger: Logger): Promise<void> {
  for (const { name, repeat } of TICK_SCHEDULES) {
    await queues.queue(JOB_QUEUE[name]).upsertJobScheduler(name, repeat, {
      name,
      data: {},
      opts: { ...JOB_OPTIONS[name] },
    });
  }
  logger.info({ schedulers: TICK_SCHEDULES.map(({ name }) => name) }, "job schedulers registered");
}
