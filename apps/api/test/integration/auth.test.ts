import {
  AUDIT_ACTIONS,
  SESSION_COOKIE_NAME,
  capabilitiesFor,
  type SessionResponse,
} from "@enmo/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAY_MS, MINUTE_MS } from "../../src/lib/clock";
import { sha256 } from "../../src/lib/tokens";
import { TEST_ORIGIN, browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { loginAs, sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { DEFAULT_TEST_PASSWORD, createUser } from "../helpers/factories";

/*
 * POST /auth/login · POST /auth/logout · GET /auth/me · POST /auth/password, plus the cookie,
 * rolling-session, rate-limit and request-hygiene rules around them (DESIGN §E).
 * Each test gets a fresh app, so the in-memory login rate-limit counters start at zero.
 */

let t: TestApp;

beforeEach(async () => {
  t = await buildTestApp();
});

afterEach(async () => {
  await t.close();
});

interface LoginOptions {
  cookie?: string;
  remoteAddress?: string;
}

function postLogin(
  app: TestApp["app"],
  body: { email: string; password: string },
  options: LoginOptions = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: browserHeaders(options.cookie),
    payload: body,
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
  });
}

function sessionCookieOf(response: LightMyRequestResponse) {
  return response.cookies.find(({ name }) => name === SESSION_COOKIE_NAME);
}

function cookieHeader(response: LightMyRequestResponse): string {
  const cookie = sessionCookieOf(response);
  if (!cookie) throw new Error(`no ${SESSION_COOKIE_NAME} cookie in the response`);
  return `${cookie.name}=${cookie.value}`;
}

function rawSetCookie(response: LightMyRequestResponse): string {
  return [response.headers["set-cookie"] ?? []].flat().join("\n");
}

const me = (cookie?: string) =>
  t.app.inject({ method: "GET", url: "/v1/auth/me", headers: browserHeaders(cookie) });

/** A wrong sign-in for a distinct, non-existent account (so only the per-IP limit counts). */
const guess = (i: number) => ({ email: `guess-${i}@enmo.test`, password: "wrong-password-guess" });

const auditRows = (action: string) =>
  testDb().auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

