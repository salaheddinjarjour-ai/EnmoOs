import { describe, expect, it } from "vitest";
import {
  ProgressAggregate,
  ProgressEntry,
  aggregateProgress,
  blockedTaskIds,
  formatProgress,
  type TaskStatus,
} from "../src";

const entry = (partial: Partial<ProgressEntry> & Pick<ProgressEntry, "agent">): ProgressEntry => ({
  done: 0,
  total: 0,
  running: 0,
  waiting: 0,
  escalated: 0,
  blocked: 0,
  ...partial,
});

describe("formatProgress", () => {
  it("renders the design's example line", () => {
    expect(
      formatProgress([
        entry({ agent: "COPYWRITER", done: 12, total: 12 }),
        entry({ agent: "VISUAL_DIRECTOR", done: 2, total: 4, waiting: 2 }),
      ]),
    ).toBe("Copywriter ✓ 12/12 — Visual Director rendering 2/4…");
  });

  it("ticks an agent only when every task is done", () => {
    expect(formatProgress([entry({ agent: "COPYWRITER", done: 12, total: 12 })])).toBe(
      "Copywriter ✓ 12/12",
    );
    expect(formatProgress([entry({ agent: "COPYWRITER", done: 11, total: 12, running: 1 })])).toBe(
      "Copywriter writing 11/12…",
    );
  });

  it("orders agents along the pipeline, whatever the input order", () => {
    expect(
      formatProgress([
        entry({ agent: "MANAGER", done: 0, total: 12 }),
        entry({ agent: "COPYWRITER", done: 3, total: 12, running: 4 }),
        entry({ agent: "STRATEGIST", done: 1, total: 1 }),
      ]),
    ).toBe("Strategist ✓ 1/1 — Copywriter writing 3/12… — Manager queued 0/12");
  });

  it("shows escalations", () => {
    expect(
      formatProgress([entry({ agent: "COPYWRITER", done: 11, total: 12, escalated: 1 })]),
    ).toBe("Copywriter 11/12 · 1 escalated");
    expect(
      formatProgress([
        entry({ agent: "COPYWRITER", done: 9, total: 12, running: 2, escalated: 1 }),
      ]),
    ).toBe("Copywriter writing 9/12 · 1 escalated…");
  });

  it("shows paused work between batches as plain counts", () => {
    expect(formatProgress([entry({ agent: "MANAGER", done: 4, total: 12 })])).toBe("Manager 4/12");
  });

  it("leaves out agents without tasks and returns '' when there is nothing", () => {
    expect(formatProgress([entry({ agent: "ADAPTER" })])).toBe("");
    expect(formatProgress([])).toBe("");
  });

  it("does not mutate its input", () => {
    const input = [entry({ agent: "MANAGER", total: 1 }), entry({ agent: "COPYWRITER", total: 1 })];
    formatProgress(input);
    expect(input.map((e) => e.agent)).toEqual(["MANAGER", "COPYWRITER"]);
  });
});

describe("aggregateProgress", () => {
  const task = (agent: "COPYWRITER" | "MANAGER", status: TaskStatus) => ({ agent, status });

  it("counts task statuses per agent in pipeline order", () => {
    const aggregate = aggregateProgress([
      task("MANAGER", "PENDING"),
      task("COPYWRITER", "SUCCEEDED"),
      task("COPYWRITER", "RUNNING"),
      task("COPYWRITER", "QUEUED"),
      task("COPYWRITER", "WAITING"),
      task("COPYWRITER", "ESCALATED"),
      task("COPYWRITER", "FAILED"),
      task("COPYWRITER", "BLOCKED_BUDGET"),
      task("COPYWRITER", "CANCELLED"),
    ]);
    expect(ProgressAggregate.parse(aggregate)).toEqual([
      { agent: "COPYWRITER", done: 1, total: 7, running: 2, waiting: 1, escalated: 2, blocked: 0 },
      { agent: "MANAGER", done: 0, total: 1, running: 0, waiting: 0, escalated: 0, blocked: 0 },
    ]);
  });

  it("counts PENDING tasks stuck behind an escalated, failed or cancelled task as blocked", () => {
    const aggregate = aggregateProgress([
      { id: "w1", agent: "COPYWRITER", status: "SUCCEEDED", dependsOn: [] },
      { id: "q1", agent: "MANAGER", status: "SUCCEEDED", dependsOn: ["w1"] },
      { id: "w2", agent: "COPYWRITER", status: "ESCALATED", dependsOn: [] },
      { id: "q2", agent: "MANAGER", status: "PENDING", dependsOn: ["w2"] },
      { id: "w3", agent: "COPYWRITER", status: "RUNNING", dependsOn: [] },
      { id: "q3", agent: "MANAGER", status: "PENDING", dependsOn: ["w3"] },
    ]);
    expect(aggregate).toEqual([
      { agent: "COPYWRITER", done: 1, total: 3, running: 1, waiting: 0, escalated: 1, blocked: 0 },
      { agent: "MANAGER", done: 1, total: 3, running: 0, waiting: 0, escalated: 0, blocked: 1 },
    ]);
  });

  it("feeds formatProgress", () => {
    const tasks = Array.from({ length: 12 }, () => task("COPYWRITER", "SUCCEEDED"));
    expect(formatProgress(aggregateProgress(tasks))).toBe("Copywriter ✓ 12/12");
  });

  it("reads progress payloads stored before blocked tasks were counted", () => {
    const stored = { agent: "MANAGER", done: 1, total: 2, running: 0, waiting: 0, escalated: 0 };
    expect(ProgressEntry.parse(stored)).toEqual({ ...stored, blocked: 0 });
  });
});

describe("blockedTaskIds", () => {
  it("follows a stopped task down the whole chain, in any row order", () => {
    const blocked = blockedTaskIds([
      { id: "qa", agent: "MANAGER", status: "PENDING", dependsOn: ["adapt"] },
      { id: "adapt", agent: "ADAPTER", status: "PENDING", dependsOn: ["direct"] },
      { id: "direct", agent: "VISUAL_DIRECTOR", status: "PENDING", dependsOn: ["write"] },
      { id: "write", agent: "COPYWRITER", status: "FAILED", dependsOn: [] },
    ]);
    expect([...blocked].sort()).toEqual(["adapt", "direct", "qa"]);
  });

  it("treats cancelled upstream work as stopped, and live or budget-blocked work as not", () => {
    const blocked = blockedTaskIds([
      { id: "a", agent: "COPYWRITER", status: "CANCELLED", dependsOn: [] },
      { id: "a2", agent: "MANAGER", status: "PENDING", dependsOn: ["a"] },
      { id: "b", agent: "COPYWRITER", status: "BLOCKED_BUDGET", dependsOn: [] },
      { id: "b2", agent: "MANAGER", status: "PENDING", dependsOn: ["b"] },
      { id: "c", agent: "COPYWRITER", status: "WAITING", dependsOn: [] },
      { id: "c2", agent: "MANAGER", status: "PENDING", dependsOn: ["c"] },
      // A revision's first task depends on nothing: never blocked.
      { id: "r1", agent: "COPYWRITER", status: "PENDING", dependsOn: [] },
    ]);
    expect([...blocked]).toEqual(["a2"]);
  });

  it("ignores tasks without ids", () => {
    expect(blockedTaskIds([{ agent: "MANAGER", status: "PENDING" }]).size).toBe(0);
  });
});
