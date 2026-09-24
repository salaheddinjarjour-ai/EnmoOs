import { describe, expect, it } from "vitest";
import { activeQueues, processors, type ProcessorRegistry } from "./registry";

describe("activeQueues", () => {
  it("is empty in Phase 1, so the worker idles", () => {
    expect(activeQueues(processors)).toEqual([]);
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
