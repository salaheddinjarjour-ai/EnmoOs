import { REALTIME_EVENT_SCOPE, type RealtimeEventType } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { EventBatch, THREAD_EVENT_TYPES } from "./events";

describe("EventBatch", () => {
  it("knows exactly the thread-scoped event types", () => {
    const threadTypes = (Object.keys(REALTIME_EVENT_SCOPE) as RealtimeEventType[]).filter(
      (type) => REALTIME_EVENT_SCOPE[type] === "thread",
    );
    expect([...THREAD_EVENT_TYPES].sort()).toEqual(threadTypes.sort());
  });

  it("publishes on the right channels, in order, once", async () => {
    const published: [string, string][] = [];
    const deps = {
      realtime: {
        publish: (channel: string, type: string) => {
          published.push([channel, type]);
          return Promise.resolve();
        },
      },
    };
    const batch = new EventBatch()
      .thread("thr_1", "plan.proposed", {
        campaignId: "c",
        threadId: "thr_1",
        graphId: "g",
        version: 1,
      })
      .alert({
        kind: "budget",
        entityType: "AgentTask",
        entityId: null,
        message: "m",
        clientId: null,
        campaignId: null,
      });
    expect(batch.size).toBe(2);
    await batch.publish(deps);
    await batch.publish(deps);
    expect(published).toEqual([
      ["thread:thr_1", "plan.proposed"],
      ["global", "alert"],
    ]);
  });
});
