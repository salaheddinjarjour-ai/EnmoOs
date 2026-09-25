import { describe, expect, it } from "vitest";
import { createTokenCipher } from "../lib/crypto";
import { decryptAccount, evaluateGuards, type GuardSnapshot, type TokenState } from "./guards";

/* The publish guard's decision (DESIGN §F "Publishing safety"), one refusal at a time. */

const NOW = new Date("2027-03-02T09:00:00Z");

function snapshot(overrides: Partial<GuardSnapshot> = {}): GuardSnapshot {
  return {
    platform: "INSTAGRAM",
    archived: null,
    latestRound: { status: "APPROVED", contentHash: "hash-1" },
    currentHash: "hash-1",
    bannedHits: [],
    token: null,
    now: NOW,
    ...overrides,
  };
}

function account(overrides: Partial<Extract<TokenState, { kind: "account" }>> = {}): TokenState {
  return {
    kind: "account",
    platform: "INSTAGRAM",
    status: "ACTIVE",
    tokenExpiresAt: null,
    scopes: [],
    decrypts: true,
    ...overrides,
  };
}

describe("evaluateGuards", () => {
  it("lets an approved, unchanged, clean dry run through", () => {
    expect(evaluateGuards(snapshot())).toBeNull();
  });

  it("refuses unless the latest round is APPROVED", () => {
    expect(evaluateGuards(snapshot({ latestRound: null }))).toMatchObject({
      guard: "approval",
      message: "The post has no approval round",
    });
    expect(
      evaluateGuards(snapshot({ latestRound: { status: "PENDING", contentHash: "hash-1" } })),
    ).toMatchObject({
      guard: "approval",
      message: "The post's latest approval round is pending, not approved",
    });
  });

  it("refuses content that changed after approval", () => {
    expect(evaluateGuards(snapshot({ currentHash: "hash-2" }))).toMatchObject({
      guard: "contentHash",
    });
  });

  it("refuses banned words, naming each term once", () => {
    const hit = { term: "cheap", index: 0, length: 5, match: "Cheap", path: "variant.caption" };
    const failure = evaluateGuards(
      snapshot({ bannedHits: [hit, { ...hit, path: "copy.caption" }] }),
    );
    expect(failure).toEqual({
      guard: "bannedWords",
      message: `The post uses the client's banned words: "cheap"`,
      accountStatus: null,
      bannedHits: [hit, { ...hit, path: "copy.caption" }],
    });
  });

  it("refuses archived work before anything else", () => {
    const everythingWrong = snapshot({
      latestRound: { status: "CANCELLED", contentHash: "hash-1" },
      token: { kind: "missing" },
    });
    expect(evaluateGuards({ ...everythingWrong, archived: "campaign" })).toEqual({
      guard: "archived",
      message: "The post's campaign is archived",
      accountStatus: null,
    });
    expect(evaluateGuards(snapshot({ archived: "client" }))).toMatchObject({
      guard: "archived",
      message: "The client is archived",
    });
  });

  it("checks the approval before the content, and the content before the token", () => {
    const everythingWrong = snapshot({
      latestRound: { status: "CANCELLED", contentHash: "hash-1" },
      currentHash: "hash-2",
      token: { kind: "missing" },
    });
    expect(evaluateGuards(everythingWrong)?.guard).toBe("approval");
    expect(
      evaluateGuards(snapshot({ currentHash: "hash-2", token: { kind: "missing" } }))?.guard,
    ).toBe("contentHash");
  });

  describe("a live job's token", () => {
    it("needs an account", () => {
      expect(evaluateGuards(snapshot({ token: { kind: "missing" } }))).toMatchObject({
        guard: "token",
        message: "No Instagram account is connected to publish through",
        accountStatus: null,
      });
    });

    it("needs it ACTIVE, decryptable, unexpired and on the right platform", () => {
      expect(evaluateGuards(snapshot({ token: account({ status: "REVOKED" }) }))).toMatchObject({
        guard: "token",
        accountStatus: null,
      });
      expect(evaluateGuards(snapshot({ token: account({ decrypts: false }) }))).toMatchObject({
        guard: "token",
        accountStatus: "ERROR",
      });
      expect(
        evaluateGuards(snapshot({ token: account({ tokenExpiresAt: new Date(NOW.getTime()) }) })),
      ).toMatchObject({ guard: "token", accountStatus: "EXPIRED" });
      expect(evaluateGuards(snapshot({ token: account({ platform: "FACEBOOK" }) }))).toMatchObject({
        guard: "token",
      });
    });

    it("needs the publishing scopes when the platform reported any", () => {
      const failure = evaluateGuards(
        snapshot({ token: account({ scopes: ["instagram_basic", "pages_read_engagement"] }) }),
      );
      expect(failure?.message).toContain("instagram_content_publish");
      const full = ["instagram_basic", "instagram_content_publish", "pages_read_engagement"];
      expect(evaluateGuards(snapshot({ token: account({ scopes: full }) }))).toBeNull();
      // A pasted token never reported its scopes: not held against it.
      expect(evaluateGuards(snapshot({ token: account({ scopes: [] }) }))).toBeNull();
    });
  });
});

describe("decryptAccount", () => {
  const cipher = createTokenCipher(new Uint8Array(32).fill(7));
  const row = {
    id: "acct_1",
    platform: "INSTAGRAM" as const,
    externalId: "17841400000000001",
    handle: "qahwa.co",
    meta: { pageId: "100000000000001", igUserId: "17841400000000001", extra: 1 },
    accessTokenEnc: cipher.encrypt("page-token"),
  };

  it("decrypts the token and keeps the account's platform ids", () => {
    expect(decryptAccount(row, cipher)).toEqual({
      id: "acct_1",
      platform: "INSTAGRAM",
      externalId: "17841400000000001",
      handle: "qahwa.co",
      accessToken: "page-token",
      meta: { pageId: "100000000000001", igUserId: "17841400000000001", extra: 1 },
    });
  });

  it("is null for a token another key encrypted", () => {
    const other = createTokenCipher(new Uint8Array(32).fill(9));
    expect(decryptAccount({ ...row, accessTokenEnc: other.encrypt("x") }, cipher)).toBeNull();
  });
});
