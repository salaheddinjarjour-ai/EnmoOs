import { describe, expect, it } from "vitest";
import { DAY_MS, MINUTE_MS } from "../lib/clock";
import {
  SESSION_REFRESH_INTERVAL_MS,
  isRefreshDue,
  sessionCookieOptions,
  sessionExpiry,
} from "./sessions";

describe("sessionCookieOptions", () => {
  it("is HttpOnly, SameSite=Lax, Path=/ and lives SESSION_TTL_DAYS", () => {
    expect(
      sessionCookieOptions({
        COOKIE_DOMAIN: undefined,
        COOKIE_SECURE: false,
        SESSION_TTL_DAYS: 30,
      }),
    ).toEqual({ httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 30 * 86_400 });
  });

  it("adds Domain and Secure only when configured", () => {
    expect(
      sessionCookieOptions({
        COOKIE_DOMAIN: ".enmo.marketing",
        COOKIE_SECURE: true,
        SESSION_TTL_DAYS: 7,
      }),
    ).toMatchObject({ domain: ".enmo.marketing", secure: true, maxAge: 7 * 86_400 });
    expect(
      sessionCookieOptions({ COOKIE_DOMAIN: undefined, COOKIE_SECURE: true, SESSION_TTL_DAYS: 1 }),
    ).not.toHaveProperty("domain");
  });
});

describe("rolling expiry", () => {
  const start = new Date("2026-03-01T10:00:00.000Z");

  it("expires ttlDays after the given instant", () => {
    expect(sessionExpiry({ now: start, ttlDays: 30 }).getTime()).toBe(
      start.getTime() + 30 * DAY_MS,
    );
  });

  it("refreshes at most once per interval", () => {
    expect(SESSION_REFRESH_INTERVAL_MS).toBe(5 * MINUTE_MS);
    const at = (ms: number) => new Date(start.getTime() + ms);
    expect(isRefreshDue(start, start)).toBe(false);
    expect(isRefreshDue(start, at(5 * MINUTE_MS - 1))).toBe(false);
    expect(isRefreshDue(start, at(5 * MINUTE_MS))).toBe(true);
    expect(isRefreshDue(start, at(DAY_MS))).toBe(true);
  });
});
