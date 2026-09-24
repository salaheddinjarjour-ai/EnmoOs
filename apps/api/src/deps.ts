import { createPrisma, type DbClient } from "@enmo/db";
import { Redis } from "ioredis";
import type { Config } from "./config";
import { systemClock, type Clock } from "./lib/clock";
import { createTokenCipher, type TokenCipher } from "./lib/crypto";
import { createLogger, type Logger } from "./lib/logger";

/*
 * The process-wide dependency container. Routes read it as `app.deps` (or `request.server.deps`),
 * services take the pieces they need as arguments. Later phases add llm, queues, visual, storage
 * and publishers here.
 */
export interface Deps {
  readonly config: Config;
  readonly prisma: DbClient;
  /** General-purpose client (OAuth state, readiness). BullMQ gets its own connections in Phase 2. */
  readonly redis: Redis;
  readonly clock: Clock;
  readonly logger: Logger;
  /** AES-256-GCM for SocialAccount tokens (TOKEN_ENC_KEY): routes, OAuth and publishers share it. */
  readonly tokenCipher: TokenCipher;
  /** Releases what createDeps opened; injected overrides are left to their owner. */
  close(): Promise<void>;
}

export type DepsOverrides = Partial<Pick<Deps, "prisma" | "redis" | "clock" | "logger">>;

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    // Required by BullMQ; also keeps commands queued across short reconnects.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Connect on first command so processes that never touch Redis don't need it running.
    lazyConnect: true,
  });
  redis.on("error", (error: Error) => logger.warn({ err: error }, "redis connection error"));
  return redis;
}

export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === "wait" || redis.status === "end") {
    redis.disconnect();
    return;
  }
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

export function createDeps(config: Config, overrides: DepsOverrides = {}): Deps {
  const logger = overrides.logger ?? createLogger({ level: config.LOG_LEVEL, name: "enmo-api" });
  const prisma = overrides.prisma ?? createPrisma(config.DATABASE_URL);
  const redis = overrides.redis ?? createRedis(config.REDIS_URL, logger);
  const clock = overrides.clock ?? systemClock;
  const tokenCipher = createTokenCipher(config.TOKEN_ENC_KEY);

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      const tasks: Promise<unknown>[] = [];
      if (!overrides.redis) tasks.push(closeRedis(redis));
      if (!overrides.prisma) tasks.push(prisma.$disconnect());
      const results = await Promise.allSettled(tasks);
      for (const result of results) {
        if (result.status === "rejected")
          logger.warn({ err: result.reason }, "error while closing deps");
      }
    })());

  return { config, prisma, redis, clock, logger, tokenCipher, close };
}
