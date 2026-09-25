import { describe, expect, it } from "vitest";
import {
  META_DIALOG_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_VERSION,
  META_RUPLOAD_DEFAULT_BASE_URL,
  OAuthError,
  createMetaOAuthProvider,
  type MetaOAuthConfig,
} from "../src";

/*
 * MetaOAuthProvider on the real Meta hosts through an injected fetch: the branches the fake Graph
 * server doesn't reach. The full connect flow runs against it in apps/api/test/contract.
 */

const config: MetaOAuthConfig = {
  appId: "app-id",
  appSecret: "app-secret",
  graphVersion: META_GRAPH_DEFAULT_VERSION,
  graphBaseUrl: META_GRAPH_DEFAULT_BASE_URL,
  ruploadBaseUrl: META_RUPLOAD_DEFAULT_BASE_URL,
  dialogBaseUrl: META_DIALOG_DEFAULT_BASE_URL,
  redirectUri: "https://api.enmo.marketing/v1/oauth/meta/callback",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function providerAnswering(...responses: Response[]) {
  const urls: URL[] = [];
  const fetch = (input: string | URL | Request) => {
    urls.push(new URL(input instanceof Request ? input.url : input));
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error("no scripted response left"));
  };
  return { urls, provider: createMetaOAuthProvider(config, { fetch }) };
}

describe("MetaOAuthProvider", () => {
  it("sends the admin to www.facebook.com's dialog, not the Graph host", () => {
    const { provider } = providerAnswering();
    const url = new URL(provider.authorizeUrl("s"));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("maps a used code to DENIED with Meta's words", async () => {
    const { provider } = providerAnswering(
      json(
        {
          error: {
            message: "This authorization code has been used.",
            type: "OAuthException",
            code: 100,
            error_subcode: 36009,
          },
        },
        400,
      ),
    );
    const error = await provider.exchange("code").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error).toMatchObject({ code: "DENIED", status: 400 });
    expect((error as OAuthError).message).toContain("This authorization code has been used.");
    expect((error as OAuthError).message).not.toContain("app-secret");
  });

  it("is API_ERROR when Meta answers something it can't read", async () => {
    const { provider } = providerAnswering(json({ token: "no access_token field" }));
    await expect(provider.exchange("code")).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("treats a token issued to another app as invalid", async () => {
    const { provider, urls } = providerAnswering(
      json({ data: { app_id: "someone-else", is_valid: true, scopes: ["pages_show_list"] } }),
    );
    await expect(provider.debugToken("t")).resolves.toMatchObject({
      valid: false,
      error: "The token belongs to another Meta app",
    });
    expect(urls[0]?.searchParams.get("access_token")).toBe("app-id|app-secret");
  });

  it("skips a Page it returned no token for, since nothing can publish there", async () => {
    const { provider } = providerAnswering(
      json({
        data: [
          { id: "1", name: "Managed", access_token: "page-token" },
          { id: "2", name: "Analyst only" },
        ],
      }),
    );
    const accounts = await provider.listAccounts({
      accessToken: "user-token",
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: ["pages_show_list"],
    });
    expect(accounts.map((account) => [account.platform, account.externalId])).toEqual([
      ["FACEBOOK", "1"],
    ]);
  });
});
