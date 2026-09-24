import { loadConfig } from "./config";
import { createDeps } from "./deps";
import { startWorkers } from "./jobs/runtime";
import { onShutdown } from "./lib/shutdown";

/* Queue worker entrypoint: `node dist/worker.js` (Render background worker). */

const config = loadConfig();
const deps = createDeps(config);

try {
  const worker = await startWorkers(deps);
  onShutdown(deps.logger, async () => {
    await worker.close();
    await deps.close();
  });
} catch (error) {
  deps.logger.fatal({ err: error }, "worker failed to start");
  await deps.close();
  process.exit(1);
}
