import { describe, expect, it } from "vitest";
import { JOB, JOB_PAYLOADS, JOB_QUEUE, QUEUE_NAMES, type JobName } from "./queues";
import { activeQueues, processorFor, processors, type ProcessorRegistry } from "./registry";

const JOB_NAMES = Object.values(JOB);

describe("processors", () => {
  it("registers every job on the queue JOB_QUEUE names for it", () => {
    for (const name of JOB_NAMES) {
      expect(processorFor(processors, JOB_QUEUE[name], name), name).toBeTypeOf("function");
    }
  });

  it("registers nothing that has no queue, payload schema or name constant", () => {
    const registered = QUEUE_NAMES.flatMap((queue) =>
      Object.keys(processors[queue]).map((name) => ({ queue, name })),
    );
    for (const { queue, name } of registered) {
      expect(JOB_NAMES, name).toContain(name);
      expect(JOB_QUEUE[name as JobName], name).toBe(queue);
      expect(JOB_PAYLOADS[name as JobName], name).toBeDefined();
    }
  });

  it("does not resolve inherited object keys as processors", () => {
    expect(processorFor(processors, "agents", "toString")).toBeUndefined();
    expect(processorFor(processors, "agents", "tick.sweeper")).toBeUndefined();
  });
});

describe("activeQueues", () => {
  it("starts consumers for every queue once Phase 3 renders on media", () => {
    expect(activeQueues(processors)).toEqual(["agents", "media", "ops"]);
  });

  it("lists the queues that have processors, in queue order", () => {
    const registry: ProcessorRegistry = {
      agents: {},
      media: { "render.poll": () => Promise.resolve() },
      ops: { "publish.run": () => Promise.resolve() },
    };
    expect(activeQueues(registry)).toEqual(["media", "ops"]);
  });
});
