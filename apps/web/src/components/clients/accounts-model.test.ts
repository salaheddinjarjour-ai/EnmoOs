import type { OAuthSelectionAccount, SocialAccountDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  accountNames,
  accountSource,
  canBecomePrimary,
  initialPicks,
  oauthNotice,
  oauthResultFrom,
  pendingSelection,
  scopeCheck,
  selectionBlock,
  selectionDetail,
  selectionName,
  tokenExpiry,
  unchosenPlatforms,
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
    isPrimary: true,
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

describe("the publishing account", () => {
  it("names the platforms where several accounts wait for an admin's choice", () => {
    const page = (id: string, isPrimary: boolean) =>
      account({ id, platform: "FACEBOOK", externalId: id, isPrimary });
    expect(unchosenPlatforms([account(), page("p1", false)])).toEqual([]);
    expect(unchosenPlatforms([account(), page("p1", false), page("p2", false)])).toEqual([
      "FACEBOOK",
    ]);
    expect(unchosenPlatforms([page("p1", true), page("p2", false)])).toEqual([]);
  });

  it("offers the switch on an active account that doesn't publish yet", () => {
    expect(canBecomePrimary(account())).toBe(false);
    expect(canBecomePrimary(account({ isPrimary: false }))).toBe(true);
    expect(canBecomePrimary(account({ isPrimary: false, status: "EXPIRED" }))).toBe(false);
  });
});

describe("a Meta sign-in's pick list", () => {
  function listed(overrides: Partial<OAuthSelectionAccount> = {}): OAuthSelectionAccount {
    return {
      key: "FACEBOOK:1029",
      platform: "FACEBOOK",
      externalId: "1029",
      handle: "Qahwa Co",
      displayName: "Qahwa Co",
      meta: { pageId: "1029", pageName: "Qahwa Co", source: "oauth" },
      status: "available",
      takenBy: null,
      ...overrides,
    };
  }
  const instagram = listed({
    key: "INSTAGRAM:1784",
    platform: "INSTAGRAM",
    externalId: "1784",
    handle: "qahwa.co",
    meta: { pageId: "1029", pageName: "Qahwa Co", igUserId: "1784", username: "qahwa.co" },
  });
  const events = listed({
    key: "FACEBOOK:2040",
    externalId: "2040",
    handle: "Qahwa Events",
    meta: { pageId: "2040", pageName: "Qahwa Events" },
  });

  it("names each account and says why a taken one can't be picked", () => {
    expect([selectionName(listed()), selectionDetail(listed())]).toEqual([
      "Qahwa Co",
      "Facebook Page · 1029",
    ]);
    expect([selectionName(instagram), selectionDetail(instagram)]).toEqual([
      "@qahwa.co",
      "Instagram · via Qahwa Co",
    ]);
    expect(selectionBlock(listed())).toBeNull();
    expect(
      selectionBlock(
        listed({ status: "taken", takenBy: { clientId: "c2", clientName: "Other Co" } }),
      ),
    ).toBe("Already connected to Other Co. Disconnect it there first.");
  });

  it("ticks a lone free Page with its Instagram account, and nothing among several", () => {
    expect(initialPicks([listed(), instagram])).toEqual(["FACEBOOK:1029", "INSTAGRAM:1784"]);
    expect(initialPicks([listed(), instagram, events])).toEqual([]);
    // What is already this client's is ticked, to refresh its token; nothing else is guessed.
    expect(initialPicks([listed({ status: "connected" }), instagram, events])).toEqual([
      "FACEBOOK:1029",
    ]);
    const taken = { status: "taken" as const, takenBy: { clientId: "c2", clientName: "Other Co" } };
    expect(initialPicks([listed(taken), events])).toEqual(["FACEBOOK:2040"]);
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
    const pick = "p".repeat(43);
    const choose = oauthResultFrom(
      new URLSearchParams(`tab=accounts&oauth=meta&outcome=choose&pick=${pick}`),
    );
    expect(choose).toEqual({ oauth: "meta", outcome: "choose", pick });
    expect(pendingSelection(choose)).toBe(pick);
    expect(pendingSelection({ oauth: "meta", outcome: "connected" })).toBeNull();
    expect(oauthResultFrom(new URLSearchParams("oauth=myspace&outcome=connected"))).toBeNull();
    expect(oauthResultFrom(new URLSearchParams("oauth=meta&outcome=maybe"))).toBeNull();
  });

  it("takes the result out of the address and keeps the rest", () => {
    expect(withoutOAuthResult("tab=accounts&oauth=meta&outcome=connected&connected=2")).toBe(
      "?tab=accounts",
    );
    expect(withoutOAuthResult("oauth=meta&outcome=error&message=Nope")).toBe("");
    expect(withoutOAuthResult("tab=accounts&oauth=meta&outcome=choose&pick=abc")).toBe(
      "?tab=accounts",
    );
  });
});
