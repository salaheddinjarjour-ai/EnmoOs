import type { Client } from "@enmo/db";
import {
  AUDIT_ACTIONS,
  META_OAUTH_SCOPES,
  OAUTH_STATE_TTL_SECONDS,
  OAuthResultQuery,
  OAuthSelectionDto,
  type ConnectOAuthSelectionResponse,
  type OAuthStartResponse,
  type SocialAccountDto,
} from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SECOND_MS } from "../../src/lib/clock";
import { createLogger } from "../../src/lib/logger";
import { browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor, type CookieHeader } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser, type TestUser } from "../helpers/factories";
import {
  FAKE_META_APP,
  FAKE_META_PAGES,
  GRAPH_ERRORS,
  startFakeGraph,
  type FakeGraph,
} from "../fakes/meta-graph";

/*
 * Connecting Meta accounts (DESIGN §E "OAuth", §F "Meta") against the fake Graph server: /start
 * mints a state bound to the admin's session and the client, Meta's consent dialog sends the
 * browser to the callback, which checks the state (once, same session, unexpired), exchanges the
 * code and keeps every Page and linked Instagram account Meta lists as a selection, then redirects
 * to the client's accounts tab to choose. Only the accounts the admin picks are stored, each with
 * its token encrypted at rest; another client's Page can't be picked, and the account a client
 * publishes through on a platform is its only one there, or an admin's explicit choice. Every
 * callback failure is a redirect with a readable message.
 */

const V = "/v26.0";
const [QAHWA, EVENTS] = FAKE_META_PAGES as [
  (typeof FAKE_META_PAGES)[number],
  (typeof FAKE_META_PAGES)[number],
];

let graph: FakeGraph;
let t: TestApp;
let admin: TestUser;
let adminCookie: CookieHeader;
let client: Client;

beforeAll(async () => {
  graph = await startFakeGraph();
  t = await buildTestApp({ metaBaseUrl: graph.url });
});

afterAll(async () => {
  await t.close();
  await graph.close();
});

beforeEach(async () => {
  graph.reset();
  t.clock.set(Date.now());
  admin = await createUser({ role: "ADMIN", name: "Salah" });
  adminCookie = await sessionCookieFor(admin, { now: t.clock.now() });
  client = await createClient({ name: "Qahwa Co" });
});

async function start(cookie = adminCookie, clientId = client.id, app = t) {
  return app.app.inject({
    method: "GET",
    url: `/v1/oauth/meta/start?clientId=${encodeURIComponent(clientId)}`,
    headers: browserHeaders(cookie),
  });
}

async function authorizeUrl(cookie = adminCookie, clientId = client.id): Promise<string> {
  const response = await start(cookie, clientId);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<OAuthStartResponse>().authorizeUrl;
}

/** Walks the consent dialog like a browser: the callback path and query Meta sends it to. */
async function consent(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(t.deps.config.META_REDIRECT_URI);
  return `${location.pathname}${location.search}`;
}

interface Landing {
  /** Path on the web app, e.g. /clients/abc. */
  path: string;
  result: OAuthResultQuery;
  tab: string | null;
}

/** GET the callback as the browser; returns where it sends the browser on the web app. */
async function callback(path: string, cookie?: CookieHeader, app = t): Promise<Landing> {
  const response = await app.app.inject({
    method: "GET",
    url: path,
    headers: cookie ? { cookie } : {},
  });
  expect(response.statusCode, response.body).toBe(302);
  const location = new URL(response.headers.location as string);
  expect(location.origin).toBe(new URL(app.deps.config.APP_PUBLIC_URL).origin);
  const query = Object.fromEntries(location.searchParams);
  return {
    path: location.pathname,
    result: OAuthResultQuery.parse(query),
    tab: location.searchParams.get("tab"),
  };
}

async function connect(cookie = adminCookie, clientId = client.id): Promise<Landing> {
  return callback(await consent(await authorizeUrl(cookie, clientId)), cookie);
}

/** The selection a successful callback lands with. */
function pickOf(landing: Landing): string {
  expect(landing).toMatchObject({
    path: `/clients/${client.id}`,
    tab: "accounts",
    result: { oauth: "meta", outcome: "choose" },
  });
  return landing.result.pick!;
}

