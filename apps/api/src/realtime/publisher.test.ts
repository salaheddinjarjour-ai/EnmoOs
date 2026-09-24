import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../lib/logger";
import { createRealtimePublisher, type RealtimePublisherDeps } from "./publisher";

const logger = createLogger({ level: "silent", name: "publisher-test" });
const REDIS_CHANNEL = "test-prefix:rt";

function fakes(options: { insertFails?: boolean; publishFails?: boolean } = {}) {
  const calls: string[] = [];
  const create = vi.fn((args: { data: { channel: string; type: string; payload: unknown } }) => {
    calls.push(`insert ${args.data.type}`);
    return options.insertFails
      ? Promise.reject(new Error("db down"))
      : Promise.resolve({ id: 42n });
  });
  const publish = vi.fn((_channel: string, _message: string) => {
    calls.push("publish");
    return options.publishFails ? Promise.reject(new Error("redis down")) : Promise.resolve(1);
  });
  const deps = {
    prisma: { realtimeEvent: { create } },
    redis: { publish },
    logger,
    redisChannel: REDIS_CHANNEL,
  } as unknown as RealtimePublisherDeps;
  return { deps, create, publish, calls };
}

const alert = {
  kind: "budget" as const,
  entityType: "AgentTask",
  entityId: "task_1",
  message: "Daily token budget reached",
  clientId: null,
  campaignId: null,
};

describe("createRealtimePublisher", () => {
  it("stores the event, then publishes the envelope with the row id", async () => {
    const { deps, create, publish, calls } = fakes();
    await createRealtimePublisher(deps).publish("global", "alert", alert);

    expect(calls).toEqual(["insert alert", "publish"]);
    expect(create.mock.calls[0]?.[0].data).toEqual({
      channel: "global",
      type: "alert",
      payload: alert,
    });
    expect(publish.mock.calls[0]?.[0]).toBe(REDIS_CHANNEL);
    expect(JSON.parse(publish.mock.calls[0]?.[1] ?? "")).toEqual({
      id: "42",
      channel: "global",
      type: "alert",
      payload: alert,
    });
  });

  it("refuses a payload that doesn't match its event type", async () => {
    const { deps, create } = fakes();
    await expect(
      createRealtimePublisher(deps).publish("global", "alert", { ...alert, kind: "nope" } as never),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("never fails the caller over infrastructure errors", async () => {
    const insertFails = fakes({ insertFails: true });
    await createRealtimePublisher(insertFails.deps).publish("global", "alert", alert);
    expect(insertFails.publish).not.toHaveBeenCalled();

    const publishFails = fakes({ publishFails: true });
    await expect(
      createRealtimePublisher(publishFails.deps).publish("global", "alert", alert),
    ).resolves.toBeUndefined();
  });
});
