import {
  CancelPublishJobResponse,
  IdParams,
  ReschedulePublishJobBody,
  ReschedulePublishJobResponse,
  RetryPublishJobResponse,
  SchedulePublishJobBody,
  SchedulePublishJobResponse,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { cancel, reschedule, retry, schedule } from "../services/publishing";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Publish jobs (DESIGN §E "calendar"):
 *   POST  /publish-jobs {postId,       publish.reschedule  a platform the Publisher couldn't place
 *         platform, date}                                  (or whose job was cancelled), at the
 *                                                          best free hour of that client-local day
 *   PATCH /publish-jobs/:id {date}     publish.reschedule  the best free hour of that client-local
 *                                                          day (a calendar drag)
 *   POST  /publish-jobs/:id/retry      publish.retry       a FAILED job, queued again
 *   POST  /publish-jobs/:id/cancel     publish.cancel      a job that hasn't started publishing
 */
export const publishJobsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.post(
    "/publish-jobs",
    {
      onRequest: requireCap("publish.reschedule"),
      schema: { body: SchedulePublishJobBody, response: { 201: SchedulePublishJobResponse } },
    },
    async (request, reply) => {
      const job = await schedule(deps, serviceUserOf(request), request.body);
      return reply.status(201).send(job);
    },
  );

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