function selection(pick: string, cookie = adminCookie) {
  return t.app.inject({
    method: "GET",
    url: `/v1/oauth/meta/selections/${pick}`,
    headers: browserHeaders(cookie),
  });
}

function choose(pick: string, keys: readonly string[], cookie = adminCookie) {
  return t.app.inject({
    method: "POST",
    url: `/v1/oauth/meta/selections/${pick}`,
    headers: browserHeaders(cookie),
    payload: { keys },
  });
}

/** What POST picks each fake account by. */
const KEYS = {
  instagram: `INSTAGRAM:${QAHWA.instagram!.id}`,
  qahwa: `FACEBOOK:${QAHWA.id}`,
  events: `FACEBOOK:${EVENTS.id}`,
} as const;

/** The whole round trip: sign in with Meta, then connect `keys` (all three by default). */
async function connectPicked(
  keys: readonly string[] = Object.values(KEYS),
): Promise<ConnectOAuthSelectionResponse> {
  const response = await choose(pickOf(await connect()), keys);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ConnectOAuthSelectionResponse>();
}

async function accountsOf(clientId = client.id) {
  return testDb().socialAccount.findMany({
    where: { clientId },
    orderBy: [{ platform: "asc" }, { externalId: "asc" }],
  });
}

describe("GET /v1/oauth/meta/start", () => {
  it("answers Meta's consent URL for the app, the API's callback, a state and a PKCE challenge", async () => {
    const url = new URL(await authorizeUrl());
    expect(`${url.origin}${url.pathname}`).toBe(`${graph.url}${V}/dialog/oauth`);
    const query = Object.fromEntries(url.searchParams);
    expect(query).toMatchObject({
      client_id: FAKE_META_APP.appId,
      redirect_uri: t.deps.config.META_REDIRECT_URI,
      response_type: "code",
      code_challenge_method: "S256",
    });
    expect(query.state).toMatch(/^[\w-]{40,}$/);
    expect(query.code_challenge).toMatch(/^[\w-]{43}$/);
    expect(query.scope?.split(",")).toEqual([...META_OAUTH_SCOPES]);

    // Only the state's hash is a Redis key, and the verifier never leaves the server.
    const keys = await t.deps.redis.keys(`${t.deps.config.BULLMQ_PREFIX}:oauth:meta:*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(query.state);
    expect(await t.deps.redis.ttl(keys[0]!)).toBeLessThanOrEqual(OAUTH_STATE_TTL_SECONDS);
  });

  it("mints a new state each time", async () => {
    const first = new URL(await authorizeUrl()).searchParams.get("state");
    const second = new URL(await authorizeUrl()).searchParams.get("state");
    expect(first).not.toBe(second);
  });

  it("is for admins only, and for clients that exist and aren't archived", async () => {
    const manager = await createUser({ role: "MANAGER" });
    const managerCookie = await sessionCookieFor(manager, { now: t.clock.now() });
    expect((await start(managerCookie)).statusCode).toBe(403);
    expect((await start(adminCookie, "nope")).statusCode).toBe(404);
    const archived = await createClient({ name: "Old Co", archivedAt: new Date() });
    expect((await start(adminCookie, archived.id)).statusCode).toBe(409);
  });

  it("answers 503 when no Meta app is configured", async () => {
    const bare = await buildTestApp();
    try {
      const response = await start(adminCookie, client.id, bare);
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "UNAVAILABLE", message: expect.stringContaining("META_APP_ID") as string },
      });
    } finally {
      await bare.close();
    }
  });
});

describe("GET /v1/oauth/meta/callback", () => {
  it("lists every Page and linked Instagram account for the admin to pick, storing none yet", async () => {
    const pick = pickOf(await connect());
    expect(pick).toMatch(/^[\w-]{40,}$/);
    expect(graph.sequence()).toEqual([
      `GET ${V}/dialog/oauth`,
      `GET ${V}/oauth/access_token`,
      `GET ${V}/oauth/access_token`,
      `GET ${V}/debug_token`,
      `GET ${V}/me/accounts`,
    ]);
    // Meta lists every Page the admin ever granted the app: nothing is anyone's account yet.
    expect(await accountsOf()).toEqual([]);

    // The list waits in Redis under the id's hash, its tokens encrypted.
    const keys = await t.deps.redis.keys(`${t.deps.config.BULLMQ_PREFIX}:oauth:meta:selection:*`);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(pick);
    const raw = (await t.deps.redis.get(keys[0]!))!;
    for (const token of [QAHWA.accessToken, EVENTS.accessToken, "fake-user-token"]) {
      expect(raw).not.toContain(token);
    }
    expect(await t.deps.redis.ttl(keys[0]!)).toBeLessThanOrEqual(OAUTH_STATE_TTL_SECONDS);

    const response = await selection(pick);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("fake-page-token");
    const listed = OAuthSelectionDto.parse(response.json());
    expect(listed).toMatchObject({ id: pick, clientId: client.id, clientName: "Qahwa Co" });
    expect(listed.accounts).toEqual([
      {
        key: KEYS.qahwa,
        platform: "FACEBOOK",
        externalId: QAHWA.id,
        handle: QAHWA.name,
        displayName: QAHWA.name,
        meta: { pageId: QAHWA.id, pageName: QAHWA.name, source: "oauth" },
        status: "available",
        takenBy: null,
      },
      expect.objectContaining({
        key: KEYS.instagram,
        platform: "INSTAGRAM",
        handle: QAHWA.instagram!.username,
        meta: expect.objectContaining({
          pageId: QAHWA.id,
          username: QAHWA.instagram!.username,
        }) as unknown,
        status: "available",
      }),
      expect.objectContaining({ key: KEYS.events, platform: "FACEBOOK", status: "available" }),
    ]);
  });

  it("connects only the picked accounts, each the client's publishing account on its platform", async () => {
    const pick = pickOf(await connect());
    const response = await choose(pick, [KEYS.qahwa, KEYS.instagram]);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("fake-page-token");
    const connected = response.json<ConnectOAuthSelectionResponse>();
    expect(connected.connected).toBe(2);
    expect(connected.items.map((item) => [item.platform, item.externalId, item.isPrimary])).toEqual(
      [
        ["INSTAGRAM", QAHWA.instagram!.id, true],
        ["FACEBOOK", QAHWA.id, true],
      ],
    );

    const accounts = await accountsOf();
    expect(accounts).toEqual([
      expect.objectContaining({
        platform: "INSTAGRAM",
        externalId: QAHWA.instagram!.id,
        handle: QAHWA.instagram!.username,
        status: "ACTIVE",
        isPrimary: true,
        scopes: [...META_OAUTH_SCOPES],
        tokenExpiresAt: null,
        connectedById: admin.id,
        meta: {
          pageId: QAHWA.id,
          pageName: QAHWA.name,
          igUserId: QAHWA.instagram!.id,
          username: QAHWA.instagram!.username,
          source: "oauth",
        },
      }),
      expect.objectContaining({
        platform: "FACEBOOK",
        externalId: QAHWA.id,
        handle: QAHWA.name,
        displayName: QAHWA.name,
        isPrimary: true,
        meta: { pageId: QAHWA.id, pageName: QAHWA.name, source: "oauth" },
      }),
    ]);
    // Encrypted at rest: the stored value is the cipher's, and it opens to the Page's token.
    for (const account of accounts) {
      expect(account.accessTokenEnc).toMatch(/^v1:/);
      expect(account.accessTokenEnc).not.toContain(QAHWA.accessToken);
      expect(t.deps.tokenCipher.decrypt(account.accessTokenEnc)).toBe(QAHWA.accessToken);
      expect(account.refreshTokenEnc).toBeNull();
    }

    const audits = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountConnect },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorId: admin.id,
      entityType: "SocialAccount",
      data: { clientId: client.id, source: "oauth", reconnected: false },
    });
    expect(
      await testDb().auditLog.count({ where: { action: AUDIT_ACTIONS.socialAccountPrimary } }),
    ).toBe(2);

    // The selection is used up, and the accounts API shows the accounts without any token.
    expect((await selection(pick)).statusCode).toBe(404);
    expect((await choose(pick, [KEYS.events])).statusCode).toBe(404);
    const listed = await t.app.inject({
      method: "GET",
      url: `/v1/clients/${client.id}/social-accounts`,
      headers: browserHeaders(adminCookie),
    });
    expect(listed.json<{ items: SocialAccountDto[] }>().items).toHaveLength(2);
    expect(listed.body).not.toContain("fake-page-token");
  });

  it("leaves the choice of the publishing Page to the admin when two are picked", async () => {
    const { items } = await connectPicked();
    expect(items.map((item) => [item.platform, item.handle, item.isPrimary])).toEqual([
      ["INSTAGRAM", QAHWA.instagram!.username, true],
      ["FACEBOOK", QAHWA.name, false],
      ["FACEBOOK", EVENTS.name, false],
    ]);
    // Nothing publishes to either Page until the admin says which.
    const facebook = items.find((item) => item.externalId === EVENTS.id)!;
    const chosen = await t.app.inject({
      method: "POST",
      url: `/v1/social-accounts/${facebook.id}/primary`,
      headers: browserHeaders(adminCookie),
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    const primary = await testDb().socialAccount.findMany({
      where: { clientId: client.id, platform: "FACEBOOK", isPrimary: true },
    });
    expect(primary.map((account) => account.externalId)).toEqual([EVENTS.id]);
  });

  it("refreshes the accounts in place when the admin connects again", async () => {
    await connectPicked();
    const before = await accountsOf();
    await testDb().socialAccount.updateMany({
      where: { clientId: client.id },
      data: { status: "EXPIRED" },
    });

    // Already this client's: listed as connected, and picked again to refresh their tokens.
    const pick = pickOf(await connect());
    const listed = OAuthSelectionDto.parse((await selection(pick)).json());
    expect(listed.accounts.map((account) => account.status)).toEqual([
      "connected",
      "connected",
      "connected",
    ]);
    const response = await choose(pick, Object.values(KEYS));
    expect(response.json<ConnectOAuthSelectionResponse>().connected).toBe(3);
    const after = await accountsOf();
    expect(after.map((account) => account.id)).toEqual(before.map((account) => account.id));
    expect(after.every((account) => account.status === "ACTIVE")).toBe(true);
    const audits = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountConnect },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.slice(3).map((audit) => audit.data)).toEqual([
      expect.objectContaining({ reconnected: true }),
      expect.objectContaining({ reconnected: true }),
      expect.objectContaining({ reconnected: true }),
    ]);
  });

  it("keeps a selection to the session that made it, until it expires", async () => {
    const pick = pickOf(await connect());
    const otherAdmin = await createUser({ role: "ADMIN" });
    const other = await sessionCookieFor(otherAdmin, { now: t.clock.now() });
    const sameAdminElsewhere = await sessionCookieFor(admin, { now: t.clock.now() });
    for (const cookie of [other, sameAdminElsewhere]) {
      expect((await selection(pick, cookie)).statusCode).toBe(404);
      expect((await choose(pick, [KEYS.qahwa], cookie)).statusCode).toBe(404);
    }
    const unknown = await choose(pick, [KEYS.qahwa, "FACEBOOK:999"]);
    expect(unknown.statusCode).toBe(422);
    expect(await accountsOf()).toEqual([]);

    t.clock.advance(OAUTH_STATE_TTL_SECONDS * SECOND_MS + 1);
    const expired = await selection(pick);
    expect(expired.statusCode).toBe(404);
    expect(expired.json()).toMatchObject({
      error: { message: expect.stringContaining("expired or was already used") as string },
    });
  });

  it("works once: a replayed callback is refused", async () => {
    const path = await consent(await authorizeUrl());
    expect((await callback(path, adminCookie)).result.outcome).toBe("choose");

    const replay = await callback(path, adminCookie);
    expect(replay.path).toBe("/clients");
    expect(replay.result).toMatchObject({
      oauth: "meta",
      outcome: "error",
      message: expect.stringContaining("expired or was already used") as string,
    });
    // Meta was asked for the code once.
    expect(graph.sequence().filter((call) => call.endsWith("/oauth/access_token"))).toHaveLength(2);
  });

  it("refuses a state started in another session, and burns it", async () => {
    const path = await consent(await authorizeUrl());
    const otherAdmin = await createUser({ role: "ADMIN" });
    const other = await callback(path, await sessionCookieFor(otherAdmin, { now: t.clock.now() }));
    expect(other.path).toBe("/clients");
    expect(other.result).toMatchObject({
      outcome: "error",
      message: expect.stringContaining("same signed-in browser session") as string,
    });
    // The same admin in a second session (another browser) is no better.
    const secondSession = await callback(
      await consent(await authorizeUrl()),
      await sessionCookieFor(admin, { now: t.clock.now() }),
    );
    expect(secondSession.result.outcome).toBe("error");

    expect((await callback(path, adminCookie)).result.outcome).toBe("error");
    expect(await accountsOf()).toEqual([]);
    expect(graph.sequence().some((call) => call.endsWith("/oauth/access_token"))).toBe(false);
  });

  it("refuses a callback without a session", async () => {
    const landing = await callback(await consent(await authorizeUrl()));
    expect(landing).toMatchObject({ path: "/clients", result: { outcome: "error" } });
    expect(await accountsOf()).toEqual([]);
  });

  it("refuses an expired state", async () => {
    const path = await consent(await authorizeUrl());
    t.clock.advance(OAUTH_STATE_TTL_SECONDS * SECOND_MS + 1);
    const landing = await callback(path, adminCookie);
    expect(landing.result).toMatchObject({
      outcome: "error",
      message: expect.stringContaining("expired") as string,
    });
    expect(await accountsOf()).toEqual([]);
  });

  it("refuses an unknown or missing state", async () => {
    const path = await consent(await authorizeUrl());
    const url = new URL(path, "http://api.test");
    url.searchParams.set("state", "forged-state-value");
    const forged = await callback(`${url.pathname}${url.search}`, adminCookie);
    expect(forged).toMatchObject({ path: "/clients", result: { outcome: "error" } });

    url.searchParams.delete("state");
    const missing = await callback(`${url.pathname}${url.search}`, adminCookie);
    expect(missing.result.message).toContain("didn't come back with our state");

    const blank = await callback(`/v1/oauth/meta/callback?state=&code=`, adminCookie);
    expect(blank).toMatchObject({ path: "/clients", result: { outcome: "error" } });
    expect(await accountsOf()).toEqual([]);
  });

  it("says so when the admin declines on Meta's screen", async () => {
    graph.state.consent = "deny";
    const landing = await connect();
    expect(landing).toEqual({
      path: `/clients/${client.id}`,
      tab: "accounts",
      result: {
        oauth: "meta",
        outcome: "error",
        message: "The Meta sign-in was cancelled, so nothing was connected.",
      },
    });
    expect(await accountsOf()).toEqual([]);
  });

  it("shows a Page another client has as taken: it can't be picked, and the rest still connect", async () => {
    const other = await createClient({ name: "Other Co" });
    await testDb().socialAccount.create({
      data: {
        clientId: other.id,
        platform: "FACEBOOK",
        externalId: EVENTS.id,
        handle: EVENTS.name,
        accessTokenEnc: t.deps.tokenCipher.encrypt("other-token"),
        isPrimary: true,
      },
    });
    const pick = pickOf(await connect());
    const listed = OAuthSelectionDto.parse((await selection(pick)).json());
    expect(listed.accounts.find((account) => account.key === KEYS.events)).toMatchObject({
      status: "taken",
      takenBy: { clientId: other.id, clientName: "Other Co" },
    });

    const refused = await choose(pick, [KEYS.qahwa, KEYS.events]);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      error: {
        message: expect.stringContaining(
          `"${EVENTS.name}" is already connected to Other Co`,
        ) as string,
      },
    });
    expect(await accountsOf()).toEqual([]);

    // The same list, picked again without it.
    const connected = await choose(pick, [KEYS.qahwa, KEYS.instagram]);
    expect(connected.statusCode, connected.body).toBe(200);
    expect((await accountsOf()).map((account) => account.externalId)).toEqual([
      QAHWA.instagram!.id,
      QAHWA.id,
    ]);
    const others = await accountsOf(other.id);
    expect(others).toEqual([expect.objectContaining({ externalId: EVENTS.id, isPrimary: true })]);
  });

  it("says so when Meta fails during the exchange", async () => {
    graph.failNext({
      match: /^GET \/v26\.0\/oauth\/access_token$/,
      status: 500,
      error: GRAPH_ERRORS.unavailable,
    });
    const landing = await connect();
    expect(landing.result).toMatchObject({
      outcome: "error",
      message: expect.stringContaining("Meta didn't answer as expected") as string,
    });
    expect(await accountsOf()).toEqual([]);
  });

  it("says so when the admin ticked no Page", async () => {
    graph.state.pages = [];
    const landing = await connect();
    expect(landing.result).toMatchObject({
      outcome: "error",
      message: expect.stringContaining("no Facebook Page") as string,
    });
  });

  it("refuses an admin who lost the right to connect accounts meanwhile", async () => {
    const path = await consent(await authorizeUrl());
    await testDb().user.update({ where: { id: admin.id }, data: { role: "MANAGER" } });
    const landing = await callback(path, adminCookie);
    expect(landing).toMatchObject({
      path: `/clients/${client.id}`,
      result: {
        outcome: "error",
        message: expect.stringContaining("no longer have permission") as string,
      },
    });
    expect(await accountsOf()).toEqual([]);
  });

  it("never writes codes, states or tokens to the logs", async () => {
    const lines: string[] = [];
    const logged = await buildTestApp({
      metaBaseUrl: graph.url,
      logger: createLogger({
        level: "trace",
        name: "oauth-test",
        destination: { write: (line: string) => void lines.push(line) },
      }),
    });
    try {
      const response = await logged.app.inject({
        method: "GET",
        url: `/v1/oauth/meta/start?clientId=${client.id}`,
        headers: browserHeaders(adminCookie),
      });
      const url = new URL(response.json<OAuthStartResponse>().authorizeUrl);
      const path = await consent(url.toString());
      const callbackUrl = new URL(path, "http://api.test");
      const landing = await callback(path, adminCookie, logged);
      const picked = await logged.app.inject({
        method: "POST",
        url: `/v1/oauth/meta/selections/${pickOf(landing)}`,
        headers: browserHeaders(adminCookie),
        payload: { keys: Object.values(KEYS) },
      });
      expect(picked.statusCode, picked.body).toBe(200);

      const text = lines.join("\n");
      expect(text).toContain("/v1/oauth/meta/callback");
      for (const secret of [
        url.searchParams.get("state"),
        url.searchParams.get("code_challenge"),
        callbackUrl.searchParams.get("code"),
        QAHWA.accessToken,
        EVENTS.accessToken,
        "fake-user-token",
      ]) {
        expect(secret).toBeTruthy();
        expect(text).not.toContain(secret);
      }
    } finally {
      await logged.close();
    }
  });
});

describe("POST /v1/social-accounts/:id/check on a Meta account", () => {
  async function check(id: string) {
    return t.app.inject({
      method: "POST",
      url: `/v1/social-accounts/${id}/check`,
      headers: browserHeaders(adminCookie),
    });
  }

  it("asks Meta's debug_token whether the token still works", async () => {
    await connectPicked();
    const [instagram] = await accountsOf();
    graph.reset();

    const ok = await check(instagram!.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<SocialAccountDto>().status).toBe("ACTIVE");
    expect(graph.sequence()).toEqual([`GET ${V}/debug_token`]);

    graph.state.invalidTokens.add(QAHWA.accessToken);
    const revoked = await check(instagram!.id);
    expect(revoked.json<SocialAccountDto>().status).toBe("REVOKED");
  });

  it("answers 503 when Meta can't be asked, and leaves the account alone", async () => {
    await connectPicked();
    const [instagram] = await accountsOf();
    graph.failNext({ match: /debug_token$/, status: 500, error: GRAPH_ERRORS.unavailable });
    const response = await check(instagram!.id);
    expect(response.statusCode, response.body).toBe(503);
    const stored = await testDb().socialAccount.findUniqueOrThrow({ where: { id: instagram!.id } });
    expect(stored.status).toBe("ACTIVE");
  });
});
