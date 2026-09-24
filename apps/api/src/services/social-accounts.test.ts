import { describe, expect, it } from "vitest";
import { statusFromExpiry } from "./social-accounts";

const now = new Date("2026-09-24T12:00:00Z");
const before = new Date(now.getTime() - 1);
const after = new Date(now.getTime() + 1);

describe("statusFromExpiry", () => {
  it.each([
    [
      "no expiry",
      { tokenExpiresAt: null, refreshExpiresAt: null, hasRefreshToken: false },
      "ACTIVE",
    ],
    [
      "an unexpired token",
      { tokenExpiresAt: after, refreshExpiresAt: null, hasRefreshToken: false },
      "ACTIVE",
    ],
    [
      "a token expiring right now",
      { tokenExpiresAt: now, refreshExpiresAt: null, hasRefreshToken: false },
      "EXPIRED",
    ],
    [
      "an expired token",
      { tokenExpiresAt: before, refreshExpiresAt: null, hasRefreshToken: false },
      "EXPIRED",
    ],
    [
      "an expired token with a live refresh token",
      { tokenExpiresAt: before, refreshExpiresAt: after, hasRefreshToken: true },
      "ACTIVE",
    ],
    [
      "an expired token with a non-expiring refresh token",
      { tokenExpiresAt: before, refreshExpiresAt: null, hasRefreshToken: true },
      "ACTIVE",
    ],
    [
      "an expired token and an expired refresh token",
      { tokenExpiresAt: before, refreshExpiresAt: before, hasRefreshToken: true },
      "EXPIRED",
    ],
    [
      "a refresh expiry but no refresh token",
      { tokenExpiresAt: before, refreshExpiresAt: after, hasRefreshToken: false },
      "EXPIRED",
    ],
  ] as const)("treats %s as %s", (_label, expiry, status) => {
    expect(statusFromExpiry(expiry, now)).toBe(status);
  });
});
