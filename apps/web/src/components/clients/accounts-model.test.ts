import type { SocialAccountDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  accountNames,
  accountSource,
  oauthNotice,
  oauthResultFrom,
  scopeCheck,
  tokenExpiry,
  withoutOAuthResult,
} from "./accounts-model";

const AT = "2026-09-25T10:00:00.000Z";
const NOW = Date.parse(AT);

function account(overrides: Partial<SocialAccountDto> = {}): SocialAccountDto {
  return {
    id: "account-1",
    clientId: "client-1",
    platform: "INSTAGRAM",
    externalId: "17841400000000001",
    handle: "qahwaco",
    displayName: null,
    status: "ACTIVE",
    scopes: ["instagram_basic", "instagram_content_publish", "pages_read_engagement"],
    meta: {
      igUserId: "17841400000000001",
      username: "qahwaco",
      pageId: "1029",
      pageName: "Qahwa Co",
      source: "oauth",
    },
    tokenExpiresAt: null,
    refreshExpiresAt: null,
    lastCheckedAt: null,
    connectedById: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("accountNames", () => {
  it("names an Instagram account by @username and the Page it publishes through", () => {
    expect(accountNames(account())).toEqual({
      primary: "@qahwaco",
      secondary: "Instagram · via Qahwa Co",
    });
  });

  it("names a Page by its name, and falls back to the handle for a pasted token", () => {
    expect(
      accountNames(
        account({ platform: "FACEBOOK", externalId: "1029", meta: { pageName: "Qahwa Co" } }),
      ),
    ).toEqual({ primary: "Qahwa Co", secondary: "Facebook Page · 1029" });
    expect(
      accountNames(account({ platform: "FACEBOOK", externalId: "1029", meta: { pageId: "1029" } })),
    ).toEqual({ primary: "@qahwaco", secondary: "Facebook Page · 1029" });
    expect(accountNames(account({ meta: {} })).secondary).toBe("Instagram · 17841400000000001");
  });

  it("says how the account was connected", () => {
    expect(accountSource(account())).toBe("OAuth");
    expect(accountSource(account({ meta: { source: "manual" } }))).toBe("Manual");
    expect(accountSource(account({ meta: {} }))).toBeNull();
  });
});

describe("scopeCheck", () => {
  it("passes a token that can publish", () => {
    expect(scopeCheck(account())).toEqual({ kind: "ok" });
  });

  it("lists the publishing scopes a token lacks", () => {
    expect(scopeCheck(account({ scopes: ["instagram_basic"] }))).toEqual({
      kind: "missing",
      scopes: ["instagram_content_publish", "pages_read_engagement"],
    });
  });

  it("doesn't guess when no scopes were recorded", () => {
    expect(scopeCheck(account({ scopes: [] }))).toEqual({ kind: "unknown" });
  });
});

describe("tokenExpiry", () => {
  it("tells long-lived, expiring and expired tokens apart", () => {
    expect(tokenExpiry(account(), NOW)).toEqual({ kind: "never" });
    expect(tokenExpiry(account({ tokenExpiresAt: "2026-11-24T10:00:00.000Z" }), NOW).kind).toBe(
      "valid",
    );
    expect(tokenExpiry(account({ tokenExpiresAt: "2026-09-30T10:00:00.000Z" }), NOW).kind).toBe(
      "soon",
    );
    expect(tokenExpiry(account({ tokenExpiresAt: "2026-09-25T09:00:00.000Z" }), NOW).kind).toBe(
      "expired",
    );
  });
});

describe("the OAuth result", () => {
  it("reads a connected result", () => {
    const params = new URLSearchParams("tab=accounts&oauth=meta&outcome=connected&connected=2");
    const result = oauthResultFrom(params);
    expect(result).toEqual({ oauth: "meta", outcome: "connected", connected: 2 });
    expect(oauthNotice(result!)).toMatchObject({
      tone: "success",
      title: "2 Meta accounts connected",
    });
    expect(oauthNotice({ oauth: "meta", outcome: "connected", connected: 1 }).title).toBe(
      "1 Meta account connected",
    );
  });

  it("reads an error with its message", () => {
    const params = new URLSearchParams({
      oauth: "meta",
      outcome: "error",
      message: "The Meta sign-in was cancelled, so nothing was connected.",
    });
    expect(oauthNotice(oauthResultFrom(params)!)).toEqual({
      tone: "error",
      title: "Couldn't connect Meta",
      description: "The Meta sign-in was cancelled, so nothing was connected.",
    });
  });

  it("clips an over-long message instead of losing the result", () => {
    const params = new URLSearchParams({
      oauth: "meta",
      outcome: "error",
      message: "x".repeat(900),
    });
    expect(oauthResultFrom(params)?.message).toHaveLength(500);
  });

  it("ignores an address without a result, or a malformed one", () => {
    expect(oauthResultFrom(new URLSearchParams("tab=accounts"))).toBeNull();
    expect(oauthResultFrom(new URLSearchParams("oauth=myspace&outcome=connected"))).toBeNull();
    expect(oauthResultFrom(new URLSearchParams("oauth=meta&outcome=maybe"))).toBeNull();
  });

  it("takes the result out of the address and keeps the rest", () => {
    expect(withoutOAuthResult("tab=accounts&oauth=meta&outcome=connected&connected=2")).toBe(
      "?tab=accounts",
    );
    expect(withoutOAuthResult("oauth=meta&outcome=error&message=Nope")).toBe("");
  });
});
