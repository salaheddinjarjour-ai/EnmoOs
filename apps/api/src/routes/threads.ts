import {
  ChatMessageDto,
  IdParams,
  PostMessageRequest,
  ThreadMessagesQuery,
  ThreadMessagesResponse,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { listMessages, postUserMessage } from "../services/campaigns";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Chat threads (DESIGN §E "campaigns and chat"):
 *   GET  /threads/:id/messages   campaigns.read  oldest first; ?after=<message id> (exclusive)
 *   POST /threads/:id/messages   chat.post       stores the user's turn; the Manager answers async
 */
export const threadsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/threads/:id/messages",
    {
      onRequest: requireCap("campaigns.read"),
      schema: {
        params: IdParams,
        querystring: ThreadMessagesQuery,
        response: { 200: ThreadMessagesResponse },
      },
    },
    async (request) => ({
      items: await listMessages(deps, request.params.id, request.query.after),
    }),
  );

  app.post(
    "/threads/:id/messages",
    {
      onRequest: requireCap("chat.post"),
      schema: { params: IdParams, body: PostMessageRequest, response: { 201: ChatMessageDto } },
    },
    async (request, reply) => {
      const message = await postUserMessage(
        deps,
        serviceUserOf(request),
        request.params.id,
        request.body.content,
      );
      return reply.status(201).send(message);
    },
  );
};
