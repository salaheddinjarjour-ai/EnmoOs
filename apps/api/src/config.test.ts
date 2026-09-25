import { describe, expect, it } from "vitest";
import {
  ConfigError,
  REQUIRED_PIPELINE_ACTIONS,
  TEST_TOKEN_ENC_KEY,
  configuredIntegrations,
  loadConfig,
} from "./config";

const KEY_HEX = "ab".repeat(32);

/** Production with the key it requires and the local disk explicitly allowed. */
const PRODUCTION = {
  NODE_ENV: "production",
  TOKEN_ENC_KEY: KEY_HEX,
  ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true",
} as const;

const R2_CREDENTIALS = {
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "enmo-assets",
} as const;

describe("loadConfig", () => {
  it("has working dev defaults once TOKEN_ENC_KEY is provided", () => {
    const config = loadConfig({ TOKEN_ENC_KEY: KEY_HEX });
    expect(config).toMatchObject({
      NODE_ENV: "development",
      PORT: 4000,
      LOG_LEVEL: "info",
      APP_ORIGINS: ["http://localhost:3000"],
      COOKIE_SECURE: false,
      SESSION_TTL_DAYS: 30,
      EMBEDDED_WORKER: false,
      SCHEDULERS_ENABLED: true,
      LLM_PROVIDER: "mock",
      VISUAL_PROVIDER: "mock",
      PUBLISH_MODE: "dry-run",
      STORAGE_DRIVER: "local",
      PIPELINE_ACTIONS: ["write", "direct", "qa"],
      META_GRAPH_VERSION: "v26.0",
      API_PUBLIC_URL: "http://localhost:4000",
      STORAGE_LOCAL_DIR: ".data/assets",
      PUBLIC_ASSET_BASE_URL: "http://localhost:4000/files",
      R2_PUBLIC_BASE_URL: "https://assets.enmo.marketing",
      MAX_VISUAL_REGENERATIONS: 2,
      RENDER_POLL_DELAY_MS: 3_000,
    });
    expect(config.TOKEN_ENC_KEY).toEqual(Buffer.from(KEY_HEX, "hex"));
  });

  it("requires TOKEN_ENC_KEY outside tests, and falls back to a fixed key under test", () => {
    expect(() => loadConfig({})).toThrow(/TOKEN_ENC_KEY is required/);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);

    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.TOKEN_ENC_KEY).toEqual(Buffer.from(TEST_TOKEN_ENC_KEY, "base64"));
    expect(config.LOG_LEVEL).toBe("silent");
  });

  it("accepts a base64 key and rejects keys that are not 32 bytes", () => {
    const base64 = Buffer.alloc(32, 1).toString("base64");
    expect(loadConfig({ TOKEN_ENC_KEY: base64 }).TOKEN_ENC_KEY).toHaveLength(32);
    expect(() => loadConfig({ TOKEN_ENC_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /must be 32 bytes/,
    );
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "",
      COOKIE_DOMAIN: "  ",
      LLM_PROVIDER: "",
    });
    expect(config.PORT).toBe(4000);
    expect(config.COOKIE_DOMAIN).toBeUndefined();
    expect(config.LLM_PROVIDER).toBe("mock");
  });

  it("parses origin lists, booleans and numbers", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_ORIGINS: "https://app.enmo.marketing, http://localhost:3000",
      EMBEDDED_WORKER: "true",
      COOKIE_SECURE: "1",
      SESSION_TTL_DAYS: "7",
    });
    expect(config.APP_ORIGINS).toEqual(["https://app.enmo.marketing", "http://localhost:3000"]);
    expect(config.EMBEDDED_WORKER).toBe(true);
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.SESSION_TTL_DAYS).toBe(7);
  });

  it("orders and de-duplicates PIPELINE_ACTIONS", () => {
    const config = loadConfig({ NODE_ENV: "test", PIPELINE_ACTIONS: "qa, write,qa" });
    expect(config.PIPELINE_ACTIONS).toEqual(["write", "qa"]);
  });

  it("requires write and qa in every pipeline, and direct wherever adapt runs", () => {
    expect(REQUIRED_PIPELINE_ACTIONS).toEqual(["write", "qa"]);
    expect(
      loadConfig({ NODE_ENV: "test", PIPELINE_ACTIONS: "qa,adapt,direct,write,strategy" })
        .PIPELINE_ACTIONS,
    ).toEqual(["strategy", "write", "direct", "adapt", "qa"]);
    expect(() => loadConfig({ NODE_ENV: "test", PIPELINE_ACTIONS: "write" })).toThrow(
      /PIPELINE_ACTIONS must include qa/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", PIPELINE_ACTIONS: "direct,qa" })).toThrow(
      /PIPELINE_ACTIONS must include write/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", PIPELINE_ACTIONS: "write,adapt,qa" })).toThrow(
      /adapt .* needs direct/,
    );
  });

  it("parses the LLM pipeline knobs", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults).toMatchObject({
      ANTHROPIC_MODEL: "claude-sonnet-5",
      ENMO_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      DAILY_TOKEN_CAP: 2_000_000,
      AGENT_CONCURRENCY: 4,
      MEDIA_CONCURRENCY: 4,
      MAX_QA_REVISIONS: 1,
      MOCK_LLM_DELAY_MS: 0,
      AGENT_EFFORT: {},
    });
    expect(defaults.MOCK_LLM_FAULTS).toBeUndefined();

    const config = loadConfig({
      NODE_ENV: "test",
      DAILY_TOKEN_CAP: "1",
      MAX_QA_REVISIONS: "0",
      MOCK_LLM_FAULTS: "COPYWRITER.write:invalid*2",
      MOCK_LLM_DELAY_MS: "250",
      AGENT_EFFORT_COPYWRITER: "high",
      AGENT_EFFORT_VISUAL_DIRECTOR: "low",
    });
    expect(config.DAILY_TOKEN_CAP).toBe(1);
    expect(config.MAX_QA_REVISIONS).toBe(0);
    expect(config.MOCK_LLM_FAULTS).toBe("COPYWRITER.write:invalid*2");
    expect(config.MOCK_LLM_DELAY_MS).toBe(250);
    expect(config.AGENT_EFFORT).toEqual({ COPYWRITER: "high", VISUAL_DIRECTOR: "low" });

    expect(() => loadConfig({ NODE_ENV: "test", AGENT_EFFORT_MANAGER: "extreme" })).toThrow(
      /AGENT_EFFORT_MANAGER/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", MAX_QA_REVISIONS: "9" })).toThrow(
      /MAX_QA_REVISIONS/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", MOCK_LLM_DELAY_MS: "-1" })).toThrow(
      /MOCK_LLM_DELAY_MS/,
    );
  });

  it("checks MOCK_LLM_FAULTS at boot instead of on the first mock call", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MOCK_LLM_FAULTS: "COPYWRITER.write:invalid*2,MANAGER.qa:oops",
      }),
    ).toThrow(/Invalid MOCK_LLM_FAULTS entry "MANAGER.qa:oops"/);
    expect(() => loadConfig({ NODE_ENV: "test", MOCK_LLM_FAULTS: "WRITER.write:invalid" })).toThrow(
      /unknown agent WRITER/,
    );
  });

  it("drains idle workers slower in production", () => {
    expect(loadConfig({ NODE_ENV: "test" }).BULLMQ_DRAIN_DELAY_SEC).toBe(5);
    expect(loadConfig(PRODUCTION).BULLMQ_DRAIN_DELAY_SEC).toBe(20);
    expect(loadConfig({ ...PRODUCTION, BULLMQ_DRAIN_DELAY_SEC: "8" }).BULLMQ_DRAIN_DELAY_SEC).toBe(
      8,
    );
  });

  it("rejects origins with paths and unknown pipeline actions", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", APP_ORIGINS: "https://app.enmo.marketing/" }),
    ).toThrow(/APP_ORIGINS/);
    expect(() => loadConfig({ NODE_ENV: "test", PIPELINE_ACTIONS: "write,publish" })).toThrow(
      /PIPELINE_ACTIONS/,
    );
  });

  it("parses TRUST_PROXY as a hop count, a boolean or a list of proxy addresses", () => {
    expect(loadConfig({ NODE_ENV: "test" }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ NODE_ENV: "test", TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ NODE_ENV: "test", TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ NODE_ENV: "test", TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(
      loadConfig({ NODE_ENV: "test", TRUST_PROXY: "10.0.0.0/8, loopback" }).TRUST_PROXY,
    ).toEqual(["10.0.0.0/8", "loopback"]);
    expect(
      loadConfig({ NODE_ENV: "test", TRUST_PROXY: "loopback,uniquelocal,cloudflare" }).TRUST_PROXY,
    ).toEqual(["loopback", "uniquelocal", "cloudflare"]);
    for (const invalid of ["yes please", "cludflare", "300.1.1.1", "10.0.0.0/33", "::1/129"]) {
      expect(() => loadConfig({ NODE_ENV: "test", TRUST_PROXY: invalid }), invalid).toThrow(
        /TRUST_PROXY/,
      );
    }
  });

  it("refuses TRUST_PROXY=true in production, where it would let clients pick their IP", () => {
    expect(() => loadConfig({ ...PRODUCTION, TRUST_PROXY: "true" })).toThrow(/TRUST_PROXY=true/);
    expect(
      loadConfig({ ...PRODUCTION, TRUST_PROXY: "loopback,uniquelocal,cloudflare" }).TRUST_PROXY,
    ).toEqual(["loopback", "uniquelocal", "cloudflare"]);
    expect(
      loadConfig({ NODE_ENV: "development", TRUST_PROXY: "true", TOKEN_ENC_KEY: KEY_HEX })
        .TRUST_PROXY,
    ).toBe(true);
  });

  it("defaults secure cookies on in production", () => {
    expect(loadConfig(PRODUCTION).COOKIE_SECURE).toBe(true);
  });

  it("picks the LLM provider from the key unless told otherwise", () => {
    expect(loadConfig({ NODE_ENV: "test", ANTHROPIC_API_KEY: "sk-test" }).LLM_PROVIDER).toBe(
      "anthropic",
    );
    expect(
      loadConfig({ NODE_ENV: "test", ANTHROPIC_API_KEY: "sk-test", LLM_PROVIDER: "mock" })
        .LLM_PROVIDER,
    ).toBe("mock");
    expect(() => loadConfig({ NODE_ENV: "test", LLM_PROVIDER: "anthropic" })).toThrow(
      /requires ANTHROPIC_API_KEY/,
    );
  });

  it("requires credentials for the providers that need them", () => {
    expect(() => loadConfig({ NODE_ENV: "test", VISUAL_PROVIDER: "higgsfield" })).toThrow(
      /HIGGSFIELD/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", STORAGE_DRIVER: "r2" })).toThrow(/R2_ACCOUNT_ID/);
  });

  it("refuses Higgsfield without an image model, which every post type needs; video is optional", () => {
    const keys = {
      NODE_ENV: "test",
      VISUAL_PROVIDER: "higgsfield",
      HIGGSFIELD_CREDENTIALS: "id:s",
    };
    expect(() => loadConfig(keys)).toThrow(/requires HIGGSFIELD_IMAGE_MODEL/);
    // A blank value in a .env file counts as unset.
    expect(() => loadConfig({ ...keys, HIGGSFIELD_IMAGE_MODEL: " " })).toThrow(
      /HIGGSFIELD_IMAGE_MODEL/,
    );
    expect(() => loadConfig({ ...keys, HIGGSFIELD_VIDEO_MODEL: "kling" })).toThrow(
      /HIGGSFIELD_IMAGE_MODEL/,
    );
    const stills = loadConfig({ ...keys, HIGGSFIELD_IMAGE_MODEL: "soul" });
    expect(stills).toMatchObject({ HIGGSFIELD_IMAGE_MODEL: "soul" });
    expect(stills.HIGGSFIELD_VIDEO_MODEL).toBeUndefined();
    // The mock provider needs neither.
    expect(loadConfig({ NODE_ENV: "test", VISUAL_PROVIDER: "mock" }).VISUAL_PROVIDER).toBe("mock");
  });

  it("takes the Higgsfield key as one credentials value or as an id/secret pair", () => {
    const combined = loadConfig({
      NODE_ENV: "test",
      VISUAL_PROVIDER: "higgsfield",
      HIGGSFIELD_CREDENTIALS: "key-id:key-secret",
      HIGGSFIELD_IMAGE_MODEL: "soul",
    });
    expect(combined).toMatchObject({
      HIGGSFIELD_KEY_ID: "key-id",
      HIGGSFIELD_KEY_SECRET: "key-secret",
      HIGGSFIELD_BASE_URL: "https://api.higgsfield.ai",
    });
    const pair = loadConfig({
      NODE_ENV: "test",
      VISUAL_PROVIDER: "higgsfield",
      HIGGSFIELD_KEY_ID: "id",
      HIGGSFIELD_KEY_SECRET: "secret",
      HIGGSFIELD_IMAGE_MODEL: "soul",
    });
    expect(pair).toMatchObject({ HIGGSFIELD_KEY_ID: "id", HIGGSFIELD_KEY_SECRET: "secret" });
    expect(configuredIntegrations(pair).higgsfield).toBe(true);

    expect(() => loadConfig({ NODE_ENV: "test", HIGGSFIELD_CREDENTIALS: "no-secret" })).toThrow(
      /HIGGSFIELD_CREDENTIALS/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        HIGGSFIELD_CREDENTIALS: "key-id:key-secret",
        HIGGSFIELD_KEY_ID: "id",
      }),
    ).toThrow(/not both/);
  });

  it("parses the visual loop knobs", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      MAX_VISUAL_REGENERATIONS: "0",
      RENDER_POLL_DELAY_MS: "50",
    });
    expect(config.MAX_VISUAL_REGENERATIONS).toBe(0);
    expect(config.RENDER_POLL_DELAY_MS).toBe(50);
    // The spec caps regenerations at 2: the env may lower that cost guard, never raise it.
    expect(loadConfig({ NODE_ENV: "test" }).MAX_VISUAL_REGENERATIONS).toBe(2);
    expect(() => loadConfig({ NODE_ENV: "test", MAX_VISUAL_REGENERATIONS: "3" })).toThrow(
      /MAX_VISUAL_REGENERATIONS/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", RENDER_POLL_DELAY_MS: "60000" })).toThrow(
      /RENDER_POLL_DELAY_MS/,
    );
  });

  it("serves local files from this API and R2 files from the bucket's domain", () => {
    expect(
      loadConfig({ NODE_ENV: "test", API_PUBLIC_URL: "https://api.enmo.test/" })
        .PUBLIC_ASSET_BASE_URL,
    ).toBe("https://api.enmo.test/files");
    expect(
      loadConfig({ NODE_ENV: "test", PUBLIC_ASSET_BASE_URL: "https://cdn.enmo.test/files/" })
        .PUBLIC_ASSET_BASE_URL,
    ).toBe("https://cdn.enmo.test/files");
    const r2 = loadConfig({
      NODE_ENV: "test",
      STORAGE_DRIVER: "r2",
      ...R2_CREDENTIALS,
      R2_PUBLIC_BASE_URL: "https://media.enmo.test",
    });
    expect(r2.R2_PUBLIC_BASE_URL).toBe("https://media.enmo.test");
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        STORAGE_DRIVER: "r2",
        ...R2_CREDENTIALS,
        PUBLIC_ASSET_BASE_URL: "https://assets.enmo.marketing",
      }),
    ).toThrow(/R2_PUBLIC_BASE_URL/);
  });

  it("behind the web Worker's proxy, serves the API, files and OAuth from the web app's address", () => {
    const secret = "p".repeat(40);
    const proxied = loadConfig({
      ...PRODUCTION,
      APP_ORIGINS: "https://enmoos.example.workers.dev",
      EDGE_PROXY_SECRET: secret,
    });
    expect(proxied.EDGE_PROXY_SECRET).toBe(secret);
    expect(proxied.API_PUBLIC_URL).toBe("https://enmoos.example.workers.dev");
    expect(proxied.PUBLIC_ASSET_BASE_URL).toBe("https://enmoos.example.workers.dev/files");
    expect(proxied.META_REDIRECT_URI).toMatch(/^https:\/\/enmoos\.example\.workers\.dev\/v1\//);
    // An explicit API_PUBLIC_URL still wins, and a short secret is refused.
    expect(
      loadConfig({
        ...PRODUCTION,
        EDGE_PROXY_SECRET: secret,
        API_PUBLIC_URL: "https://api.enmo.marketing",
      }).API_PUBLIC_URL,
    ).toBe("https://api.enmo.marketing");
    expect(() => loadConfig({ ...PRODUCTION, EDGE_PROXY_SECRET: "short" })).toThrow(ConfigError);
  });

  it("defaults publishing to dry-run with Meta's real hosts and a callback on this API", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      API_PUBLIC_URL: "https://api.enmo.test/",
      APP_ORIGINS: "https://app.enmo.test,http://localhost:3000",
    });
    expect(config).toMatchObject({
      PUBLISH_MODE: "dry-run",
      APP_PUBLIC_URL: "https://app.enmo.test",
      META_GRAPH_VERSION: "v26.0",
      META_GRAPH_BASE_URL: "https://graph.facebook.com",
      META_RUPLOAD_BASE_URL: "https://rupload.facebook.com",
      META_OAUTH_DIALOG_URL: "https://www.facebook.com",
      META_REDIRECT_URI: "https://api.enmo.test/v1/oauth/meta/callback",
      PUBLISH_POLL_INTERVAL_SEC: 10,
      PUBLISH_POLL_MAX_MIN: 10,
      PUBLISH_MAX_ATTEMPTS: 3,
    });
  });

  it("takes the publishing overrides, keeping the redirect URI exactly as registered", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "https://studio.enmo.test/",
      META_GRAPH_BASE_URL: "http://127.0.0.1:9999/",
      META_RUPLOAD_BASE_URL: "http://127.0.0.1:9999",
      META_OAUTH_DIALOG_URL: "http://127.0.0.1:9999",
      META_REDIRECT_URI: "https://api.enmo.test/v1/oauth/meta/callback/",
      PUBLISH_POLL_INTERVAL_SEC: "1",
      PUBLISH_POLL_MAX_MIN: "2",
      PUBLISH_MAX_ATTEMPTS: "5",
    });
    expect(config).toMatchObject({
      APP_PUBLIC_URL: "https://studio.enmo.test",
      META_GRAPH_BASE_URL: "http://127.0.0.1:9999",
      META_RUPLOAD_BASE_URL: "http://127.0.0.1:9999",
      META_OAUTH_DIALOG_URL: "http://127.0.0.1:9999",
      META_REDIRECT_URI: "https://api.enmo.test/v1/oauth/meta/callback/",
      PUBLISH_POLL_INTERVAL_SEC: 1,
      PUBLISH_POLL_MAX_MIN: 2,
      PUBLISH_MAX_ATTEMPTS: 5,
    });
    expect(() => loadConfig({ NODE_ENV: "test", PUBLISH_MAX_ATTEMPTS: "0" })).toThrow(
      /PUBLISH_MAX_ATTEMPTS/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", PUBLISH_POLL_INTERVAL_SEC: "0" })).toThrow(
      /PUBLISH_POLL_INTERVAL_SEC/,
    );
  });

  it("goes live only with a platform's app credentials, and never with half a Meta app", () => {
    expect(() => loadConfig({ NODE_ENV: "test", PUBLISH_MODE: "live" })).toThrow(
      /PUBLISH_MODE=live needs a platform's app credentials/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", META_APP_ID: "id" })).toThrow(
      /META_APP_ID and META_APP_SECRET/,
    );
    const live = loadConfig({
      NODE_ENV: "test",
      PUBLISH_MODE: "live",
      META_APP_ID: "id",
      META_APP_SECRET: "secret",
    });
    expect(live.PUBLISH_MODE).toBe("live");
    expect(configuredIntegrations(live).meta).toBe(true);
    expect(
      loadConfig({
        NODE_ENV: "test",
        PUBLISH_MODE: "live",
        TIKTOK_CLIENT_KEY: "key",
        TIKTOK_CLIENT_SECRET: "secret",
      }).PUBLISH_MODE,
    ).toBe("live");
  });

  it("refuses local storage in production unless the disk is declared durable", () => {
    const production = { NODE_ENV: "production", TOKEN_ENC_KEY: KEY_HEX } as const;
    expect(() => loadConfig(production)).toThrow(/STORAGE_DRIVER=local in production/);
    expect(loadConfig({ ...production, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true" })).toMatchObject({
      STORAGE_DRIVER: "local",
    });
    expect(
      loadConfig({ ...production, STORAGE_DRIVER: "r2", ...R2_CREDENTIALS }).STORAGE_DRIVER,
    ).toBe("r2");
    expect(loadConfig({ NODE_ENV: "development", TOKEN_ENC_KEY: KEY_HEX }).STORAGE_DRIVER).toBe(
      "local",
    );
  });

  it("validates the seed admin pair", () => {
    expect(() => loadConfig({ NODE_ENV: "test", SEED_ADMIN_EMAIL: "admin@enmo.test" })).toThrow(
      /SEED_ADMIN_PASSWORD/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        SEED_ADMIN_EMAIL: "admin@enmo.test",
        SEED_ADMIN_PASSWORD: "short",
      }),
    ).toThrow(ConfigError);
    const config = loadConfig({
      NODE_ENV: "test",
      SEED_ADMIN_EMAIL: " Admin@Enmo.Test ",
      SEED_ADMIN_PASSWORD: "enmo-admin-pass-123",
    });
    expect(config.SEED_ADMIN_EMAIL).toBe("admin@enmo.test");
  });
});

describe("configuredIntegrations", () => {
  it("reports which integrations have credentials", () => {
    expect(configuredIntegrations(loadConfig({ NODE_ENV: "test" }))).toEqual({
      anthropic: false,
      meta: false,
      tiktok: false,
      higgsfield: false,
      r2: false,
    });
    const config = loadConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
      ANTHROPIC_API_KEY: "sk-test",
      META_APP_ID: "id",
      META_APP_SECRET: "secret",
      TIKTOK_CLIENT_KEY: "key",
    });
    expect(configuredIntegrations(config)).toMatchObject({
      anthropic: true,
      meta: true,
      tiktok: false,
    });
  });
});
