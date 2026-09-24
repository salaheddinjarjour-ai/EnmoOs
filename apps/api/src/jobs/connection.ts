import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "../lib/logger";

/*
 * Redis connections (DESIGN §D). Every one is built from REDIS_URL, so a rediss:// URL (Upstash)
 * gets TLS from ioredis without extra options. Each role has its own client because their failure
 * modes differ:
 *
 *   general     deps.redis: OAuth state, readiness, realtime PUBLISH. Waits out short outages.
 *   worker      BullMQ consumers. BullMQ requires maxRetriesPerRequest: null for its blocking
 *               commands and duplicates this client for each worker's blocking connection.
 *   producer    Queue instances that enqueue jobs. enableOfflineQueue: false makes an add during a
 *               Redis outage fail at once instead of hanging the HTTP request that caused it.
 *   subscriber  The API's single realtime SUBSCRIBE connection (realtime/hub.ts). ioredis
 *               re-subscribes by itself after a reconnect.
 *
 * Only the general client connects lazily. BullMQ remembers a failed first connect() forever, so
 * the others connect on construction and keep retrying; create them only when they are needed.
 */

export type ConnectionRole = "general" | "worker" | "producer" | "subscriber";

const ROLE_OPTIONS: Readonly<Record<ConnectionRole, RedisOptions>> = {
  // Connect on first command so processes that never touch Redis don't need it running.
  general: { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true },
  worker: { maxRetriesPerRequest: null, enableReadyCheck: false },
  producer: { enableOfflineQueue: false, enableReadyCheck: false },
  subscriber: { maxRetriesPerRequest: null, enableReadyCheck: false },
};

/** The ioredis options for `role` (connection details and TLS come from the URL). */
export function connectionOptions(role: ConnectionRole): RedisOptions {
  return { ...ROLE_OPTIONS[role] };
}

export function createRedisConnection(url: string, role: ConnectionRole, logger: Logger): Redis {
  const redis = new Redis(url, connectionOptions(role));
  redis.on("error", (error: Error) =>
    logger.warn({ err: error, redis: role }, "redis connection error"),
  );
  return redis;
}

export const createWorkerConnection = (url: string, logger: Logger): Redis =>
  createRedisConnection(url, "worker", logger);

export const createProducerConnection = (url: string, logger: Logger): Redis =>
  createRedisConnection(url, "producer", logger);

export const createSubscriberConnection = (url: string, logger: Logger): Redis =>
  createRedisConnection(url, "subscriber", logger);

/** QUIT when connected (pending replies flush first), otherwise just drop the socket. */
export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === "wait" || redis.status === "end") {
    redis.disconnect();
    return;
  }
  if (redis.status !== "ready") {
    // Still (re)connecting: QUIT would sit in the offline queue until Redis came back.
    redis.disconnect();
    return;
  }
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
