import {
  AcceptInviteRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  IdParams,
  InviteListResponse,
  InvitePreviewResponse,
  InviteTokenParams,
  SessionResponse,
} from "@enmo/shared";
import type { FastifyRequest } from "fastify";
import { currentUser, requestMeta, sessionToken, setSessionCookie } from "../plugins/auth";
import { requireCap } from "../plugins/rbac";
import {
  acceptInvite,
  createInvite,
  listInvites,
  previewInvite,
  revokeInvite,
} from "../services/invites";
import type { RouteModule } from "../types";

/*
 * Invites (DESIGN §E):
 *   POST /invites · GET /invites · DELETE /invites/:id              (invites.manage)
 *   GET /invites/:token · POST /invites/:token/accept                (public; the token is the key)
 */

const actorContext = (request: FastifyRequest) => ({
  actorId: currentUser(request).id,
  ip: request.clientIp,
});

export const invitesRoutes: RouteModule = (app) => {
  app.post(
    "/invites",
    {
      onRequest: requireCap("invites.manage"),
      schema: { body: CreateInviteRequest, response: { 201: CreateInviteResponse } },
    },
    async (request, reply) =>
      reply.status(201).send(await createInvite(app.deps, request.body, actorContext(request))),
  );

  app.get(
    "/invites",
    { onRequest: requireCap("invites.manage"), schema: { response: { 200: InviteListResponse } } },
    async () => ({ items: await listInvites(app.deps) }),
  );

  app.delete(
    "/invites/:id",
    { onRequest: requireCap("invites.manage"), schema: { params: IdParams } },
    async (request, reply) => {
      await revokeInvite(app.deps, request.params.id, actorContext(request));
      return reply.status(204).send();
    },
  );

  app.get(
    "/invites/:token",
    {
      config: { public: true },
      schema: { params: InviteTokenParams, response: { 200: InvitePreviewResponse } },
    },
    (request) => previewInvite(app.deps, request.params.token),
  );

  app.post(
    "/invites/:token/accept",
    {
      config: { public: true },
      schema: {
        params: InviteTokenParams,
        body: AcceptInviteRequest,
        response: { 200: SessionResponse },
      },
    },
    async (request, reply) => {
      const result = await acceptInvite(
        app.deps,
        request.params.token,
        request.body,
        requestMeta(request),
        sessionToken(request),
      );
      setSessionCookie(reply, result.token);
      return result.session;
    },
  );
};
