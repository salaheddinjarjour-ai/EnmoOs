import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDeps } from "./deps";
import { startWorkers, type WorkerRuntime } from "./jobs/runtime";
import { onShutdown } from "./lib/shutdown";
import { bootstrapSeedAdmin } from "./services/bootstrap";

/* HTTP entrypoint: `node dist/server.js` (Render web service) or `pnpm dev` (tsx watch). */

const config = loadConfig();
const deps = createDeps(config);
let worker: WorkerRuntime | undefined;

try {
  const app = await buildApp(deps);
  await bootstrapSeedAdmin(deps);
  if (config.EMBEDDED_WORKER) worker = await startWorkers(deps);
  await app.listen({ host: config.HOST, port: config.PORT });

  onShutdown(deps.logger, async () => {
    await app.close();
    await worker?.close();
    await deps.close();
  });
} catch (error) {
  deps.logger.fatal({ err: error }, "API failed to start");
  await worker?.close();
  await deps.close();
  process.exit(1);
}
