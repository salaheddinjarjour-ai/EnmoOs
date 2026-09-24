import { ChangePasswordRequest, LoginRequest, SessionResponse } from "@enmo/shared";
import type { FastifyRequest } from "fastify";
import { MINUTE_MS } from "../lib/clock";
import {
  authenticate,
  clearSessionCookie,
  currentUser,
  requestMeta,
  sessionToken,
  setSessionCookie,
} from "../plugins/auth";
import { rateLimitGuard } from "../plugins/security";
import { changePassword, currentSession, login, logout } from "../services/auth";
import type { RouteModule } from "../types";

/*
 * POST /auth/login · POST /auth/logout · GET /auth/me · POST /auth/password (DESIGN §E).
 */

/** Login throttles: per client IP and per target account, each over one minute. */
const LOGIN_RATE_LIMITS = {
  perIp: { max: 10, timeWindowMs: MINUTE_MS },
  perEmail: { max: 5, timeWindowMs: MINUTE_MS },
} as const;

/** Guessing the current password from a hijacked session is throttled per user. */
const PASSWORD_CHANGE_RATE_LIMIT = { max: 5, timeWindowMs: MINUTE_MS } as const;

// Both run as preHandlers, i.e. after validation: the body is a LoginRequest (email normalised)
// and the onRequest `authenticate` guard has set request.user.
const loginEmail = (request: FastifyRequest) =>
  `email:${(request.body as LoginRequest | undefined)?.email ?? ""}`;
const sessionUserId = (request: FastifyRequest) => `user:${request.user?.id ?? ""}`;

export const authRoutes: RouteModule = (app) => {
  const loginRateLimit = rateLimitGuard(
    app,
    [LOGIN_RATE_LIMITS.perIp, { ...LOGIN_RATE_LIMITS.perEmail, keyGenerator: loginEmail }],
    (seconds) => `Too many sign-in attempts. Try again in ${seconds}s.`,
  );
  const passwordRateLimit = rateLimitGuard(
    app,
    [{ ...PASSWORD_CHANGE_RATE_LIMIT, keyGenerator: sessionUserId }],
    (seconds) => `Too many attempts. Try again in ${seconds}s.`,
  );

  app.post(
    "/auth/login",
    {
      config: { public: true },
      preHandler: loginRateLimit,
      schema: { body: LoginRequest, response: { 200: SessionResponse } },
    },
    async (request, reply) => {
      const result = await login(
        app.deps,
        request.body,
        requestMeta(request),
        sessionToken(request),
      );
      setSessionCookie(reply, result.token);
      return result.session;
    },
  );

  // Public and idempotent, so a client whose session already expired can still clear its cookie.
  app.post("/auth/logout", { config: { public: true } }, async (request, reply) => {
    const token = sessionToken(request);
    if (token) await logout(app.deps.prisma, token, requestMeta(request));
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get(
    "/auth/me",
    { onRequest: authenticate, schema: { response: { 200: SessionResponse } } },
    (request) => currentSession(app.deps.prisma, currentUser(request).id),
  );

  app.post(
    "/auth/password",
    {
      onRequest: authenticate,
      preHandler: passwordRateLimit,
      schema: { body: ChangePasswordRequest },
    },
    async (request, reply) => {
      await changePassword(
        app.deps.prisma,
        currentUser(request),
        request.body,
        requestMeta(request),
      );
      return reply.status(204).send();
    },
  );
};
