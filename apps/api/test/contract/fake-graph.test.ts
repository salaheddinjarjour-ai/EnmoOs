import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import {
  FAKE_META_APP,
  FAKE_META_PAGES,
  GRAPH_ERRORS,
  fakeGraphEnv,
  startFakeGraph,
  type FakeGraph,
} from "../fakes/meta-graph";

/*
 * The fake Graph server's own plumbing and scripting: what every contract test relies on (call
 * recording, scripted failures, Graph's error shape, token and appsecret_proof checks, the knobs
 * that script containers and consent, the env that aims the API at it). The real providers run
 * against it in meta-publisher.test.ts and meta-oauth.test.ts.
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

const PAGE = FAKE_META_PAGES[0]!;
const IG_USER = PAGE.instagram!.id;

function proof(token: string): string {
  return createHmac("sha256", FAKE_META_APP.appSecret).update(token).digest("hex");
}

/** A Graph call with a Page token, as the providers make them. */
function graphFetch(
  path: string,
  init: { method?: string; json?: Record<string, unknown>; token?: string } = {},
) {
  const token = init.token ?? PAGE.accessToken;
  const url = new URL(`${graph.url}${path}`);
  url.searchParams.set("appsecret_proof", proof(token));
  return fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `OAuth ${token}`,
      ...(init.json ? { "content-type": "application/json" } : {}),
    },
    ...(init.json ? { body: JSON.stringify(init.json) } : {}),
  });
}

describe("the fake Graph server", () => {
  it("records every call with its query, form body and headers", async () => {
    await fetch(`${graph.url}/v26.0/123/media?fields=id`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: "OAuth t" },
      body: new URLSearchParams({ image_url: "https://assets.enmo.test/a.png", caption: "Hi" }),
    });
    await fetch(`${graph.url}/v26.0/me/accounts`);

    expect(graph.sequence()).toEqual(["POST /v26.0/123/media", "GET /v26.0/me/accounts"]);
    expect(graph.calls[0]).toMatchObject({
      query: { fields: "id" },
      body: { image_url: "https://assets.enmo.test/a.png", caption: "Hi" },
      headers: { authorization: "OAuth t" },
    });
    expect(graph.calls[1]?.body).toBeNull();
  });

  it("answers an unknown endpoint with a Graph error instead of hanging", async () => {
    const response = await fetch(`${graph.url}/v26.0/123/edges/nowhere`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "GraphMethodException", code: 100 },
    });
  });

  it("fails the scripted number of matching calls, then lets them through", async () => {
    graph.failNext({
      match: /^POST \/v26\.0\/\d+\/media_publish$/,
      status: 400,
      error: { message: "Rate limited", type: "OAuthException", code: 4 },
      times: 2,
    });
    const publish = () => fetch(`${graph.url}/v26.0/123/media_publish`, { method: "POST" });

    const first = await publish();
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({
      error: { message: "Rate limited", type: "OAuthException", code: 4 },
    });
    expect((await publish()).status).toBe(400);
    // The script is used up; the endpoint answers as Graph would (this call carries no token).
    expect(await (await publish()).json()).toMatchObject({ error: { code: 104 } });
    expect(graph.state.failures).toEqual([]);
    expect(graph.calls).toHaveLength(3);
  });

  it("aims every Meta host at itself and configures the fake Meta app", () => {
    const config = loadConfig({ NODE_ENV: "test", ...fakeGraphEnv(graph.url) });
    expect(config).toMatchObject({
      META_APP_ID: FAKE_META_APP.appId,
      META_APP_SECRET: FAKE_META_APP.appSecret,
      META_GRAPH_BASE_URL: graph.url,
      META_RUPLOAD_BASE_URL: graph.url,
      META_OAUTH_DIALOG_URL: graph.url,
    });
  });
});