describe("POST /v1/auth/login", () => {
  it("signs in, sets the session cookie and stores only its sha256", async () => {
    const user = await createUser({ role: "MANAGER" });
    const now = t.clock.now();

    // Emails are matched case-insensitively and trimmed.
    const response = await postLogin(t.app, {
      email: `  ${user.email.toUpperCase()} `,
      password: user.password,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<SessionResponse>()).toEqual({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: "MANAGER",
        isActive: true,
        lastLoginAt: now.toISOString(),
        createdAt: user.createdAt.toISOString(),
      },
      capabilities: capabilitiesFor("MANAGER"),
    });

    const cookie = sessionCookieOf(response);
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 86_400,
    });
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie?.domain).toBeUndefined();
    expect(cookie?.secure).toBeFalsy();

    const [session, ...others] = await testDb().session.findMany({ where: { userId: user.id } });
    expect(others).toHaveLength(0);
    expect(session).toMatchObject({
      tokenHash: sha256(cookie?.value ?? ""),
      ip: "127.0.0.1",
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 30 * DAY_MS),
    });
    expect(JSON.stringify(session)).not.toContain(cookie?.value);

    const [audit] = await auditRows(AUDIT_ACTIONS.authLogin);
    expect(audit).toMatchObject({
      actorId: user.id,
      entityType: "User",
      entityId: user.id,
      ip: "127.0.0.1",
      data: { sessionId: session?.id },
    });

    const current = await me(cookieHeader(response));
    expect(current.statusCode).toBe(200);
    expect(current.json<SessionResponse>().user.id).toBe(user.id);
  });

  it("applies COOKIE_DOMAIN, COOKIE_SECURE and SESSION_TTL_DAYS to the cookie", async () => {
    const custom = await buildTestApp({
      env: { COOKIE_DOMAIN: ".enmo.test", COOKIE_SECURE: "true", SESSION_TTL_DAYS: "7" },
    });
    try {
      const user = await createUser();
      const response = await postLogin(custom.app, user);
      expect(response.statusCode).toBe(200);
      expect(sessionCookieOf(response)).toMatchObject({
        domain: ".enmo.test",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 7 * 86_400,
      });
      expect(rawSetCookie(response)).toMatch(/Domain=\.enmo\.test/);
    } finally {
      await custom.close();
    }
  });

  it("answers every failure with the same generic 401 and audits the reason", async () => {
    const active = await createUser();
    const inactive = await createUser({ isActive: false });

    const attempts = [
      { email: active.email, password: "not-the-right-password" },
      { email: "nobody@enmo.test", password: DEFAULT_TEST_PASSWORD },
      { email: inactive.email, password: inactive.password },
    ];
    for (const attempt of attempts) {
      const response = await postLogin(t.app, attempt);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Invalid email or password" },
      });
      expect(sessionCookieOf(response)).toBeUndefined();
    }

    expect(await testDb().session.count()).toBe(0);
    const failures = await auditRows(AUDIT_ACTIONS.authLoginFailed);
    expect(
      failures.map(({ actorId, entityId, data, ip }) => ({ actorId, entityId, data, ip })),
    ).toEqual([
      {
        actorId: null,
        entityId: active.id,
        data: { email: active.email, reason: "bad_password" },
        ip: "127.0.0.1",
      },
      {
        actorId: null,
        entityId: null,
        data: { email: "nobody@enmo.test", reason: "unknown_email" },
        ip: "127.0.0.1",
      },
      {
        actorId: null,
        entityId: inactive.id,
        data: { email: inactive.email, reason: "inactive" },
        ip: "127.0.0.1",
      },
    ]);
  });

  it("validates the body", async () => {
    const response = await postLogin(t.app, { email: "not-an-email", password: "" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("deletes the user's lapsed sessions, keeping live ones and other users'", async () => {
    const user = await createUser();
    const other = await createUser();
    const now = Date.now();
    const seed = (userId: string, name: string, expiresInMs: number) =>
      testDb().session.create({
        data: { tokenHash: sha256(name), userId, expiresAt: new Date(now + expiresInMs) },
      });
    await seed(user.id, "lapsed", -DAY_MS);
    const live = await seed(user.id, "other-device", DAY_MS);
    const othersLapsed = await seed(other.id, "someone-else", -DAY_MS);

    expect((await postLogin(t.app, user)).statusCode).toBe(200);

    const remaining = await testDb().session.findMany({ select: { id: true, tokenHash: true } });
    expect(remaining.map(({ tokenHash }) => tokenHash)).not.toContain(sha256("lapsed"));
    expect(remaining.map(({ id }) => id)).toEqual(
      expect.arrayContaining([live.id, othersLapsed.id]),
    );
    expect(remaining).toHaveLength(3);
  });

  it("replaces the session the browser already had", async () => {
    const user = await createUser();
    const first = cookieHeader(await postLogin(t.app, user));
    const second = await postLogin(t.app, user, { cookie: first });
    expect(second.statusCode).toBe(200);

    const sessions = await testDb().session.findMany({ where: { userId: user.id } });
    expect(sessions.map(({ tokenHash }) => tokenHash)).toEqual([
      sha256(sessionCookieOf(second)?.value ?? ""),
    ]);
    expect((await me(first)).statusCode).toBe(401);
  });
});

describe("login rate limits", () => {
  it("allows 5 attempts per email per minute, from any IP", async () => {
    const user = await createUser();
    for (let i = 1; i <= 5; i += 1) {
      const response = await postLogin(
        t.app,
        { email: user.email, password: "wrong-password-guess" },
        { remoteAddress: `10.0.0.${i}` },
      );
      expect(response.statusCode).toBe(401);
    }

    const blocked = await postLogin(t.app, user, { remoteAddress: "10.0.0.6" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(sessionCookieOf(blocked)).toBeUndefined();

    // Other accounts from the same address are unaffected.
    const other = await createUser();
    expect((await postLogin(t.app, other, { remoteAddress: "10.0.0.6" })).statusCode).toBe(200);
  });

  it("allows 10 attempts per IP per minute, across emails", async () => {
    const user = await createUser();
    for (let i = 1; i <= 10; i += 1) {
      const response = await postLogin(
        t.app,
        { email: `guess-${i}@enmo.test`, password: "wrong-password-guess" },
        { remoteAddress: "10.1.1.1" },
      );
      expect(response.statusCode).toBe(401);
    }

    const blocked = await postLogin(t.app, user, { remoteAddress: "10.1.1.1" });
    expect(blocked.statusCode).toBe(429);

    // Throttled requests are not audited as login failures (no write amplification).
    expect(
      await testDb().auditLog.count({ where: { action: AUDIT_ACTIONS.authLoginFailed } }),
    ).toBe(10);
    expect((await postLogin(t.app, user, { remoteAddress: "10.1.1.2" })).statusCode).toBe(200);
  });

  it("behind one trusted proxy hop, keys the IP limit on the address the proxy appended", async () => {
    const proxied = await buildTestApp({ env: { TRUST_PROXY: "1" } });
    try {
      const user = await createUser();
      // The client controls everything left of the proxy's own entry, so varying it must not help.
      const viaProxy = (forged: string) =>
        proxied.app.inject({
          method: "POST",
          url: "/v1/auth/login",
          headers: { ...browserHeaders(), "x-forwarded-for": `${forged}, 203.0.113.7` },
          payload: { email: `guess-${forged}@enmo.test`, password: "wrong-password-guess" },
          remoteAddress: "10.200.0.1",
        });
      for (let i = 1; i <= 10; i += 1) {
        expect((await viaProxy(`198.51.100.${i}`)).statusCode).toBe(401);
      }
      expect((await viaProxy("198.51.100.11")).statusCode).toBe(429);

      const failures = await auditRows(AUDIT_ACTIONS.authLoginFailed);
      expect(new Set(failures.map(({ ip }) => ip))).toEqual(new Set(["203.0.113.7"]));

      // A different client behind the same proxy is unaffected.
      const other = await proxied.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { ...browserHeaders(), "x-forwarded-for": "203.0.113.8" },
        payload: { email: user.email, password: user.password },
        remoteAddress: "10.200.0.1",
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await proxied.close();
    }
  });

  it("with the production proxy list, keys the IP limit on the visitor Cloudflare saw", async () => {
    const proxied = await buildTestApp({
      env: { TRUST_PROXY: "loopback,uniquelocal,cloudflare" },
    });
    try {
      const user = await createUser();
      // Render's path: visitor → Cloudflare edge → Render's internal hop → Node, optionally with
      // our own Cloudflare zone in front. Cloudflare writes CF-Connecting-IP; the client writes
      // whatever it likes into X-Forwarded-For, and the hop count differs. The visitor must not.
      const viaEdge = (forged: string, visitor: string, ownZone: boolean, payload: object) =>
        proxied.app.inject({
          method: "POST",
          url: "/v1/auth/login",
          headers: {
            ...browserHeaders(),
            "x-forwarded-for": [
              forged,
              visitor,
              ...(ownZone ? ["162.158.90.12"] : []),
              "172.71.150.145",
              "10.192.163.192",
            ].join(", "),
            "cf-connecting-ip": visitor,
          },
          payload,
          remoteAddress: "10.201.4.7",
        });

      for (let i = 1; i <= 10; i += 1) {
        const response = await viaEdge(`198.51.100.${i}`, "203.0.113.7", i % 2 === 0, guess(i));
        expect(response.statusCode).toBe(401);
      }
      expect((await viaEdge("198.51.100.11", "203.0.113.7", false, guess(11))).statusCode).toBe(
        429,
      );

      const failures = await auditRows(AUDIT_ACTIONS.authLoginFailed);
      expect(new Set(failures.map(({ ip }) => ip))).toEqual(new Set(["203.0.113.7"]));

      // Another visitor through the same edge and the same Render hop is unaffected.
      const other = await viaEdge("198.51.100.12", "203.0.113.8", true, {
        email: user.email,
        password: user.password,
      });
      expect(other.statusCode).toBe(200);
      const [session] = await testDb().session.findMany({ where: { userId: user.id } });
      expect(session?.ip).toBe("203.0.113.8");
    } finally {
      await proxied.close();
    }
  });

  it("with the production proxy list, a Cloudflare Worker can't choose its IP", async () => {
    const proxied = await buildTestApp({
      env: { TRUST_PROXY: "loopback,uniquelocal,cloudflare" },
    });
    try {
      // Someone else's Worker fetch()es the API with a fresh X-Forwarded-For each time. Its request
      // leaves Cloudflare from the Workers egress range, which Cloudflare appends to the header and
      // writes into CF-Connecting-IP, so every such attempt lands in one bucket.
      const WORKER_EGRESS = "2a06:98c0:3600::103";
      const viaWorker = (i: number) =>
        proxied.app.inject({
          method: "POST",
          url: "/v1/auth/login",
          headers: {
            ...browserHeaders(),
            "x-forwarded-for": `198.51.100.${i}, ${WORKER_EGRESS}, 172.71.150.145, 10.192.163.192`,
            "cf-connecting-ip": WORKER_EGRESS,
          },
          payload: guess(i),
          remoteAddress: "10.201.4.7",
        });

      for (let i = 1; i <= 10; i += 1) expect((await viaWorker(i)).statusCode).toBe(401);
      expect((await viaWorker(11)).statusCode).toBe(429);

      const failures = await auditRows(AUDIT_ACTIONS.authLoginFailed);
      expect(new Set(failures.map(({ ip }) => ip))).toEqual(new Set([WORKER_EGRESS]));
    } finally {
      await proxied.close();
    }
  });

  it("forgets attempts after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const user = await createUser();
      for (let i = 0; i < 5; i += 1) {
        await postLogin(t.app, { email: user.email, password: "wrong-password-guess" });
      }
      expect((await postLogin(t.app, user)).statusCode).toBe(429);

      vi.setSystemTime(Date.now() + MINUTE_MS + 1000);
      expect((await postLogin(t.app, user)).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /v1/auth/logout", () => {
  it("deletes the session row, expires the cookie and audits", async () => {
    const user = await createUser();
    const cookie = await loginAs(t.app, user);

    const response = await t.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: browserHeaders(cookie),
    });
    expect(response.statusCode).toBe(204);
    expect(sessionCookieOf(response)).toMatchObject({ value: "", path: "/", maxAge: 0 });
    expect(await testDb().session.count()).toBe(0);
    expect((await me(cookie)).statusCode).toBe(401);

    const [audit] = await auditRows(AUDIT_ACTIONS.authLogout);
    expect(audit).toMatchObject({ actorId: user.id, entityId: user.id, ip: "127.0.0.1" });
  });

  it("is idempotent for missing, unknown and already-ended sessions", async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE_NAME}=not-a-real-token`]) {
      const response = await t.app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: browserHeaders(cookie),
      });
      expect(response.statusCode).toBe(204);
    }
    expect(await testDb().auditLog.count()).toBe(0);
  });
});

describe("GET /v1/auth/me", () => {
  it("returns the signed-in user with their capabilities", async () => {
    const user = await createUser({ role: "EDITOR" });
    const response = await me(await sessionCookieFor(user, { now: t.clock.now() }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: user.id, role: "EDITOR", lastLoginAt: null },
      capabilities: capabilitiesFor("EDITOR"),
    });
  });

  it("is 401 without a valid session", async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE_NAME}=forged`]) {
      const response = await me(cookie);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    }
  });
});

