import {
  CancelPublishJobResponse,
  IdParams,
  ReschedulePublishJobBody,
  ReschedulePublishJobResponse,
  RetryPublishJobResponse,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { cancel, reschedule, retry } from "../services/publishing";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Publish jobs (DESIGN §E "calendar"):
 *   PATCH /publish-jobs/:id {date}     publish.reschedule  the best free hour of that client-local
 *                                                          day (a calendar drag)
 *   POST  /publish-jobs/:id/retry      publish.retry       a FAILED job, queued again
 *   POST  /publish-jobs/:id/cancel     publish.cancel      a job that hasn't started publishing
 */
export const publishJobsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.patch(
    "/publish-jobs/:id",
    {
      onRequest: requireCap("publish.reschedule"),
      schema: {
        params: IdParams,
        body: ReschedulePublishJobBody,
        response: { 200: ReschedulePublishJobResponse },
      },
    },
    (request) => reschedule(deps, serviceUserOf(request), request.params.id, request.body.date),
  );

  app.post(
    "/publish-jobs/:id/retry",
    {
      onRequest: requireCap("publish.retry"),
      schema: { params: IdParams, response: { 200: RetryPublishJobResponse } },
    },
    (request) => retry(deps, serviceUserOf(request), request.params.id),
  );

  app.post(
    "/publish-jobs/:id/cancel",
    {
      onRequest: requireCap("publish.cancel"),
      schema: { params: IdParams, response: { 200: CancelPublishJobResponse } },
    },
    (request) => cancel(deps, serviceUserOf(request), request.params.id),
  );
};