describe("the fake's tokens", () => {
  it("takes any token it never issued, unless a test revoked it", async () => {
    expect((await graphFetch(`/v26.0/${PAGE.id}`, { token: "seeded-by-a-test" })).status).toBe(200);

    graph.state.invalidTokens.add("seeded-by-a-test");
    const revoked = await graphFetch(`/v26.0/${PAGE.id}`, { token: "seeded-by-a-test" });
    expect(await revoked.json()).toEqual({ error: GRAPH_ERRORS.invalidToken });

    graph.state.acceptUnknownTokens = false;
    const unknown = await graphFetch(`/v26.0/${PAGE.id}`, { token: "never-issued" });
    expect(await unknown.json()).toMatchObject({ error: { code: 190 } });
  });

  it("needs a matching appsecret_proof on token calls, as Require App Secret does", async () => {
    const missing = await fetch(`${graph.url}/v26.0/${PAGE.id}`, {
      headers: { authorization: `OAuth ${PAGE.accessToken}` },
    });
    expect(await missing.json()).toMatchObject({
      error: { code: 100, message: expect.stringContaining("appsecret_proof") as unknown },
    });
    const wrong = await fetch(`${graph.url}/v26.0/${PAGE.id}?appsecret_proof=00`, {
      headers: { authorization: `OAuth ${PAGE.accessToken}` },
    });
    expect(await wrong.json()).toMatchObject({ error: { code: 100 } });
    expect(await (await graphFetch(`/v26.0/${PAGE.id}`)).json()).toEqual({
      id: PAGE.id,
      name: PAGE.name,
    });
  });

  it("refuses publishing without the scope the admin declined", async () => {
    graph.state.tokens.set("no-publish", {
      type: "PAGE",
      subjectId: PAGE.id,
      userId: graph.state.user.id,
      scopes: ["instagram_basic"],
      expiresAt: 0,
    });
    const response = await graphFetch(`/v26.0/${IG_USER}/media`, {
      method: "POST",
      token: "no-publish",
      json: { image_url: "https://assets.enmo.marketing/a.png" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 200 } });
  });
});

describe("the fake's scripts", () => {
  it("keeps a container IN_PROGRESS for containerPolls reads, then answers its outcome", async () => {
    graph.state.containerPolls = 2;
    graph.state.containerOutcome = "ERROR";
    const created = await graphFetch(`/v26.0/${IG_USER}/media`, {
      method: "POST",
      json: { image_url: "https://assets.enmo.marketing/a.png" },
    });
    const { id } = (await created.json()) as { id: string };

    const read = async () =>
      (
        (await (await graphFetch(`/v26.0/${id}?fields=status_code`)).json()) as {
          status_code: string;
        }
      ).status_code;
    expect([await read(), await read(), await read(), await read()]).toEqual([
      "IN_PROGRESS",
      "IN_PROGRESS",
      "ERROR",
      "ERROR",
    ]);
  });

  it("refuses media_publish once the quota is used up", async () => {
    graph.state.quotaUsage = 100;
    const created = await graphFetch(`/v26.0/${IG_USER}/media`, {
      method: "POST",
      json: { image_url: "https://assets.enmo.marketing/a.png" },
    });
    const { id } = (await created.json()) as { id: string };
    const limit = await graphFetch(`/v26.0/${IG_USER}/content_publishing_limit`);
    expect(await limit.json()).toEqual({
      data: [{ quota_usage: 100, config: { quota_total: 100, quota_duration: 86_400 } }],
    });
    const publish = await graphFetch(`/v26.0/${IG_USER}/media_publish`, {
      method: "POST",
      json: { creation_id: id },
    });
    expect(await publish.json()).toEqual({ error: GRAPH_ERRORS.publishLimitReached });
  });

  it("bounces the consent dialog straight back with a code, or a refusal", async () => {
    const dialog = (state: string) =>
      fetch(
        `${graph.url}/v26.0/dialog/oauth?${new URLSearchParams({
          client_id: FAKE_META_APP.appId,
          redirect_uri: "http://api.enmo.test/v1/oauth/meta/callback",
          state,
          scope: "pages_show_list,pages_manage_posts",
        }).toString()}`,
        { redirect: "manual" },
      );

    const granted = new URL((await dialog("s1")).headers.get("location")!);
    expect(granted.origin + granted.pathname).toBe("http://api.enmo.test/v1/oauth/meta/callback");
    expect(granted.searchParams.get("state")).toBe("s1");
    const code = granted.searchParams.get("code")!;
    expect(graph.state.codes.get(code)).toMatchObject({
      scopes: ["pages_show_list", "pages_manage_posts"],
      used: false,
    });

    graph.state.consent = "deny";
    const denied = new URL((await dialog("s2")).headers.get("location")!);
    expect(Object.fromEntries(denied.searchParams)).toEqual({
      error: "access_denied",
      error_code: "200",
      error_description: "Permissions error",
      error_reason: "user_denied",
      state: "s2",
    });
  });
});
