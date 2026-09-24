import { describe, expect, it } from "vitest";
import { ConfigError, TEST_TOKEN_ENC_KEY, configuredIntegrations, loadConfig } from "./config";

const KEY_HEX = "ab".repeat(32);

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
      PIPELINE_ACTIONS: ["write", "qa"],
      META_GRAPH_VERSION: "v26.0",
      API_PUBLIC_URL: "http://localhost:4000",
      PUBLIC_ASSET_BASE_URL: "http://localhost:4000/v1/files",
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
      PIPELINE_ACTIONS: "strategy,write,direct,adapt,qa",
    });
    expect(config.APP_ORIGINS).toEqual(["https://app.enmo.marketing", "http://localhost:3000"]);
    expect(config.EMBEDDED_WORKER).toBe(true);
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.SESSION_TTL_DAYS).toBe(7);
    expect(config.PIPELINE_ACTIONS).toHaveLength(5);
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
    expect(() =>
      loadConfig({ NODE_ENV: "production", TOKEN_ENC_KEY: KEY_HEX, TRUST_PROXY: "true" }),
    ).toThrow(/TRUST_PROXY=true/);
    expect(
      loadConfig({
        NODE_ENV: "production",
        TOKEN_ENC_KEY: KEY_HEX,
        TRUST_PROXY: "loopback,uniquelocal,cloudflare",
      }).TRUST_PROXY,
    ).toEqual(["loopback", "uniquelocal", "cloudflare"]);
    expect(
      loadConfig({ NODE_ENV: "development", TRUST_PROXY: "true", TOKEN_ENC_KEY: KEY_HEX })
        .TRUST_PROXY,
    ).toBe(true);
  });

  it("defaults secure cookies on in production", () => {
    expect(loadConfig({ NODE_ENV: "production", TOKEN_ENC_KEY: KEY_HEX }).COOKIE_SECURE).toBe(true);
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
