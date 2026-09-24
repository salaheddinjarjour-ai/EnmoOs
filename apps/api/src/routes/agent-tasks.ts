import {
  AgentTaskDto,
  AgentTaskListResponse,
  IdParams,
  ResolveAgentTaskRequest,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { listCampaignTasks, resolveTask } from "../services/agent-tasks";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Agent tasks (DESIGN §E "plans and tasks"):
 *   GET  /campaigns/:id/tasks       campaigns.read           graph then node order
 *   POST /agent-tasks/:id/resolve   tasks.resolveEscalation  retry | accept_best, for an
 *                                                            ESCALATED or FAILED task
 */
export const agentTasksRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/campaigns/:id/tasks",
    {
      onRequest: requireCap("campaigns.read"),
      schema: { params: IdParams, response: { 200: AgentTaskListResponse } },
    },
    async (request) => ({ items: await listCampaignTasks(deps, request.params.id) }),
  );

  app.post(
    "/agent-tasks/:id/resolve",
    {
      onRequest: requireCap("tasks.resolveEscalation"),
      schema: { params: IdParams, body: ResolveAgentTaskRequest, response: { 200: AgentTaskDto } },
    },
    (request) => resolveTask(deps, serviceUserOf(request), request.params.id, request.body.action),
  );
};
