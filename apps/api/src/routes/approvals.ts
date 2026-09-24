import {
  ApprovalDecisionRequest,
  ApprovalListQuery,
  ApprovalListResponse,
  ApprovalRequestDto,
  ApproveAllRequest,
  ApproveAllResponse,
  IdParams,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { approveAll, decide, listPendingApprovals } from "../services/approvals";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Approvals (DESIGN §E "approvals"). Everyone holds approvals.decide; whether a user may decide the
 * current step of a given round is the chain's call, made by the service (403 when not).
 *   GET  /approvals               posts.read            PENDING rounds, newest first, canDecide
 *   POST /approvals/:id/decision  approvals.decide      APPROVE, or REQUEST_CHANGES + feedback
 *   POST /approvals/approve-all   approvals.approveAll  current step of each eligible round
 */
export const approvalsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/approvals",
    {
      onRequest: requireCap("posts.read"),
      schema: { querystring: ApprovalListQuery, response: { 200: ApprovalListResponse } },
    },
    async (request) => ({
      items: await listPendingApprovals(deps, serviceUserOf(request), request.query),
    }),
  );

  app.post(
    "/approvals/:id/decision",
    {
      onRequest: requireCap("approvals.decide"),
      schema: {
        params: IdParams,
        body: ApprovalDecisionRequest,
        response: { 200: ApprovalRequestDto },
      },
    },
    (request) => decide(deps, serviceUserOf(request), request.params.id, request.body),
  );

  app.post(
    "/approvals/approve-all",
    {
      onRequest: requireCap("approvals.approveAll"),
      schema: { body: ApproveAllRequest, response: { 200: ApproveAllResponse } },
    },
    (request) => approveAll(deps, serviceUserOf(request), request.body.requestIds),
  );
};
