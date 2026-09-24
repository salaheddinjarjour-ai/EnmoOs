import { IdParams, RequestPlanChangesRequest, TaskGraphDto } from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { approvePlan, getTaskGraph, requestPlanChanges } from "../services/task-graphs";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Plans (DESIGN §E "plans and tasks"). Approval is the point where generation spend starts, hence
 * the stricter capability than asking for changes.
 *   GET  /task-graphs/:id                  campaigns.read       the PlanCard
 *   POST /task-graphs/:id/approve          plan.approve         posts + tasks, then advance()
 *   POST /task-graphs/:id/request-changes  plan.requestChanges  re-plans with the feedback verbatim
 */
export const taskGraphsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/task-graphs/:id",
    {
      onRequest: requireCap("campaigns.read"),
      schema: { params: IdParams, response: { 200: TaskGraphDto } },
    },
    (request) => getTaskGraph(deps, request.params.id),
  );

  app.post(
    "/task-graphs/:id/approve",
    {
      onRequest: requireCap("plan.approve"),
      schema: { params: IdParams, response: { 200: TaskGraphDto } },
    },
    (request) => approvePlan(deps, serviceUserOf(request), request.params.id),
  );

  app.post(
    "/task-graphs/:id/request-changes",
    {
      onRequest: requireCap("plan.requestChanges"),
      schema: {
        params: IdParams,
        body: RequestPlanChangesRequest,
        response: { 200: TaskGraphDto },
      },
    },
    (request) =>
      requestPlanChanges(deps, serviceUserOf(request), request.params.id, request.body.feedback),
  );
};
