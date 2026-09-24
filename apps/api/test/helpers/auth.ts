import { SESSION_COOKIE_NAME } from "@enmo/shared";
import { DAY_MS } from "../../src/lib/clock";
import { randomToken, sha256 } from "../../src/lib/tokens";
import type { ApiApp } from "../../src/types";
import { browserHeaders } from "./app";
import { testDb } from "./db";

/** A `Cookie` header value, e.g. "enmo_session=…", for app.inject({ headers: { cookie } }). */
export type CookieHeader = string;

/**
 * Signs `user` in through POST /v1/auth/login (exercises the real login path) and returns the
 * session cookie. Use sessionCookieFor() when a test is not about logging in.
 */
export async function loginAs(
  app: ApiApp,
  user: { email: string; password: string },
): Promise<CookieHeader> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: browserHeaders(),
    payload: { email: user.email, password: user.password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`loginAs(${user.email}) failed: ${response.statusCode} ${response.body}`);
  }
  const cookie = response.cookies.find(({ name }) => name === SESSION_COOKIE_NAME);
  if (!cookie) throw new Error(`loginAs(${user.email}): no ${SESSION_COOKIE_NAME} cookie was set`);
  return `${cookie.name}=${cookie.value}`;
}

export interface SessionCookieOptions {
  /** Defaults to the real current time; pass the TestApp clock's now() after advancing it. */
  now?: Date;
  ttlDays?: number;
}

/** Inserts a Session row directly (sha256 token hash, as the auth plugin expects). */
export async function sessionCookieFor(
  user: { id: string },
  options: SessionCookieOptions = {},
): Promise<CookieHeader> {
  const token = randomToken();
  const now = options.now ?? new Date();
  await testDb().session.create({
    data: {
      tokenHash: sha256(token),
      userId: user.id,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + (options.ttlDays ?? 30) * DAY_MS),
    },
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}
