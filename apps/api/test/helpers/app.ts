import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Storage, VisualProvider } from "@enmo/providers";
import type { PublishMode } from "@enmo/shared";
import { buildApp } from "../../src/app";
import { loadConfig, TEST_TOKEN_ENC_KEY, type Config, type EnvSource } from "../../src/config";
import { createDeps, type Deps, type DepsOverrides } from "../../src/deps";
import { FakeClock } from "../../src/lib/clock";
import type { Logger } from "../../src/lib/logger";
import type { ApiApp, RouteModule } from "../../src/types";
import { fakeGraphEnv } from "../fakes/meta-graph";
import { LOCAL_REDIS_URL } from "./databases";
import { integrationDatabaseUrl } from "./db";

/** The web origin test requests claim; the only entry in the test config's APP_ORIGINS. */
export const TEST_ORIGIN = "http://app.enmo.test";

/**
 * A complete, explicit environment: nothing leaks in from the developer's shell (in particular no
 * ANTHROPIC_* values), and every external integration runs in mock / dry-run mode.
 */
export function testEnv(overrides: EnvSource = {}): EnvSource {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: integrationDatabaseUrl(),
    REDIS_URL: process.env.REDIS_URL?.trim() || LOCAL_REDIS_URL,
    BULLMQ_PREFIX: `test-${randomUUID().slice(0, 8)}`,
    SCHEDULERS_ENABLED: "false",
    APP_ORIGINS: TEST_ORIGIN,
    LLM_PROVIDER: "mock",
    VISUAL_PROVIDER: "mock",
    PUBLISH_MODE: "dry-run",
    STORAGE_DRIVER: "local",
    // MockProvider settles on its second poll; at 20ms the visual loop takes milliseconds.
    RENDER_POLL_DELAY_MS: "20",
    TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
    ...overrides,
  };
}

/** A fresh directory for LocalStorage, so no test sees another's files. */
export interface TempStorageDir {
  path: string;
  remove(): Promise<void>;
}

export async function createTempStorageDir(): Promise<TempStorageDir> {
  const dir = await mkdtemp(path.join(tmpdir(), "enmo-assets-"));
  return { path: dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

export function testConfig(overrides: EnvSource = {}): Config {
  return loadConfig(testEnv(overrides));
}

/** How a test app or harness publishes (both default to dry-run with no Meta app). */
export interface PublishingOptions {
  /** PUBLISH_MODE; `env` may set it too. */
  publishMode?: PublishMode;
  /**
   * One base URL for every Meta host (Graph, rupload, the OAuth dialog), e.g. a startFakeGraph()
   * url. Also configures the fake's Meta app (fakeGraphEnv), so live Meta publishing and OAuth
   * are available.
   */
  metaBaseUrl?: string;
  /** Replaces the publishers of the platforms listed; the others follow PUBLISH_MODE. */
  publishers?: DepsOverrides["publishers"];
  /** Replaces the OAuth providers listed. */
  oauth?: DepsOverrides["oauth"];
}

/** The env PublishingOptions stand for (applied before the caller's own `env`). */
export function publishingEnv(options: PublishingOptions): EnvSource {
  return {
    ...(options.publishMode ? { PUBLISH_MODE: options.publishMode } : {}),
    ...(options.metaBaseUrl ? fakeGraphEnv(options.metaBaseUrl) : {}),
  };
}

/** The deps overrides PublishingOptions stand for. */
export function publishingOverrides(options: PublishingOptions): DepsOverrides {
  return {
    ...(options.publishers ? { publishers: options.publishers } : {}),
    ...(options.oauth ? { oauth: options.oauth } : {}),
  };
}

export interface TestApp {
  app: ApiApp;
  deps: Deps;
  clock: FakeClock;
  /** STORAGE_LOCAL_DIR: a temporary directory removed on close() (unless `env` set its own). */
  storageDir: string;
  close(): Promise<void>;
}

export interface BuildTestAppOptions extends PublishingOptions {
  /** Env overrides on top of testEnv(), e.g. { SESSION_TTL_DAYS: "1" }. */
  env?: EnvSource;
  clock?: FakeClock;
  /** Extra routes mounted under /v1 before the app is readied (for plugin tests). */
  routes?: RouteModule;
  /** Replaces the (silent) config logger, e.g. to inspect what a request writes to the logs. */
  logger?: Logger;
  /** Replaces the VisualProvider VISUAL_PROVIDER builds (MockProvider). */
  visual?: VisualProvider;
  /** Replaces the Storage STORAGE_DRIVER builds (LocalStorage in `storageDir`). */
  storage?: Storage;
  /** deps.fetch: what the providers (publishers, OAuth) call through. */
  fetch?: typeof globalThis.fetch;
}

/** A ready app wired to the test database and Redis, with a FakeClock. Call close() in afterAll. */
export async function buildTestApp(options: BuildTestAppOptions = {}): Promise<TestApp> {
  const clock = options.clock ?? new FakeClock();
  const tempDir = await createTempStorageDir();
  const config = testConfig({
    STORAGE_LOCAL_DIR: tempDir.path,
    ...publishingEnv(options),
    ...options.env,
  });
  const deps = createDeps(config, {
    clock,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.visual ? { visual: options.visual } : {}),
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...publishingOverrides(options),
  });
  try {
    const app = await buildApp(deps);
    const { routes } = options;
    if (routes) {
      await app.register(
        async (scope) => {
          await routes(scope);
        },
        { prefix: "/v1" },
      );
    }
    await app.ready();
    return {
      app,
      deps,
      clock,
      storageDir: config.STORAGE_LOCAL_DIR,
      close: async () => {
        try {
          await app.close();
          await deps.close();
        } finally {
          await tempDir.remove();
        }
      },
    };
  } catch (error) {
    await deps.close();
    await tempDir.remove();
    throw error;
  }
}

/**
 * Headers a browser on the web app would send: the allowed Origin (required on every non-GET by the
 * security plugin) plus an optional session cookie from loginAs() / sessionCookieFor().
 */
export function browserHeaders(cookie?: string): Record<string, string> {
  return cookie ? { origin: TEST_ORIGIN, cookie } : { origin: TEST_ORIGIN };
}
