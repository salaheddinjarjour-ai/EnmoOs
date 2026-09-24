import { CapabilitiesResponse } from "@enmo/shared";
import { authenticate } from "../plugins/auth";
import { describeCapabilities } from "../services/capabilities";
import type { RouteModule } from "../types";

/*
 * GET /capabilities — LLM/visual/publish/storage modes and configured integrations (DESIGN §E).
 * Any signed-in user may read it: the matrix has no capability for it and it holds no secrets.
 */
export const capabilitiesRoutes: RouteModule = (app) => {
  const capabilities = describeCapabilities(app.deps.config);

  app.get(
    "/capabilities",
    { onRequest: authenticate, schema: { response: { 200: CapabilitiesResponse } } },
    () => capabilities,
  );
};
