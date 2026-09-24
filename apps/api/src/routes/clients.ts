import {
  ClientDto,
  ClientListQuery,
  ClientListResponse,
  CreateClientRequest,
  IdParams,
  UpdateApprovalChainRequest,
  UpdateClientRequest,
} from "@enmo/shared";
import type { FastifyRequest } from "fastify";
import { currentUser } from "../plugins/auth";
import { requireCap } from "../plugins/rbac";
import {
  archiveClient,
  createClient,
  getClient,
  listClients,
  replaceApprovalChain,
  updateClient,
  type Actor,
} from "../services/clients";
import type { RouteModule } from "../types";

/*
 * Clients (DESIGN §E):
 *   GET /clients · GET /clients/:id · POST /clients · PATCH /clients/:id
 *   PUT /clients/:id/approval-chain · POST /clients/:id/archive
 */

/** The signed-in user behind a guarded request, as recorded on AuditLog rows. */
export function actorOf(request: FastifyRequest): Actor {
  return { id: currentUser(request).id, ip: request.clientIp };
}

export const clientsRoutes: RouteModule = (app) => {
  const { prisma, clock } = app.deps;

  app.get(
    "/clients",
    {
      onRequest: requireCap("clients.read"),
      schema: { querystring: ClientListQuery, response: { 200: ClientListResponse } },
    },
    async (request) => ({ items: await listClients(prisma, request.query) }),
  );

  app.get(
    "/clients/:id",
    {
      onRequest: requireCap("clients.read"),
      schema: { params: IdParams, response: { 200: ClientDto } },
    },
    (request) => getClient(prisma, request.params.id),
  );

  app.post(
    "/clients",
    {
      onRequest: requireCap("clients.write"),
      schema: { body: CreateClientRequest, response: { 201: ClientDto } },
    },
    async (request, reply) => {
      const client = await createClient(prisma, request.body, actorOf(request));
      return reply.status(201).send(client);
    },
  );

  app.patch(
    "/clients/:id",
    {
      onRequest: requireCap("clients.write"),
      schema: { params: IdParams, body: UpdateClientRequest, response: { 200: ClientDto } },
    },
    (request) => updateClient(prisma, request.params.id, request.body, actorOf(request)),
  );

  app.put(
    "/clients/:id/approval-chain",
    {
      onRequest: requireCap("clients.write"),
      schema: { params: IdParams, body: UpdateApprovalChainRequest, response: { 200: ClientDto } },
    },
    (request) => replaceApprovalChain(prisma, request.params.id, request.body, actorOf(request)),
  );

  app.post(
    "/clients/:id/archive",
    {
      onRequest: requireCap("clients.archive"),
      schema: { params: IdParams, response: { 200: ClientDto } },
    },
    (request) => archiveClient(prisma, request.params.id, actorOf(request), clock.now()),
  );
};
