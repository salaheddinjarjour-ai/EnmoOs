import { CalendarQuery, CalendarResponse } from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { listCalendar } from "../services/publishing";
import type { RouteModule } from "../types";

/*
 * The calendar (DESIGN §E "calendar", §G MonthGrid):
 *   GET /calendar?from&to&clientId   calendar.read   every client's publish jobs on the range's
 *                                                    client-local days, plus ghost slots for planned
 *                                                    posts without a job; at most 62 days
 */
export const calendarRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/calendar",
    {
      onRequest: requireCap("calendar.read"),
      schema: { querystring: CalendarQuery, response: { 200: CalendarResponse } },
    },
    (request) => listCalendar(deps, request.query),
  );
};
