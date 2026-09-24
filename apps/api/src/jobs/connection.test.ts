import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { connectionOptions } from "./connection";

/** Builds a client that never connects, to read back the options ioredis resolved. */
function resolvedOptions(url: string, role: Parameters<typeof connectionOptions>[0]) {
  const redis = new Redis(url, { ...connectionOptions(role), lazyConnect: true });
  const { options } = redis;
  redis.disconnect();
  return options;
}

describe("connectionOptions", () => {
  it("lets BullMQ block on worker and subscriber connections", () => {
    expect(connectionOptions("worker")).toMatchObject({ maxRetriesPerRequest: null });
    expect(connectionOptions("subscriber")).toMatchObject({ maxRetriesPerRequest: null });
  });

  it("makes producers fail fast instead of queueing commands during an outage", () => {
    expect(connectionOptions("producer")).toMatchObject({ enableOfflineQueue: false });
    expect(connectionOptions("producer").maxRetriesPerRequest).not.toBeNull();
  });

  it("connects lazily only for the general-purpose client", () => {
    expect(connectionOptions("general").lazyConnect).toBe(true);
    for (const role of ["worker", "producer", "subscriber"] as const) {
      expect(connectionOptions(role).lazyConnect, role).toBeUndefined();
    }
  });

  it.each(["general", "worker", "producer", "subscriber"] as const)(
    "keeps TLS, host and credentials from a rediss:// URL (%s)",
    (role) => {
      const options = resolvedOptions("rediss://default:secret@eu1.upstash.io:6380", role);
      expect(options.tls).toBeTruthy();
      expect(options).toMatchObject({ host: "eu1.upstash.io", port: 6380, password: "secret" });
    },
  );

  it("uses plain TCP for redis:// URLs", () => {
    expect(resolvedOptions("redis://127.0.0.1:63799", "worker").tls).toBeUndefined();
  });
});
