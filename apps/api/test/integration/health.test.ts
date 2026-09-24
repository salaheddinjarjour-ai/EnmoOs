import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READY_CHECK_TIMEOUT_MS } from "../../src/routes/health";
import { browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { createUser } from "../helpers/factories";

/* System endpoints: liveness, readiness and GET /v1/capabilities. */

// Nothing listens on port 1, so connections are refused straight away.
const DEAD_DATABASE_URL = "postgresql://postgres@127.0.0.1:1/enmo_test_unreachable";
const DEAD_REDIS_URL = "redis://127.0.0.1:1";

/** An app wired exactly like production, with the named dependencies pointed at a dead port. */
function appWithBrokenDeps(broken: { database?: boolean; redis?: boolean }): Promise<TestApp> {
  return buildTestApp({
    env: {
      ...(broken.database && { DATABASE_URL: DEAD_DATABASE_URL }),
      ...(broken.redis && { REDIS_URL: DEAD_REDIS_URL }),
    },
  });
}

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("GET /healthz", () => {
  it.each(["/healthz", "/v1/healthz"])("%s answers without a session", async (url) => {
    const response = await t.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("does not depend on Postgres or Redis", async () => {
    const probe = await appWithBrokenDeps({ database: true, redis: true });
    try {
      const response = await probe.app.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await probe.close();
    }
  });
});

describe("GET /readyz", () => {
  it.each(["/readyz", "/v1/readyz"])("%s is 200 when Postgres and Redis answer", async (url) => {
    const response = await t.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: { database: true, redis: true } });
  });

  it.each([
    ["Redis", { redis: true }, { database: true, redis: false }],
    ["Postgres", { database: true }, { database: false, redis: true }],
    ["both", { database: true, redis: true }, { database: false, redis: false }],
  ])("is 503 when %s is unreachable", async (_label, broken, checks) => {
    const probe = await appWithBrokenDeps(broken);
    try {
      const response = await probe.app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "unavailable", checks });
    } finally {
      await probe.close();
    }
  });

  it("answers quickly during a Redis outage and leaves nothing queued for shutdown", async () => {
    const probe = await appWithBrokenDeps({ redis: true });
    try {
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const response = await probe.app.inject({ method: "GET", url: "/readyz" });
        expect(response.statusCode).toBe(503);
        // A probe that waited on a queued PING would last the whole per-check timeout, so each one
        // is bounded by that timeout rather than by a guess at how fast a busy CI runner is.
        expect(performance.now() - started).toBeLessThan(READY_CHECK_TIMEOUT_MS);
      }
    } finally {
      // Hangs (and fails the hook timeout) if a PING were still queued in ioredis.
      await probe.close();
    }
  });
});

describe("GET /v1/capabilities", () => {
  it("requires a session", async () => {
    const response = await t.app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(response.statusCode).toBe(401);
  });

  it("reports mock / dry-run modes and no configured integrations by default", async () => {
    const editor = await createUser({ role: "EDITOR" });
    const response = await t.app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: browserHeaders(await sessionCookieFor(editor)),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      llm: { provider: "mock", model: "mock" },
      visual: { provider: "mock" },
      publish: { mode: "dry-run" },
      storage: { driver: "local" },
      pipelineActions: ["write", "qa"],
      integrations: { anthropic: false, meta: false, tiktok: false, higgsfield: false, r2: false },
      dailyTokenCap: 2_000_000,
    });
  });

  it("flags configured integrations without exposing their secrets", async () => {
    const secrets = {
      ANTHROPIC_API_KEY: "sk-ant-secret-value",
      META_APP_ID: "meta-app-id-value",
      META_APP_SECRET: "meta-secret-value",
      TIKTOK_CLIENT_KEY: "tiktok-key-value",
    };
    const configured = await buildTestApp({
      env: {
        ...secrets,
        LLM_PROVIDER: "mock",
        DAILY_TOKEN_CAP: "50000",
        PIPELINE_ACTIONS: "write,direct,qa",
      },
    });
    try {
      const admin = await createUser({ role: "ADMIN" });
      const response = await configured.app.inject({
        method: "GET",
        url: "/v1/capabilities",
        headers: browserHeaders(await sessionCookieFor(admin)),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        llm: { provider: "mock" },
        pipelineActions: ["write", "direct", "qa"],
        // TikTok needs both the client key and the secret.
        integrations: { anthropic: true, meta: true, tiktok: false, higgsfield: false, r2: false },
        dailyTokenCap: 50_000,
      });
      for (const value of Object.values(secrets)) expect(response.body).not.toContain(value);
    } finally {
      await configured.close();
    }
  });
});
