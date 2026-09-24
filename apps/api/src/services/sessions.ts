import type { DbClient, DbTransaction } from "@enmo/db";
import type { Role } from "@enmo/shared";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { Config } from "../config";
import { DAY_MS, MINUTE_MS } from "../lib/clock";
import { randomToken, sha256 } from "../lib/tokens";

/*
 * Server-side sessions (DESIGN §E). The cookie carries 32 random bytes (base64url); the Session row
 * keeps only sha256(token), so a leaked table cannot be replayed. Sessions roll: each authenticated
 * request may push lastSeenAt and expiresAt forward, but at most once per refresh interval so a busy
 * client does not write on every call.
 */

export const SESSION_REFRESH_INTERVAL_MS = 5 * MINUTE_MS;

type Db = DbClient | DbTransaction;

export type SessionCookieConfig = Pick<
  Config,
  "COOKIE_DOMAIN" | "COOKIE_SECURE" | "SESSION_TTL_DAYS"
>;

/** Where a session was opened from; stored on the row and on audit entries. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionTiming {
  now: Date;
  ttlDays: number;
}

export function sessionExpiry({ now, ttlDays }: SessionTiming): Date {
  return new Date(now.getTime() + ttlDays * DAY_MS);
}

/** True once the last refresh is at least SESSION_REFRESH_INTERVAL_MS old. */
export function isRefreshDue(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_REFRESH_INTERVAL_MS;
}

/** `enmo_session` attributes: HttpOnly, SameSite=Lax, Path=/, Domain only when configured. */
export function sessionCookieOptions(config: SessionCookieConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
    maxAge: config.SESSION_TTL_DAYS * (DAY_MS / 1000),
  };
}

export interface CreatedSession {
  id: string;
  /** The raw cookie value; never persisted. */
  token: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db,
  userId: string,
  meta: RequestMeta,
  timing: SessionTiming,
): Promise<CreatedSession> {
  const token = randomToken();
  const expiresAt = sessionExpiry(timing);
  const { id } = await db.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
      expiresAt,
      lastSeenAt: timing.now,
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
    select: { id: true },
  });
  return { id, token, expiresAt };
}

export interface ResolvedSession {
  id: string;
  user: { id: string; email: string; name: string; role: Role };
  /** The expiry moved forward on this request, so the cookie should be re-issued. */
  refreshed: boolean;
}

export interface ResolveSessionOptions {
  /**
   * Roll the session when a refresh is due (the default). False for a caller that can't re-issue
   * the cookie (a hijacked SSE reply): rolling only the row would let the server session outlive
   * the browser's cookie, and take the refresh window from a request that could have re-issued it.
   */
  refresh?: boolean;
}

/** The live session for a cookie token, or null when unknown, expired or its user is inactive. */
export async function resolveSession(
  db: DbClient,
  token: string,
  timing: SessionTiming,
  { refresh = true }: ResolveSessionOptions = {},
): Promise<ResolvedSession | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    select: {
      id: true,
      expiresAt: true,
      lastSeenAt: true,
      user: { select: { id: true, email: true, name: true, role: true, isActive: true } },
    },
  });
  if (!session) return null;

  const { now } = timing;
  if (session.expiresAt <= now) {
    await db.session.deleteMany({ where: { id: session.id, expiresAt: { lte: now } } });
    return null;
  }
  const { isActive, ...user } = session.user;
  if (!isActive) return null;

  let refreshed = false;
  if (refresh && isRefreshDue(session.lastSeenAt, now)) {
    // Matching on the old lastSeenAt lets exactly one of several concurrent requests refresh.
    const { count } = await db.session.updateMany({
      where: { id: session.id, lastSeenAt: session.lastSeenAt },
      data: { lastSeenAt: now, expiresAt: sessionExpiry(timing) },
    });
    refreshed = count === 1;
  }
  return { id: session.id, user, refreshed };
}

/** Deletes the session a cookie token belongs to; returns its user id when one existed. */
export async function deleteSessionByToken(
  db: Db,
  token: string,
): Promise<{ id: string; userId: string } | null> {
  const tokenHash = sha256(token);
  const session = await db.session.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true },
  });
  if (!session) return null;
  const { count } = await db.session.deleteMany({ where: { id: session.id } });
  return count === 1 ? session : null;
}

/** Signs a user out everywhere (optionally keeping one session); returns how many were removed. */
export async function deleteUserSessions(
  db: Db,
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const { count } = await db.session.deleteMany({
    where: {
      userId,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
  });
  return count;
}
