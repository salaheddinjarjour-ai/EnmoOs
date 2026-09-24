import type { ApiApp, RouteModule } from "../types";
import { agentTasksRoutes } from "./agent-tasks";
import { approvalsRoutes } from "./approvals";
import { authRoutes } from "./auth";
import { budgetRoutes } from "./budget";
import { campaignsRoutes } from "./campaigns";
import { capabilitiesRoutes } from "./capabilities";
import { clientsRoutes } from "./clients";
import { eventsRoutes } from "./events";
import { healthRoutes } from "./health";
import { invitesRoutes } from "./invites";
import { postsRoutes } from "./posts";
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
];

export async function registerRoutes(app: ApiApp): Promise<void> {
  // Unversioned probes for Render's health check and the Cloudflare keep-alive cron.
  await app.register(async (scope) => {
    await healthRoutes(scope);
  });

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
