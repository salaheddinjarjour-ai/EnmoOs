import type { DbClient } from "@enmo/db";
import {
  REALTIME_PAYLOADS,
  type RealtimeChannel,
  type RealtimeEnvelope,
  type RealtimeEventType,
  type RealtimePayload,
} from "@enmo/shared";
import type { Redis } from "ioredis";
import type { Logger } from "../lib/logger";

/**
 * Emits realtime events from the worker and the API alike (deps.realtime). The contract (DESIGN §D
 * "Realtime"): insert a RealtimeEvent row {channel, type, payload}, then PUBLISH
 * {id, channel, type, payload} (RealtimeEnvelope, id = row id as a string) on the deployment's
 * Redis channel, so the API hub fans it out and `Last-Event-ID` can replay it. The channel
 * follows REALTIME_EVENT_SCOPE: `threadChannel(threadId)` for thread-scoped types, GLOBAL_CHANNEL
 * for the rest. Payloads are validated with REALTIME_PAYLOADS[type] before they are stored.
 */
export interface RealtimePublisher {
  publish<T extends RealtimeEventType>(
    channel: RealtimeChannel,
    type: T,
    payload: RealtimePayload<T>,
  ): Promise<void>;
}

export interface RealtimePublisherDeps {
  prisma: DbClient;
  /** The general-purpose client (deps.redis); PUBLISH needs no dedicated connection. */
  redis: Redis;
  logger: Logger;
  /** realtimeRedisChannel(BULLMQ_PREFIX): the channel the API hubs of this deployment subscribe to. */
  redisChannel: string;
}

/*
 * Events describe state that is already committed, so publishing never fails the caller: a job or
 * request that threw here would be retried and redo work that succeeded. A payload that doesn't
 * match its schema is a bug and does throw. When the row insert fails the event is lost (logged);
 * when only the PUBLISH fails, connected clients miss it live but replay it after a reconnect.
 */
export function createRealtimePublisher({
  prisma,
  redis,
  logger,
  redisChannel,
}: RealtimePublisherDeps): RealtimePublisher {
  return {
    async publish(channel, type, payload) {
      const parsed = REALTIME_PAYLOADS[type].parse(payload) as RealtimePayload<typeof type>;

      let id: bigint;
      try {
        const row = await prisma.realtimeEvent.create({
          data: { channel, type, payload: parsed },
          select: { id: true },
        });
        id = row.id;
      } catch (error) {
        logger.error({ err: error, channel, type }, "could not store a realtime event");
        return;
      }

      const envelope = { id: id.toString(), channel, type, payload: parsed } as RealtimeEnvelope;
      try {
        // The general client queues commands through an outage; don't hold the caller that long.
        await withTimeout(
          redis.publish(redisChannel, JSON.stringify(envelope)),
          PUBLISH_TIMEOUT_MS,
        );
      } catch (error) {
        logger.warn({ err: error, channel, type, id: envelope.id }, "realtime PUBLISH failed");
      }
    },
  };
}

export const PUBLISH_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  // The PUBLISH may still settle later; nothing is waiting for it by then.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
