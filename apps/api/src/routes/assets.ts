import {
  AssetDetailDto,
  AssetDto,
  AssetListQuery,
  AssetListResponse,
  IdParams,
  RegenerateAssetBody,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { getAsset, listAssets, regenerateAsset } from "../services/assets";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * The Vault (DESIGN §E "vault"):
 *   GET  /assets                  assets.read        newest first, keyset-paginated (`cursor` →
 *                                                    `nextCursor`); ?q&clientId&campaignId&postId
 *                                                    &sceneIndex&slideIndex&kind&allVersions&limit
 *   GET  /assets/:id              assets.read        the asset plus its lineage, oldest version first
 *   POST /assets/:id/regenerate   assets.regenerate  202 with the new QUEUED version; the Visual
 *                                                    Director re-plans the shot from its original
 *                                                    context and the instruction, asynchronously
 */
export const assetsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/assets",
    {
      onRequest: requireCap("assets.read"),
      schema: { querystring: AssetListQuery, response: { 200: AssetListResponse } },
    },
    // `?q=` (or only spaces) is a search box left empty, not a search for nothing.
    (request) => listAssets(deps, { ...request.query, q: request.query.q || undefined }),
  );

  app.get(
    "/assets/:id",
    {
      onRequest: requireCap("assets.read"),
      schema: { params: IdParams, response: { 200: AssetDetailDto } },
    },
    (request) => getAsset(deps, request.params.id),
  );

  app.post(
    "/assets/:id/regenerate",
    {
      onRequest: requireCap("assets.regenerate"),
      // The instruction is optional, so the whole body may be too: Fastify reads a POST without
      // one as null, an empty JSON body as undefined.
      schema: {
        params: IdParams,
        body: RegenerateAssetBody.nullish(),
        response: { 202: AssetDto },
      },
    },
    async (request, reply) => {
      const asset = await regenerateAsset(
        deps,
        serviceUserOf(request),
        request.params.id,
        request.body?.instruction ?? null,
      );
      return reply.status(202).send(asset);
    },
  );
};
