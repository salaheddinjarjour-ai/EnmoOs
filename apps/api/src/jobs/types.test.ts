import { describe, expect, it } from "vitest";
import { runAttempt } from "./types";

const job = (attemptsMade: number, attempts?: number) => ({
  name: "manager.intake",
  data: {},
  attemptsMade,
  opts: attempts === undefined ? {} : { attempts },
});

describe("runAttempt", () => {
  it("marks BullMQ's last attempt, the one whose error is not retried", () => {
    expect([0, 1, 2].map((made) => runAttempt(job(made, 3)).isLast)).toEqual([false, false, true]);
    expect(runAttempt(job(0, 1)).isLast).toBe(true);
  });

  it("falls back to the default of three attempts", () => {
    expect(runAttempt(job(1)).isLast).toBe(false);
    expect(runAttempt(job(2)).isLast).toBe(true);
  });
});
