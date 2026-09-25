import { LOCAL_FILES_PATH } from "../config";
import type { ApiApp, RouteModule } from "../types";
import { agentTasksRoutes } from "./agent-tasks";
import { approvalsRoutes } from "./approvals";
import { assetsRoutes } from "./assets";
import { authRoutes } from "./auth";
import { budgetRoutes } from "./budget";
import { calendarRoutes } from "./calendar";
import { campaignsRoutes } from "./campaigns";
import { capabilitiesRoutes } from "./capabilities";
import { clientsRoutes } from "./clients";
import { e2eHooksRoutes } from "./e2e-hooks";
import { eventsRoutes } from "./events";
import { filesRoutes } from "./files";
import { healthRoutes } from "./health";
import { invitesRoutes } from "./invites";
import { oauthMetaRoutes } from "./oauth-meta";
import { postsRoutes } from "./posts";
import { publishJobsRoutes } from "./publish-jobs";
import { socialAccountsRoutes } from "./social-accounts";
import { taskGraphsRoutes } from "./task-graphs";
import { threadsRoutes } from "./threads";
import { usersRoutes } from "./users";

/** Every /v1 module. Each gets its own encapsulated scope, so hooks never leak between them. */
export const V1_ROUTES: readonly RouteModule[] = [
  healthRoutes,
  authRoutes,
  usersRoutes,
  invitesRoutes,
  clientsRoutes,
  socialAccountsRoutes,
  capabilitiesRoutes,
  // Phase 2
  campaignsRoutes,
  threadsRoutes,
  taskGraphsRoutes,
  agentTasksRoutes,
  postsRoutes,
  approvalsRoutes,
  budgetRoutes,
  eventsRoutes,
  // Phase 3
  assetsRoutes,
  // Phase 4
  calendarRoutes,
  publishJobsRoutes,
  oauthMetaRoutes,
  // Browser-test hooks: registers nothing unless ENMO_E2E=1 outside production.
  e2eHooksRoutes,
];

export async function registerRoutes(app: ApiApp): Promise<void> {
  // Unversioned probes for Render's health check and the Cloudflare keep-alive cron.
  await app.register(async (scope) => {
    await healthRoutes(scope);
  });

  // Local asset files, unversioned: their URLs are stored on Asset rows. R2 serves its own.
  if (app.deps.config.STORAGE_DRIVER === "local") {
    await app.register(
      async (scope) => {
        await filesRoutes(scope);
      },
      { prefix: LOCAL_FILES_PATH },
    );
  }

  await app.register(
    async (v1) => {
      for (const routes of V1_ROUTES) {
        await v1.register(async (scope) => {
          await routes(scope);
        });
      }
    },
    { prefix: "/v1" },
  );
}
