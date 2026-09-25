import {
  CheckSocialAccountResponse,
  CreateSocialAccountRequest,
  IdParams,
  SocialAccountDto,
  SocialAccountListResponse,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import {
  checkSocialAccount,
  connectSocialAccount,
  disconnectSocialAccount,
  listSocialAccounts,
  verifyWithPlatform,
} from "../services/social-accounts";
import type { RouteModule } from "../types";
import { actorOf } from "./clients";

/*
 * Social accounts (DESIGN §E); tokens go in encrypted and never come back out:
 *   GET /clients/:id/social-accounts · POST /clients/:id/social-accounts (manual token)
 *   DELETE /social-accounts/:id · POST /social-accounts/:id/check
 */
export const socialAccountsRoutes: RouteModule = (app) => {
  const { prisma, clock, tokenCipher: cipher, oauth } = app.deps;
  const verify = verifyWithPlatform(oauth);

  app.get(
    "/clients/:id/social-accounts",
    {
      onRequest: requireCap("clients.read"),
      schema: { params: IdParams, response: { 200: SocialAccountListResponse } },
    },
    async (request) => ({ items: await listSocialAccounts(prisma, request.params.id) }),
  );

  app.post(
    "/clients/:id/social-accounts",
    {
      onRequest: requireCap("socialAccounts.manage"),
      schema: {
        params: IdParams,
        body: CreateSocialAccountRequest,
        response: { 201: SocialAccountDto },
      },
    },
    async (request, reply) => {
      const account = await connectSocialAccount(prisma, request.params.id, request.body, {
        cipher,
        actor: actorOf(request),
        now: clock.now(),
      });
      return reply.status(201).send(account);
    },
  );

  app.delete(
    "/social-accounts/:id",
    { onRequest: requireCap("socialAccounts.manage"), schema: { params: IdParams } },
    async (request, reply) => {
      await disconnectSocialAccount(prisma, request.params.id, actorOf(request));
      return reply.status(204).send();
    },
  );

  app.post(
    "/social-accounts/:id/check",
    {
      onRequest: requireCap("socialAccounts.manage"),
      schema: { params: IdParams, response: { 200: CheckSocialAccountResponse } },
    },
    (request) =>
      checkSocialAccount(prisma, request.params.id, {
        cipher,
        actor: actorOf(request),
        now: clock.now(),
        verify,
      }),
  );
};
