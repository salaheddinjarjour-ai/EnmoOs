import { createLlm, type LlmClient, type LlmConfig } from "@enmo/agents";
import { createPrisma, type DbClient } from "@enmo/db";
import {
  createMetaOAuthProvider,
  createPublisher,
  createStorage,
  createVisualProvider,
  type MetaConfig,
  type MetaOAuthConfig,
  type OAuthProvider,
  type Publisher,
  type PublisherConfig,
  type Storage,
  type StorageConfig,
  type VisualProvider,
  type VisualProviderConfig,
} from "@enmo/providers";
import { Platform, realtimeRedisChannel } from "@enmo/shared";
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
 * services, orchestrator modules and job processors take it as their first argument.
 */

/**
 * One publisher per platform, as PUBLISH_MODE and the platform's credentials allow (DESIGN §F):
 * the live publisher (`mode: "live"`) or a DryRunPublisher. A PublishJob is a dry run unless its
 * platform's publisher is live and the client has an account there (PublishJob.dryRun, decided
 * when it is scheduled); a job stored as a dry run always runs through a DryRunPublisher.
 */
export type Publishers = Readonly<Record<Platform, Publisher>>;

/** The OAuth providers behind /v1/oauth/{provider}/*; TikTok joins in Phase 5. */
export interface OAuthProviders {
  readonly meta: OAuthProvider;
}

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
  /** VISUAL_PROVIDER's renderer (MockProvider or HiggsfieldProvider). */
  readonly visual: VisualProvider;
  /** STORAGE_DRIVER's file store (local disk served at /files/*, or R2). */
  readonly storage: Storage;
  /**
   * Outbound HTTP for providers and render downloads (DESIGN §F: all of it goes through an
   * injected fetch, so tests aim it at fakes). The global fetch unless overridden.
   */
  readonly fetch: typeof globalThis.fetch;
  /** Publishers by platform; construction does no I/O, so dry-run setups never touch a network. */
  readonly publishers: Publishers;
  /** OAuth providers by name (their HTTP goes through `fetch` against the META_* base URLs). */
  readonly oauth: OAuthProviders;
  /** Releases what createDeps opened; injected overrides are left to their owner. */
  close(): Promise<void>;
}

export interface DepsOverrides extends Partial<
  Pick<
    Deps,
    "prisma" | "redis" | "clock" | "logger" | "llm" | "realtime" | "visual" | "storage" | "fetch"
  >
> {
  /** Replaces BULLMQ_PREFIX for this container's queues (and the workers started from it). */
  queuePrefix?: string;
  /** Replaces the publisher of each platform listed (e.g. a spy); the others follow the config. */
  publishers?: Partial<Record<Platform, Publisher>>;
  /** Replaces the OAuth providers listed. */
  oauth?: Partial<OAuthProviders>;
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

/** Everything createVisualProvider needs, taken from the config. */
export function visualProviderConfigFrom(config: Config): VisualProviderConfig {
  return {
    provider: config.VISUAL_PROVIDER,
    higgsfield: {
      keyId: config.HIGGSFIELD_KEY_ID ?? null,
      keySecret: config.HIGGSFIELD_KEY_SECRET ?? null,
      baseUrl: config.HIGGSFIELD_BASE_URL,
      imageModel: config.HIGGSFIELD_IMAGE_MODEL ?? null,
      videoModel: config.HIGGSFIELD_VIDEO_MODEL ?? null,
    },
  };
}

/** Everything createStorage needs, taken from the config. */
export function storageConfigFrom(config: Config): StorageConfig {
  return {
    driver: config.STORAGE_DRIVER,
    publicBaseUrl:
      config.STORAGE_DRIVER === "r2" ? config.R2_PUBLIC_BASE_URL : config.PUBLIC_ASSET_BASE_URL,
    localDir: config.STORAGE_LOCAL_DIR,
    r2: {
      accountId: config.R2_ACCOUNT_ID ?? null,
      accessKeyId: config.R2_ACCESS_KEY_ID ?? null,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY ?? null,
      bucket: config.R2_BUCKET ?? null,
      endpoint: config.R2_ENDPOINT ?? null,
    },
  };
}

/** META_*: shared by the publisher, OAuth and (Phase 6) metrics. */
export function metaConfigFrom(config: Config): MetaConfig {
  return {
    appId: config.META_APP_ID ?? null,
    appSecret: config.META_APP_SECRET ?? null,
    graphVersion: config.META_GRAPH_VERSION,
    graphBaseUrl: config.META_GRAPH_BASE_URL,
    ruploadBaseUrl: config.META_RUPLOAD_BASE_URL,
    dialogBaseUrl: config.META_OAUTH_DIALOG_URL,
  };
}

/** Everything createPublisher needs, taken from the config. */
export function publisherConfigFrom(config: Config): PublisherConfig {
  return { mode: config.PUBLISH_MODE, meta: metaConfigFrom(config) };
}

/** Everything createMetaOAuthProvider needs, taken from the config. */
export function metaOAuthConfigFrom(config: Config): MetaOAuthConfig {
  return { ...metaConfigFrom(config), redirectUri: config.META_REDIRECT_URI };
}

function createPublishers(
  config: Config,
  fetch: typeof globalThis.fetch,
  overrides: Partial<Record<Platform, Publisher>> = {},
): Publishers {
  const publisherConfig = publisherConfigFrom(config);
  const entries = Platform.options.map(
    (platform) =>
      [
        platform,
        overrides[platform] ?? createPublisher(platform, publisherConfig, { fetch }),
      ] as const,
  );
  return Object.freeze(Object.fromEntries(entries) as Record<Platform, Publisher>);
}

export function createDeps(config: Config, overrides: DepsOverrides = {}): Deps {
  const logger = overrides.logger ?? createLogger({ level: config.LOG_LEVEL, name: "enmo-api" });
  const prisma = overrides.prisma ?? createPrisma(config.DATABASE_URL);
  const redis = overrides.redis ?? createRedis(config.REDIS_URL, logger);
  const clock = overrides.clock ?? systemClock;
  const tokenCipher = createTokenCipher(config.TOKEN_ENC_KEY);
  const llm = overrides.llm ?? createLlm(llmConfigFrom(config));
  const fetch = overrides.fetch ?? globalThis.fetch;
  // No provider does I/O at construction; a misconfigured one fails on its first call.
  const visual =
    overrides.visual ?? createVisualProvider(visualProviderConfigFrom(config), { fetch });
  const storage = overrides.storage ?? createStorage(storageConfigFrom(config));
  const publishers = createPublishers(config, fetch, overrides.publishers);
  const oauth: OAuthProviders = Object.freeze({
    meta: overrides.oauth?.meta ?? createMetaOAuthProvider(metaOAuthConfigFrom(config), { fetch }),
  });
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

  return {
    config,
    prisma,
    redis,
    clock,
    logger,
    tokenCipher,
    llm,
    queues,
    realtime,
    visual,
    storage,
    fetch,
    publishers,
    oauth,
    close,
  };
}