describe("rolling sessions", () => {
  it("extends the session and re-issues the cookie at most every 5 minutes", async () => {
    const user = await createUser();
    const cookie = await loginAs(t.app, user);
    const token = cookie.split("=")[1];
    const start = t.clock.now();
    const session = () => testDb().session.findFirstOrThrow({ where: { userId: user.id } });

    t.clock.advance(4 * MINUTE_MS);
    const early = await me(cookie);
    expect(early.statusCode).toBe(200);
    expect(early.headers["set-cookie"]).toBeUndefined();
    expect((await session()).lastSeenAt).toEqual(start);

    const refreshedAt = t.clock.advance(MINUTE_MS);
    const due = await me(cookie);
    expect(due.statusCode).toBe(200);
    expect(sessionCookieOf(due)).toMatchObject({
      value: token,
      httpOnly: true,
      maxAge: 30 * 86_400,
    });
    expect(await session()).toMatchObject({
      lastSeenAt: refreshedAt,
      expiresAt: new Date(refreshedAt.getTime() + 30 * DAY_MS),
    });

    t.clock.advance(MINUTE_MS);
    expect((await me(cookie)).headers["set-cookie"]).toBeUndefined();
  });

  it("keeps a session in use alive past its original expiry", async () => {
    const user = await createUser();
    const cookie = await loginAs(t.app, user);

    t.clock.advance(29 * DAY_MS);
    expect((await me(cookie)).statusCode).toBe(200);
    t.clock.advance(29 * DAY_MS);
    expect((await me(cookie)).statusCode).toBe(200);
  });

  it("ends an idle session after SESSION_TTL_DAYS and deletes its row", async () => {
    const user = await createUser();
    const cookie = await loginAs(t.app, user);

    t.clock.advance(30 * DAY_MS);
    expect((await me(cookie)).statusCode).toBe(401);
    expect(await testDb().session.count()).toBe(0);
  });
});

