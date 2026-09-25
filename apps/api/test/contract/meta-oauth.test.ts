import {
  MetaOAuthProvider,
  OAuthError,
  createMetaOAuthProvider,
  createPkcePair,
  type OAuthProvider,
} from "@enmo/providers";
import { META_OAUTH_SCOPES, missingPublishScopes } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type EnvSource } from "../../src/config";
import { metaOAuthConfigFrom } from "../../src/deps";
import {
  FAKE_META_APP,
  FAKE_META_PAGES,
  fakeGraphEnv,
  startFakeGraph,
  type FakeGraph,
} from "../fakes/meta-graph";

/*
 * The real MetaOAuthProvider (DESIGN §F "Meta OAuth") against the fake Graph server: the consent
 * URL, code → long-lived token → granted scopes, the Pages and linked Instagram accounts it
 * reaches, debug_token for tick.tokens, and the OAuthError each refusal becomes.
 */

let graph: FakeGraph;

beforeAll(async () => {
  graph = await startFakeGraph();
});

afterAll(async () => {
  await graph.close();
});

beforeEach(() => {
  graph.reset();
});

const V = "/v26.0";
const API = "https://api.enmo.test";
const CALLBACK = `${API}/v1/oauth/meta/callback`;
const [QAHWA, EVENTS] = FAKE_META_PAGES as [
  (typeof FAKE_META_PAGES)[number],
  (typeof FAKE_META_PAGES)[number],
];
const DAY_MS = 86_400_000;

function providerFor(env: EnvSource = fakeGraphEnv(graph.url)): OAuthProvider {
  const config = loadConfig({
    NODE_ENV: "test",
    API_PUBLIC_URL: API,
    PUBLISH_MODE: "live",
    ...env,
  });
  const provider = createMetaOAuthProvider(metaOAuthConfigFrom(config));
  expect(provider).toBeInstanceOf(MetaOAuthProvider);
  return provider;
}

/** Walks the consent dialog like a browser would, returning the callback's query. */
async function consent(authorizeUrl: string): Promise<URLSearchParams> {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
  return location.searchParams;
}

async function oauthFailure(promise: Promise<unknown>): Promise<OAuthError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OAuthError);
  return error as OAuthError;
}

