import { IsoDateTime } from "@enmo/shared";
import { z } from "zod";
import type { Config } from "../config";
import type { Clock } from "../lib/clock";
import { requireCap } from "../plugins/rbac";
import { publishTick } from "../publishing/publish-service";
import type { RouteModule } from "../types";

/*
 * Browser-test hooks for apps/web/e2e, and nothing else. They exist only in a server started with
 * ENMO_E2E=1 (the Playwright API, see apps/web/playwright.config.ts) and never in production; in
 * any other process this module registers no route at all, so the RBAC matrix never sees one.
 *
 *   POST /e2e/ticks/publish {at?}   publish.retry   runs tick.publish as if the clock read `at`
 *                                                   (default: now) and answers its report
 *
 * The Playwright API runs on the real clock and a slot is at least half an hour out, so without
 * this a browser test could never watch a post go live. Only the tick's "now" moves: the jobs due
 * by then are queued, and the embedded worker publishes them exactly as it would at their slot.
 * The API's own e2e suites move a FakeClock instead.
 */

export function e2eHooksEnabled(
  env: Readonly<Record<string, string | undefined>>,
  config: Pick<Config, "NODE_ENV">,
): boolean {
  return env.ENMO_E2E === "1" && config.NODE_ENV !== "production";
}

const TickPublishBody = z.object({ at: IsoDateTime.optional() });

const TickPublishResponse = z.object({
  queued: z.int().nonnegative(),
  redriven: z.int().nonnegative(),
  stalled: z.int().nonnegative(),
  rescheduled: z.int().nonnegative(),
});

export const e2eHooksRoutes: RouteModule = (app) => {
  const { deps } = app;
  if (!e2eHooksEnabled(process.env, deps.config)) return;

  app.post(
    "/e2e/ticks/publish",
    {
      onRequest: requireCap("publish.retry"),
      schema: { body: TickPublishBody, response: { 200: TickPublishResponse } },
    },
    (request) => {
      const at = request.body.at ? new Date(request.body.at) : deps.clock.now();
      const clock: Clock = { now: () => at };
      return publishTick({ ...deps, clock });
    },
  );
};
