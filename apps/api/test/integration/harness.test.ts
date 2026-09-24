import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../../src/app";
import { createDeps } from "../../src/deps";
import { DAY_MS } from "../../src/lib/clock";
import { authenticate, currentUser } from "../../src/plugins/auth";
import { requireCap } from "../../src/plugins/rbac";
import type { RouteModule } from "../../src/types";
import { browserHeaders, buildTestApp, testConfig, type TestApp } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";

/*
 * Checks the Step A wiring every unit relies on: test database + truncation, factories, the
 * session-cookie contract, route access declarations, the CSRF origin check and the error shape.
 */

const probeRoutes: RouteModule = (app) => {
  app.get("/_probe/me", { onRequest: authenticate }, (request) => ({
    id: currentUser(request).id,
  }));
  app.get("/_probe/users", { onRequest: requireCap("users.manage") }, () => ({ ok: true }));
  app.post(
    "/_probe/echo",
    // Fastify validates a missing body as null, hence nullish() rather than optional().
    { config: { public: true }, schema: { body: z.object({ name: z.string().min(1) }).nullish() } },
    (request) => ({ body: request.body ?? null }),
  );
  app.get("/_probe/zod", { config: { public: true } }, () =>
    z.object({ n: z.number() }).parse({ n: "x" }),
  );
};

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp({ routes: probeRoutes });
});

afterAll(async () => {
  await t.close();
});

describe("test database", () => {
  it("starts every test with empty tables (1/2)", async () => {
    await createUser({ role: "ADMIN" });
    await createClient({ name: "Qahwa Co" });
    expect(await testDb().user.count()).toBe(1);
  });

  it("starts every test with empty tables (2/2)", async () => {
    expect(await testDb().user.count()).toBe(0);
    expect(await testDb().client.count()).toBe(0);
  });

  it("creates clients with the same defaults as the API", async () => {
    const client = await createClient({ name: "Qahwa Co" });
    expect(client.slug).toMatch(/^qahwa-co-\d+$/);
    expect(client.enabledPlatforms).toEqual(["INSTAGRAM", "FACEBOOK", "TIKTOK"]);
    expect(client.approvalChain).toMatchObject({ steps: [{ name: "Manager review" }] });
  });
});

describe("health", () => {
  it.each(["/healthz", "/v1/healthz"])("GET %s is public", async (url) => {
    const response = await t.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz checks Postgres and Redis", async () => {
    const response = await t.app.inject({ method: "GET", url: "/readyz" });
    expect(response.json()).toEqual({ status: "ok", checks: { database: true, redis: true } });
    expect(response.statusCode).toBe(200);
  });
});

describe("sessions and capabilities", () => {
  it("rejects requests without a session", async () => {
    const response = await t.app.inject({ method: "GET", url: "/v1/_probe/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("accepts a cookie from sessionCookieFor()", async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user);
    const response = await t.app.inject({
      method: "GET",
      url: "/v1/_probe/me",
      headers: browserHeaders(cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: user.id });
  });

  it("rejects expired sessions and deactivated users", async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user, { now: t.clock.now(), ttlDays: 1 });
    const inactive = await createUser({ isActive: false });
    const inactiveCookie = await sessionCookieFor(inactive);

    const inactiveResponse = await t.app.inject({
      url: "/v1/_probe/me",
      headers: { cookie: inactiveCookie },
    });
    expect(inactiveResponse.statusCode).toBe(401);

    t.clock.advance(2 * DAY_MS);
    try {
      const response = await t.app.inject({ url: "/v1/_probe/me", headers: { cookie } });
      expect(response.statusCode).toBe(401);
    } finally {
      t.clock.set(Date.now());
    }
  });

  it("enforces the RBAC matrix", async () => {
    const editor = await createUser({ role: "EDITOR" });
    const admin = await createUser({ role: "ADMIN" });
    const forEditor = await t.app.inject({
      url: "/v1/_probe/users",
      headers: { cookie: await sessionCookieFor(editor) },
    });
    const forAdmin = await t.app.inject({
      url: "/v1/_probe/users",
      headers: { cookie: await sessionCookieFor(admin) },
    });
    expect(forEditor.statusCode).toBe(403);
    expect(forEditor.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(forAdmin.statusCode).toBe(200);
  });

  it("refuses to boot when a route declares no access rule", async () => {
    const deps = createDeps(testConfig(), { clock: t.clock });
    try {
      const app = await buildApp(deps);
      await expect(
        app.register(async (scope) => {
          scope.get("/v1/_probe/open", () => ({}));
          await Promise.resolve();
        }),
      ).rejects.toThrow(/declares no access rule/);
      await app.close();
    } finally {
      await deps.close();
    }
  });

  it("refuses to boot when a guard would only run after body validation", async () => {
    const deps = createDeps(testConfig(), { clock: t.clock });
    try {
      const app = await buildApp(deps);
      await expect(
        app.register(async (scope) => {
          scope.post("/v1/_probe/late", { preHandler: requireCap("clients.write") }, () => ({}));
          await Promise.resolve();
        }),
      ).rejects.toThrow(/runs an access guard after the request is parsed/);
      await app.close();
    } finally {
      await deps.close();
    }
  });
});

describe("request hygiene", () => {
  it("blocks state-changing requests from unknown origins", async () => {
    const missing = await t.app.inject({
      method: "POST",
      url: "/v1/_probe/echo",
      payload: { name: "x" },
    });
    const foreign = await t.app.inject({
      method: "POST",
      url: "/v1/_probe/echo",
      headers: { origin: "https://evil.example" },
      payload: { name: "x" },
    });
    const allowed = await t.app.inject({
      method: "POST",
      url: "/v1/_probe/echo",
      headers: browserHeaders(),
      payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(403);
    expect(foreign.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ body: { name: "x" } });
  });

  it("answers CORS preflights for allowed origins only", async () => {
    const preflight = (origin: string) =>
      t.app.inject({
        method: "OPTIONS",
        url: "/v1/_probe/echo",
        headers: { origin, "access-control-request-method": "POST" },
      });
    const allowed = await preflight(browserHeaders().origin ?? "");
    expect(allowed.headers["access-control-allow-origin"]).toBe(browserHeaders().origin);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const foreign = await preflight("https://evil.example");
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("accepts an empty JSON body and rejects non-JSON bodies", async () => {
    const empty = await t.app.inject({
      method: "POST",
      url: "/v1/_probe/echo",
      headers: { ...browserHeaders(), "content-type": "application/json" },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ body: null });

    const text = await t.app.inject({
      method: "POST",
      url: "/v1/_probe/echo",
      headers: { ...browserHeaders(), "content-type": "text/plain" },
      payload: "name=x",
    });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });

    const malformed = await t.app.inject({
      method: "POST",
      url: "/v1/_probe/echo",
      headers: { ...browserHeaders(), "content-type": "application/json" },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("reports validation failures in the shared error shape", async () => {
    const body = await t.app.inject({
      method: "POST",
      url: "/v1/_probe/echo",
      headers: browserHeaders(),
      payload: { name: "" },
    });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { where: "body", issues: [{ path: "name" }] } },
    });

    const thrown = await t.app.inject({ url: "/v1/_probe/zod" });
    expect(thrown.statusCode).toBe(400);
    expect(thrown.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("returns NOT_FOUND for unknown routes", async () => {
    const response = await t.app.inject({ url: "/v1/nope?x=1" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route GET /v1/nope not found" },
    });
  });
});