describe("the consent dialog", () => {
  it("asks for every Meta scope for the app, the API's callback and the state", () => {
    const pkce = createPkcePair();
    const url = new URL(providerFor().authorizeUrl("state-1", pkce));
    expect(`${url.origin}${url.pathname}`).toBe(`${graph.url}${V}/dialog/oauth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: FAKE_META_APP.appId,
      redirect_uri: CALLBACK,
      state: "state-1",
      response_type: "code",
      scope: META_OAUTH_SCOPES.join(","),
      auth_type: "rerequest",
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    });
    expect(graph.calls).toEqual([]);
  });
});

describe("connecting", () => {
  it("exchanges the code for a long-lived token and learns the granted scopes", async () => {
    const provider = providerFor();
    const pkce = createPkcePair();
    const callback = await consent(provider.authorizeUrl("state-1", pkce));
    expect(callback.get("state")).toBe("state-1");

    const before = Date.now();
    const tokens = await provider.exchange(callback.get("code")!, pkce);
    expect(graph.sequence()).toEqual([
      `GET ${V}/dialog/oauth`,
      `GET ${V}/oauth/access_token`,
      `GET ${V}/oauth/access_token`,
      `GET ${V}/debug_token`,
    ]);
    expect(graph.calls[1]?.query).toEqual({
      client_id: FAKE_META_APP.appId,
      client_secret: FAKE_META_APP.appSecret,
      redirect_uri: CALLBACK,
      code: callback.get("code"),
      code_verifier: pkce.codeVerifier,
    });
    expect(graph.calls[2]?.query).toMatchObject({
      grant_type: "fb_exchange_token",
      fb_exchange_token: expect.stringMatching(/^fake-user-token-short-/) as unknown,
    });
    expect(graph.calls[3]?.query).toEqual({
      input_token: tokens.accessToken,
      access_token: `${FAKE_META_APP.appId}|${FAKE_META_APP.appSecret}`,
    });

    expect(tokens).toMatchObject({
      accessToken: expect.stringMatching(/^fake-user-token-long-/) as unknown,
      refreshToken: null,
      refreshExpiresAt: null,
      scopes: [...META_OAUTH_SCOPES],
    });
    // Long-lived user tokens last about 60 days.
    expect(tokens.expiresAt!.getTime() - before).toBeGreaterThan(59 * DAY_MS);
    expect(tokens.expiresAt!.getTime() - before).toBeLessThan(61 * DAY_MS);
  });

  it("lists each Page and its linked Instagram account with the Page's token", async () => {
    const provider = providerFor();
    const tokens = await provider.exchange(
      (await consent(provider.authorizeUrl("s"))).get("code")!,
    );
    graph.calls.length = 0;

    const accounts = await provider.listAccounts(tokens);
    expect(graph.sequence()).toEqual([`GET ${V}/me/accounts`]);
    expect(graph.calls[0]?.query).toMatchObject({
      fields: "id,name,access_token,instagram_business_account{id,username}",
    });
    expect(graph.calls[0]?.headers.authorization).toBe(`OAuth ${tokens.accessToken}`);

    const pageTokens = (accessToken: string) => ({
      accessToken,
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: [...META_OAUTH_SCOPES],
    });
    expect(accounts).toEqual([
      {
        platform: "FACEBOOK",
        externalId: QAHWA.id,
        handle: QAHWA.name,
        displayName: QAHWA.name,
        tokens: pageTokens(QAHWA.accessToken),
        meta: { pageId: QAHWA.id, pageName: QAHWA.name, source: "oauth" },
      },
      {
        platform: "INSTAGRAM",
        externalId: QAHWA.instagram!.id,
        handle: "qahwa.co",
        displayName: null,
        tokens: pageTokens(QAHWA.accessToken),
        meta: {
          pageId: QAHWA.id,
          pageName: QAHWA.name,
          igUserId: QAHWA.instagram!.id,
          username: "qahwa.co",
          source: "oauth",
        },
      },
      {
        platform: "FACEBOOK",
        externalId: EVENTS.id,
        handle: EVENTS.name,
        displayName: EVENTS.name,
        tokens: pageTokens(EVENTS.accessToken),
        meta: { pageId: EVENTS.id, pageName: EVENTS.name, source: "oauth" },
      },
    ]);
  });

  it("follows /me/accounts' cursors past one page of results", async () => {
    graph.state.pages = Array.from({ length: 130 }, (_, index) => ({
      id: String(200_000_000_000_000 + index),
      name: `Page ${index}`,
      accessToken: `page-token-${index}`,
      instagram: null,
    }));
    const provider = providerFor();
    const tokens = await provider.exchange("any-code");
    graph.calls.length = 0;
    const accounts = await provider.listAccounts(tokens);
    expect(accounts).toHaveLength(130);
    expect(graph.sequence()).toEqual([`GET ${V}/me/accounts`, `GET ${V}/me/accounts`]);
    expect(graph.calls[1]?.query.after).toBeTruthy();
  });

  it("reports only the scopes the admin left ticked", async () => {
    graph.state.declinedScopes = ["instagram_content_publish"];
    const provider = providerFor();
    const tokens = await provider.exchange(
      (await consent(provider.authorizeUrl("s"))).get("code")!,
    );
    expect(tokens.scopes).not.toContain("instagram_content_publish");
    const [, instagram] = await provider.listAccounts(tokens);
    expect(missingPublishScopes("INSTAGRAM", instagram!.tokens.scopes)).toEqual([
      "instagram_content_publish",
    ]);
  });

  it("is DENIED for a declined consent's code, a used code or the wrong PKCE verifier", async () => {
    const provider = providerFor();
    const pkce = createPkcePair();
    const code = (await consent(provider.authorizeUrl("s", pkce))).get("code")!;

    expect(await oauthFailure(provider.exchange(code, createPkcePair()))).toMatchObject({
      code: "DENIED",
      status: 400,
    });
    await provider.exchange(code, pkce).catch(() => undefined);
    const reused = await oauthFailure(provider.exchange(code, pkce));
    expect(reused).toMatchObject({ code: "DENIED" });
    expect(reused.message).toContain("This authorization code has been used");

    graph.state.consent = "deny";
    const declined = await consent(provider.authorizeUrl("s"));
    expect(declined.get("error")).toBe("access_denied");
    expect(declined.get("code")).toBeNull();
  });

  it("is API_ERROR when Meta rejects the app's own credentials", async () => {
    const provider = providerFor({ ...fakeGraphEnv(graph.url), META_APP_SECRET: "wrong-secret" });
    expect(await oauthFailure(provider.exchange("any-code"))).toMatchObject({
      code: "API_ERROR",
    });
    expect(await oauthFailure(provider.debugToken(QAHWA.accessToken))).toMatchObject({
      code: "API_ERROR",
    });
  });

  it("is NOT_CONFIGURED without the Meta app, before any call", async () => {
    const provider = providerFor({ META_GRAPH_BASE_URL: graph.url, PUBLISH_MODE: "dry-run" });
    expect(() => provider.authorizeUrl("s")).toThrow(OAuthError);
    expect(await oauthFailure(provider.exchange("code"))).toMatchObject({
      code: "NOT_CONFIGURED",
    });
    expect(await oauthFailure(provider.debugToken("t"))).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(graph.calls).toEqual([]);
  });
});

describe("debug_token", () => {
  it("describes a Page token: valid, never expiring, its scopes and Page", async () => {
    await expect(providerFor().debugToken(QAHWA.accessToken)).resolves.toEqual({
      valid: true,
      expiresAt: null,
      scopes: [...META_OAUTH_SCOPES],
      subjectId: QAHWA.id,
      error: null,
    });
  });

  it("reports a revoked token as invalid with Meta's reason", async () => {
    graph.state.invalidTokens.add(QAHWA.accessToken);
    const info = await providerFor().debugToken(QAHWA.accessToken);
    expect(info).toMatchObject({ valid: false, scopes: [], subjectId: null });
    expect(info.error).toContain("Error validating access token");
  });

  it("reports an expired user token as invalid", async () => {
    graph.state.tokens.set("expired-user-token", {
      type: "USER",
      subjectId: graph.state.user.id,
      userId: graph.state.user.id,
      scopes: ["pages_show_list"],
      expiresAt: Math.floor(Date.now() / 1_000) - 60,
    });
    const info = await providerFor().debugToken("expired-user-token");
    expect(info.valid).toBe(false);
    expect(info.error).toContain("Session has expired");
  });
});
