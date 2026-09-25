import type { DbClient } from "@enmo/db";
import {
  DryRunPublisher,
  META_DIALOG_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_VERSION,
  META_RUPLOAD_DEFAULT_BASE_URL,
  MetaOAuthProvider,
  MetaPublisher,
  type OAuthProvider,
  type Publisher,
  type Storage,
} from "@enmo/providers";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type EnvSource } from "./config";
import {
  createDeps,
  metaConfigFrom,
  metaOAuthConfigFrom,
  publisherConfigFrom,
  type Deps,
} from "./deps";

/** A container that never connects anywhere: the database, Redis and storage are stand-ins. */
function depsFor(env: EnvSource, overrides: Parameters<typeof createDeps>[1] = {}): Deps {
  return createDeps(loadConfig({ NODE_ENV: "test", ...env }), {
    prisma: {} as DbClient,
    redis: {} as Redis,
    storage: {} as Storage,
    ...overrides,
  });
}

const META_APP = { META_APP_ID: "app-id", META_APP_SECRET: "app-secret" } as const;

let opened: Deps[] = [];
const track = (deps: Deps) => {
  opened.push(deps);
  return deps;
};

afterEach(async () => {
  await Promise.all(opened.map((deps) => deps.close()));
  opened = [];
});

describe("the Meta configuration", () => {
  it("defaults to the hosts and version the providers default to", () => {
    const config = loadConfig({ NODE_ENV: "test", API_PUBLIC_URL: "https://api.enmo.test" });
    expect(metaConfigFrom(config)).toEqual({
      appId: null,
      appSecret: null,
      graphVersion: META_GRAPH_DEFAULT_VERSION,
      graphBaseUrl: META_GRAPH_DEFAULT_BASE_URL,
      ruploadBaseUrl: META_RUPLOAD_DEFAULT_BASE_URL,
      dialogBaseUrl: META_DIALOG_DEFAULT_BASE_URL,
    });
    expect(metaOAuthConfigFrom(config).redirectUri).toBe(
      "https://api.enmo.test/v1/oauth/meta/callback",
    );
    expect(publisherConfigFrom(config).mode).toBe("dry-run");
  });

  it("aims every Meta host at the configured base URLs", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ...META_APP,
      META_GRAPH_BASE_URL: "http://127.0.0.1:7001",
      META_RUPLOAD_BASE_URL: "http://127.0.0.1:7002",
      META_OAUTH_DIALOG_URL: "http://127.0.0.1:7003",
      META_GRAPH_VERSION: "v27.0",
    });
    expect(metaConfigFrom(config)).toEqual({
      appId: "app-id",
      appSecret: "app-secret",
      graphVersion: "v27.0",
      graphBaseUrl: "http://127.0.0.1:7001",
      ruploadBaseUrl: "http://127.0.0.1:7002",
      dialogBaseUrl: "http://127.0.0.1:7003",
    });
  });
});

describe("createDeps publishers and OAuth", () => {
  it("simulates every platform in dry-run", () => {
    const deps = track(depsFor({ ...META_APP }));
    for (const publisher of Object.values(deps.publishers)) {
      expect(publisher).toBeInstanceOf(DryRunPublisher);
      expect(publisher.mode).toBe("dry-run");
    }
    expect(deps.oauth.meta).toBeInstanceOf(MetaOAuthProvider);
  });

  it("publishes live on Meta once PUBLISH_MODE=live has the app credentials", () => {
    const deps = track(depsFor({ PUBLISH_MODE: "live", ...META_APP }));
    expect(deps.publishers.INSTAGRAM).toBeInstanceOf(MetaPublisher);
    expect(deps.publishers.FACEBOOK).toBeInstanceOf(MetaPublisher);
    expect(deps.publishers.INSTAGRAM.mode).toBe("live");
    // TikTok's publisher arrives in Phase 5.
    expect(deps.publishers.TIKTOK).toBeInstanceOf(DryRunPublisher);
  });

  it("takes publisher and OAuth overrides for tests", () => {
    const spy: Publisher = new DryRunPublisher("FACEBOOK");
    const oauth = { name: "meta" } as OAuthProvider;
    const deps = track(depsFor({}, { publishers: { FACEBOOK: spy }, oauth: { meta: oauth } }));
    expect(deps.publishers.FACEBOOK).toBe(spy);
    expect(deps.publishers.INSTAGRAM).not.toBe(spy);
    expect(deps.oauth.meta).toBe(oauth);
  });
});
