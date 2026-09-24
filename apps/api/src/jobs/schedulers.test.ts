import { describe, expect, it, vi } from "vitest";
import { DAY_MS, MINUTE_MS } from "../lib/clock";
import { createLogger } from "../lib/logger";
import type { JobQueues } from "./queues";
import { registerSchedulers, TICK_SCHEDULES } from "./schedulers";

describe("registerSchedulers", () => {
  it("upserts tick.sweeper every 5 minutes and tick.prune daily on the ops queue", async () => {
    const upsertJobScheduler = vi.fn(() => Promise.resolve({}));
    const queue = vi.fn(() => ({ upsertJobScheduler }));
    const queues = { queue } as unknown as JobQueues;

    await registerSchedulers(queues, createLogger({ level: "silent", name: "schedulers-test" }));

    expect(queue.mock.calls.map((call) => call as unknown[])).toEqual([["ops"], ["ops"]]);
    expect(upsertJobScheduler.mock.calls).toEqual([
      [
        "tick.sweeper",
        { every: 5 * MINUTE_MS },
        { name: "tick.sweeper", data: {}, opts: { attempts: 1 } },
      ],
      ["tick.prune", { every: DAY_MS }, { name: "tick.prune", data: {}, opts: { attempts: 1 } }],
    ]);
    expect(TICK_SCHEDULES.map((schedule) => schedule.name)).toEqual(["tick.sweeper", "tick.prune"]);
  });
});
