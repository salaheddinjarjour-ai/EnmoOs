import type { ProgressEntry } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { batchLine, isSettled, newlySettled, refNumber } from "./progress";

const entry = (overrides: Partial<ProgressEntry>): ProgressEntry => ({
  agent: "COPYWRITER",
  done: 0,
  total: 12,
  running: 0,
  waiting: 0,
  escalated: 0,
  blocked: 0,
  ...overrides,
});

describe("batch settling", () => {
  it("is settled once every task is done or escalated", () => {
    expect(isSettled(entry({ done: 12 }))).toBe(true);
    expect(isSettled(entry({ done: 11, escalated: 1 }))).toBe(true);
    expect(isSettled(entry({ done: 11, running: 1 }))).toBe(false);
    expect(isSettled(entry({ total: 0 }))).toBe(false);
  });

  it("counts tasks on hold behind an escalation as settled, until the escalation is retried", () => {
    // p5's draft escalated: its QA can't run, so the other eleven are the whole batch for now.
    const onHold = entry({ agent: "MANAGER", done: 11, blocked: 1 });
    expect(isSettled(onHold)).toBe(true);
    expect(isSettled(entry({ agent: "MANAGER", done: 10, running: 1, blocked: 1 }))).toBe(false);
    const qaWaiting = entry({ agent: "MANAGER", done: 10, blocked: 1 });
    expect(newlySettled([qaWaiting], [onHold])).toEqual([onHold]);
    // The retry unblocks p5's QA (plain PENDING again): the batch reopens, then settles again.
    const reopened = entry({ agent: "MANAGER", done: 11 });
    expect(isSettled(reopened)).toBe(false);
    const all = entry({ agent: "MANAGER", done: 12 });
    expect(newlySettled([reopened], [all])).toEqual([all]);
  });

  it("announces a batch only on the recount that settles it", () => {
    const writing = entry({ done: 11, running: 1 });
    const done = entry({ done: 12 });
    expect(newlySettled([writing], [done])).toEqual([done]);
    expect(newlySettled([done], [done])).toEqual([]);
    // A revision reopens the batch; finishing it settles it again.
    expect(
      newlySettled([entry({ done: 12, total: 13, running: 1 })], [entry({ done: 13, total: 13 })]),
    ).toHaveLength(1);
    expect(newlySettled([], [entry({ done: 1, total: 1 })])).toHaveLength(1);
  });

  it("describes a settled batch", () => {
    expect(batchLine(entry({ done: 12 }))).toBe("Copywriter ✓ 12/12 — copy drafted.");
    expect(batchLine(entry({ agent: "MANAGER", done: 11, escalated: 1 }))).toBe(
      "Manager ✓ 11/12 — QA complete. 1 task escalated to a human.",
    );
    expect(batchLine(entry({ agent: "MANAGER", done: 10, blocked: 2 }))).toBe(
      "Manager ✓ 10/12 — QA complete. 2 tasks on hold until an escalated task is resolved.",
    );
  });
});

describe("refNumber", () => {
  it("orders post refs numerically", () => {
    expect(["p10", "p2", "p1"].sort((a, b) => refNumber(a) - refNumber(b))).toEqual([
      "p1",
      "p2",
      "p10",
    ]);
    expect(refNumber("x")).toBe(Number.MAX_SAFE_INTEGER);
  });
});
