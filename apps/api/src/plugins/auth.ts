import { SESSION_COOKIE_NAME, type Role } from "@enmo/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { unauthenticated } from "../lib/errors";
import {
  resolveSession,
  sessionCookieOptions,
  type RequestMeta,
  type ResolveSessionOptions,
} from "../services/sessions";

/*
 * Session authentication (DESIGN §E). The exported names and the `request.user` shape are the
 * contract other units build on.
 *
 * Cookie `enmo_session` holds a random token; the Session row stores sha256(token) as tokenHash.
 * Sessions roll: when services/sessions.ts extends a session (at most every 5 minutes) the cookie
 * is re-issued with a fresh Max-Age in onSend, so browser and server expiry move together.
 */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `authenticate` (and therefore by `requireCap`); null on public routes. */
    user: AuthUser | null;
  }
}

/** Requests whose session was just extended, mapped to the token to re-issue. */
const cookieRefreshes = new WeakMap<FastifyRequest, string>();

/** The raw session cookie, if the browser sent one. */
export function sessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE_NAME] || undefined;
}

/** Where the request came from, for Session rows and audit entries. */
export function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers["user-agent"];
  return { ip: request.clientIp || null, userAgent: userAgent ? userAgent.slice(0, 512) : null };
}

/**
 * Resolves the session cookie to an active user, or null. Does not throw. With `refresh: false`
 * the session is only checked, never rolled (see ResolveSessionOptions).
 */
export async function resolveSessionUser(
  request: FastifyRequest,
  options: ResolveSessionOptions = {},
): Promise<AuthUser | null> {
  const token = sessionToken(request);
  if (!token) return null;

  const { prisma, clock, config } = request.server.deps;
  const session = await resolveSession(
    prisma,
    token,
    { now: clock.now(), ttlDays: config.SESSION_TTL_DAYS },
    options,
  );
  if (!session) return null;
  if (session.refreshed) cookieRefreshes.set(request, token);
  return { ...session.user, sessionId: session.id };
}

/** onRequest guard: 401 unless the request carries a valid session. */
export async function authenticate(request: FastifyRequest): Promise<void> {
  request.user ??= await resolveSessionUser(request);
  if (!request.user) throw unauthenticated();
}

/**
 * `authenticate` for a route that hijacks its reply (the SSE stream): onSend never runs there, so
 * a rolled session's cookie could never be re-issued. The session is checked without rolling it;
 * the app's ordinary requests roll it, cookie included.
 */
export async function authenticateWithoutRefresh(request: FastifyRequest): Promise<void> {
  request.user ??= await resolveSessionUser(request, { refresh: false });
  if (!request.user) throw unauthenticated();
}

/** The signed-in user inside a handler guarded by `authenticate` / `requireCap`. */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw unauthenticated();
  return request.user;
}

/** Sets `enmo_session` (login, invite accept) with the configured attributes. */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  cookieRefreshes.delete(reply.request);
  reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(reply.server.deps.config));
}

/** Expires `enmo_session` in the browser (logout). Domain and Path must match the original. */
export function clearSessionCookie(reply: FastifyReply): void {
  cookieRefreshes.delete(reply.request);
  const { maxAge: _maxAge, ...options } = sessionCookieOptions(reply.server.deps.config);
  reply.clearCookie(SESSION_COOKIE_NAME, options);
}

export const authPlugin = fp(
  (app: FastifyInstance, _options, done) => {
    app.decorateRequest("user", null);
    app.addHook("onSend", (request, reply, payload, next) => {
      const token = cookieRefreshes.get(request);
      if (token !== undefined) setSessionCookie(reply, token);
      next(null, payload);
    });
    done();
  },
  { name: "enmo-auth", fastify: "5.x", dependencies: ["@fastify/cookie"] },
);
