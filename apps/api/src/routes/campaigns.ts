import {
  CampaignDto,
  CampaignListQuery,
  CampaignListResponse,
  CreateCampaignRequest,
  IdParams,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import {
  archiveCampaign,
  createCampaignFromMessage,
  getCampaign,
  listCampaigns,
} from "../services/campaigns";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Campaigns (DESIGN §E "campaigns and chat"):
 *   GET  /campaigns              campaigns.read     newest first, ?clientId&status
 *   POST /campaigns              campaigns.create   opens the campaign + thread; intake runs async
 *   GET  /campaigns/:id          campaigns.read
 *   POST /campaigns/:id/archive  campaigns.archive  stops further spend; idempotent
 * (GET /campaigns/:id/tasks lives in agent-tasks.ts.)
 */
export const campaignsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/campaigns",
    {
      onRequest: requireCap("campaigns.read"),
      schema: { querystring: CampaignListQuery, response: { 200: CampaignListResponse } },
    },
    async (request) => ({ items: await listCampaigns(deps, request.query) }),
  );

  app.post(
    "/campaigns",
    {
      onRequest: requireCap("campaigns.create"),
      schema: { body: CreateCampaignRequest, response: { 201: CampaignDto } },
    },
    async (request, reply) => {
      const campaign = await createCampaignFromMessage(deps, serviceUserOf(request), request.body);
      return reply.status(201).send(campaign);
    },
  );

  app.get(
    "/campaigns/:id",
    {
      onRequest: requireCap("campaigns.read"),
      schema: { params: IdParams, response: { 200: CampaignDto } },
    },
    (request) => getCampaign(deps, request.params.id),
  );

  app.post(
    "/campaigns/:id/archive",
    {
      onRequest: requireCap("campaigns.archive"),
      schema: { params: IdParams, response: { 200: CampaignDto } },
    },
    (request) => archiveCampaign(deps, serviceUserOf(request), request.params.id),
  );
};
