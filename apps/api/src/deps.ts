import { createLlm, type LlmClient, type LlmConfig } from "@enmo/agents";
import { createPrisma, type DbClient } from "@enmo/db";
import { realtimeRedisChannel } from "@enmo/shared";
import type { Redis } from "ioredis";
import type { Config } from "./config";
import { closeRedis, createRedisConnection } from "./jobs/connection";
import { createJobQueues, type JobQueues } from "./jobs/queues";
import { systemClock, type Clock } from "./lib/clock";
import { createTokenCipher, type TokenCipher } from "./lib/crypto";
import { createLogger, type Logger } from "./lib/logger";
import { createRealtimePublisher, type RealtimePublisher } from "./realtime/publisher";

/*
 * The process-wide dependency container. Routes read it as `app.deps` (or `request.server.deps`),
 * services, orchestrator modules and job processors take it as their first argument. Later phases
 * add visual, storage and publishers here.
 */
export interface Deps {
  readonly config: Config;
  readonly prisma: DbClient;
  /** General-purpose client: OAuth state, readiness, realtime PUBLISH. BullMQ has its own. */
  readonly redis: Redis;
  readonly clock: Clock;
  readonly logger: Logger;
  /** AES-256-GCM for SocialAccount tokens (TOKEN_ENC_KEY): routes, OAuth and publishers share it. */
  readonly tokenCipher: TokenCipher;
  /** LLM_PROVIDER's client (MockLlm or Anthropic); agents run through @enmo/agents runAgent. */
  readonly llm: LlmClient;
  /** Producer side of the BullMQ queues; connects on first enqueue. */
  readonly queues: JobQueues;
  /** RealtimeEvent row + Redis PUBLISH, from the API and the worker alike. */
  readonly realtime: RealtimePublisher;
  /** Releases what createDeps opened; injected overrides are left to their owner. */
  close(): Promise<void>;
}

export interface DepsOverrides extends Partial<
  Pick<Deps, "prisma" | "redis" | "clock" | "logger" | "llm" | "realtime">
> {
  /** Replaces BULLMQ_PREFIX for this container's queues (and the workers started from it). */
  queuePrefix?: string;
}

/** The general-purpose client (lazy: nothing connects until the first command). */
export function createRedis(url: string, logger: Logger): Redis {
  return createRedisConnection(url, "general", logger);
}

/** Everything createLlm needs, taken from the config and never from process.env. */
export function llmConfigFrom(config: Config): LlmConfig {
  return {
    provider: config.LLM_PROVIDER,
    apiKey: config.ANTHROPIC_API_KEY ?? null,
    model: config.ANTHROPIC_MODEL,
    baseUrl: config.ENMO_ANTHROPIC_BASE_URL,
    faults: config.MOCK_LLM_FAULTS ?? null,
    mockDelayMs: config.MOCK_LLM_DELAY_MS,
  };
}

export function createDeps(config: Config, overrides: DepsOverrides = {}): Deps {
  const logger = overrides.logger ?? createLogger({ level: config.LOG_LEVEL, name: "enmo-api" });
  const prisma = overrides.prisma ?? createPrisma(config.DATABASE_URL);
  const redis = overrides.redis ?? createRedis(config.REDIS_URL, logger);
  const clock = overrides.clock ?? systemClock;
  const tokenCipher = createTokenCipher(config.TOKEN_ENC_KEY);
  const llm = overrides.llm ?? createLlm(llmConfigFrom(config));
  const queues = createJobQueues({
    redisUrl: config.REDIS_URL,
    prefix: overrides.queuePrefix ?? config.BULLMQ_PREFIX,
    logger,
  });
  const realtime =
    overrides.realtime ??
    createRealtimePublisher({
      prisma,
      redis,
      logger,
      redisChannel: realtimeRedisChannel(config.BULLMQ_PREFIX),
    });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      const tasks: Promise<unknown>[] = [queues.close()];
      if (!overrides.redis) tasks.push(closeRedis(redis));
      if (!overrides.prisma) tasks.push(prisma.$disconnect());
      const results = await Promise.allSettled(tasks);
      for (const result of results) {
        if (result.status === "rejected")
          logger.warn({ err: result.reason }, "error while closing deps");
      }
    })());

  return { config, prisma, redis, clock, logger, tokenCipher, llm, queues, realtime, close };
}