describe("POST /v1/auth/password", () => {
  const changePassword = (cookie: string, payload: object) =>
    t.app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: browserHeaders(cookie),
      payload,
    });

  it("changes the password, keeps this session and signs out the others", async () => {
    const user = await createUser();
    const current = await loginAs(t.app, user);
    const elsewhere = await sessionCookieFor(user, { now: t.clock.now() });
    const newPassword = "an-entirely-new-passphrase";

    const response = await changePassword(current, {
      currentPassword: user.password,
      newPassword,
    });
    expect(response.statusCode).toBe(204);

    expect((await me(current)).statusCode).toBe(200);
    expect((await me(elsewhere)).statusCode).toBe(401);
    expect((await postLogin(t.app, user)).statusCode).toBe(401);
    expect((await postLogin(t.app, { email: user.email, password: newPassword })).statusCode).toBe(
      200,
    );

    const [audit] = await auditRows(AUDIT_ACTIONS.authPasswordChange);
    expect(audit).toMatchObject({ actorId: user.id, data: { otherSessionsRevoked: 1 } });
  });

  it("reports a wrong current password as a field error, not a lost session", async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user, { now: t.clock.now() });

    const response = await changePassword(cookie, {
      currentPassword: "definitely-not-it",
      newPassword: "an-entirely-new-passphrase",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { issues: [{ path: "currentPassword" }] } },
    });
    expect((await me(cookie)).statusCode).toBe(200);
  });

  it("enforces the password policy", async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user, { now: t.clock.now() });

    const short = await changePassword(cookie, {
      currentPassword: user.password,
      newPassword: "too-short",
    });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({
      error: { details: { issues: [{ path: "newPassword" }] } },
    });

    const same = await changePassword(cookie, {
      currentPassword: user.password,
      newPassword: user.password,
    });
    expect(same.statusCode).toBe(400);
  });

  it("throttles guesses at the current password", async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user, { now: t.clock.now() });
    const guess = {
      currentPassword: "guess-guess-guess",
      newPassword: "an-entirely-new-passphrase",
    };

    for (let i = 0; i < 5; i += 1) {
      expect((await changePassword(cookie, guess)).statusCode).toBe(400);
    }
    expect((await changePassword(cookie, guess)).statusCode).toBe(429);
  });
});

