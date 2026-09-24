import {
  isRealtimeChannel,
  RealtimeEvent,
  type RealtimeChannel,
  type RealtimeEnvelope,
} from "@enmo/shared";
import type { Redis } from "ioredis";
import { z } from "zod";
import { closeRedis, createSubscriberConnection } from "../jobs/connection";
import type { Logger } from "../lib/logger";

/*
 * The API's realtime fan-out (DESIGN §D "Hub"): one SUBSCRIBE connection per API process on the
 * deployment's Redis channel, dispatching each RealtimeEnvelope to the in-memory listeners registered
 * for its channel. The connection opens on the first start(), so only processes that actually
 * serve /v1/events subscribe.
 *
 * Whatever is published while the connection is down never reaches this process. ioredis
 * re-subscribes by itself once Redis is back; at that moment every listener is interrupted, the
 * SSE streams end, and browsers reconnect with Last-Event-ID, which replays the gap from the
 * RealtimeEvent table.
 */

export interface RealtimeListener {
  /** A live event on one of the subscribed channels. */
  onEvent(event: RealtimeEnvelope): void;
  /** Live delivery lapsed (Redis reconnected, or the hub closed): events may have been missed. */
  onInterrupt(): void;
}

export interface RealtimeHub {
  /**
   * Opens the subscription and resolves once Redis confirmed it; idempotent. Rejects when that
   * takes longer than the start timeout (the connection keeps retrying for the next call).
   */
  start(): Promise<void>;
  /** Delivers events on any of `channels` to `listener`; returns the unsubscribe function. */
  subscribe(channels: readonly RealtimeChannel[], listener: RealtimeListener): () => void;
  /** Live subscriptions, for leak checks. */
  listenerCount(): number;
  /** Interrupts every listener and closes the connection. Idempotent. */
  close(): Promise<void>;
}

export interface RealtimeHubOptions {
  redisUrl: string;
  /** realtimeRedisChannel(BULLMQ_PREFIX), the channel this deployment's publishers use. */
  redisChannel: string;
  logger: Logger;
  /** Defaults to HUB_START_TIMEOUT_MS. */
  startTimeoutMs?: number;
  /** Builds the SUBSCRIBE connection; defaults to jobs/connection.ts createSubscriberConnection. */
  connect?: (redisUrl: string, logger: Logger) => Redis;
}

export const HUB_START_TIMEOUT_MS = 5_000;

/** RealtimeEvent.id is a Postgres BIGINT; envelopes carry it as a decimal string. */
const EventIdString = z.string().regex(/^\d{1,19}$/);

const EnvelopeFrame = z.object({
  id: EventIdString,
  channel: z.string().refine(isRealtimeChannel),
  type: z.string(),
  payload: z.unknown(),
});

/** A PUBLISHed message as a typed envelope, or null when it isn't one. */
export function parseEnvelope(message: string): RealtimeEnvelope | null {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return null;
  }
  const frame = EnvelopeFrame.safeParse(json);
  if (!frame.success) return null;
  const event = RealtimeEvent.safeParse({ type: frame.data.type, payload: frame.data.payload });
  if (!event.success) return null;
  return { ...event.data, id: frame.data.id, channel: frame.data.channel };
}

class HubStartTimeout extends Error {
  override readonly name = "HubStartTimeout";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new HubStartTimeout(`realtime subscription not ready after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Subscription {
  readonly channels: readonly RealtimeChannel[];
  readonly listener: RealtimeListener;
}

export function createRealtimeHub({
  redisUrl,
  redisChannel: subscribedChannel,
  logger,
  startTimeoutMs = HUB_START_TIMEOUT_MS,
  connect = createSubscriberConnection,
}: RealtimeHubOptions): RealtimeHub {
  const subscriptions = new Set<Subscription>();
  const byChannel = new Map<string, Set<Subscription>>();
  let connection: Redis | null = null;
  let subscribed: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  // One failing listener must not starve the others.
  const call = (action: () => void) => {
    try {
      action();
    } catch (error) {
      logger.error({ err: error }, "realtime listener failed");
    }
  };

  const dispatch = (redisChannel: string, message: string) => {
    if (redisChannel !== subscribedChannel) return;
    const event = parseEnvelope(message);
    if (!event) {
      logger.warn({ bytes: message.length }, "ignoring a malformed realtime message");
      return;
    }
    const targets = byChannel.get(event.channel);
    if (!targets) return;
    for (const subscription of [...targets]) call(() => subscription.listener.onEvent(event));
  };

  const interruptAll = () => {
    for (const subscription of [...subscriptions]) call(() => subscription.listener.onInterrupt());
  };

  const open = async (): Promise<void> => {
    const redis = connect(redisUrl, logger);
    connection = redis;
    let wasReady = false;
    let lost = false;
    redis.on("message", dispatch);
    redis.on("close", () => {
      if (wasReady) lost = true;
    });
    redis.on("ready", () => {
      if (lost && !closing) {
        logger.warn("realtime subscription re-established; streams reconnect to replay the gap");
        interruptAll();
      }
      lost = false;
      wasReady = true;
    });
    try {
      await redis.subscribe(subscribedChannel);
    } catch (error) {
      connection = null;
      await closeRedis(redis);
      throw error;
    }
  };

  return {
    start() {
      if (closing) return Promise.reject(new Error("The realtime hub is closed"));
      subscribed ??= open().catch((error: unknown) => {
        subscribed = null;
        throw error;
      });
      return withTimeout(subscribed, startTimeoutMs);
    },

    subscribe(channels, listener) {
      if (closing) {
        // Nothing will ever arrive; told on the next tick, once the caller has finished wiring up.
        queueMicrotask(() => call(() => listener.onInterrupt()));
        return () => undefined;
      }
      const subscription: Subscription = { channels: [...new Set(channels)], listener };
      subscriptions.add(subscription);
      for (const channel of subscription.channels) {
        let targets = byChannel.get(channel);
        if (!targets) byChannel.set(channel, (targets = new Set()));
        targets.add(subscription);
      }
      return () => {
        if (!subscriptions.delete(subscription)) return;
        for (const channel of subscription.channels) {
          const targets = byChannel.get(channel);
          targets?.delete(subscription);
          if (targets?.size === 0) byChannel.delete(channel);
        }
      };
    },

    listenerCount: () => subscriptions.size,

    close() {
      return (closing ??= (async () => {
        const everyone = [...subscriptions];
        subscriptions.clear();
        byChannel.clear();
        for (const subscription of everyone) call(() => subscription.listener.onInterrupt());
        const redis = connection;
        connection = null;
        if (redis) await closeRedis(redis);
      })());
    },
  };
}
