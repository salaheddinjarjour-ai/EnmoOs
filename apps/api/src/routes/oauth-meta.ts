import { OAuthCallbackQuery, OAuthStartQuery, OAuthStartResponse } from "@enmo/shared";
import type { FastifyRequest } from "fastify";
import { currentUser, resolveSessionUser, type AuthUser } from "../plugins/auth";
import { requireCap } from "../plugins/rbac";
import { toServiceUser } from "../services/actor";
import { completeMetaOAuth, startMetaOAuth, type OAuthSessionUser } from "../services/oauth";
import type { RouteModule } from "../types";

/*
 * Connecting Facebook Pages and their Instagram accounts (DESIGN §E "OAuth"):
 *   GET /oauth/meta/start?clientId   socialAccounts.manage   {authorizeUrl}: the web app sends the
 *                                                            admin to Meta's consent screen
 *   GET /oauth/meta/callback         public                  Meta redirects the browser here; the
 *                                                            state (bound to the admin's session)
 *                                                            is checked, then a redirect back to the
 *                                                            client's accounts tab
 */

function oauthUserOf(request: FastifyRequest, user: AuthUser): OAuthSessionUser {
  return { ...toServiceUser(user, request.clientIp || null), sessionId: user.sessionId };
}

export const oauthMetaRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/oauth/meta/start",
    {
      onRequest: requireCap("socialAccounts.manage"),
      schema: { querystring: OAuthStartQuery, response: { 200: OAuthStartResponse } },
    },
    (request) =>
      startMetaOAuth(deps, oauthUserOf(request, currentUser(request)), request.query.clientId),
  );

  app.get(
    "/oauth/meta/callback",
    // Public: Meta's redirect carries no guarantee of a session, so the state does the checking.
    // The query is parsed here rather than by a schema: a malformed one still ends in a redirect
    // the person can read, never a JSON 400 in their browser tab.
    { config: { public: true } },
    async (request, reply) => {
      const parsed = OAuthCallbackQuery.safeParse(request.query);
      const user = await resolveSessionUser(request);
      const { redirectTo } = await completeMetaOAuth(
        deps,
        parsed.success ? parsed.data : {},
        user ? oauthUserOf(request, user) : null,
      );
      return reply.redirect(redirectTo);
    },
  );
};