describe("request hygiene", () => {
  it("refuses state-changing calls without an allowed Origin, before doing any work", async () => {
    const user = await createUser();
    for (const headers of [{}, { origin: "https://evil.example" }]) {
      const response = await t.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers,
        payload: { email: user.email, password: user.password },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
    expect(await testDb().auditLog.count()).toBe(0);
    expect(await testDb().session.count()).toBe(0);
  });

  it("only accepts JSON bodies", async () => {
    const user = await createUser();
    for (const contentType of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/plain",
    ]) {
      const response = await t.app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { ...browserHeaders(), "content-type": contentType },
        payload: `email=${encodeURIComponent(user.email)}&password=${user.password}`,
      });
      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    }
  });

  it("sends security headers on every response, and CORS headers for the web origin", async () => {
    const response = await me();
    expect(response.statusCode).toBe(401);
    expect(response.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
      "access-control-allow-origin": TEST_ORIGIN,
      "access-control-allow-credentials": "true",
    });
    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });

  it("adds HSTS in production", async () => {
    const production = await buildTestApp({ env: { NODE_ENV: "production" } });
    try {
      const response = await production.app.inject({ method: "GET", url: "/healthz" });
      expect(response.headers["strict-transport-security"]).toBe(
        "max-age=31536000; includeSubDomains",
      );
    } finally {
      await production.close();
    }
  });
});
