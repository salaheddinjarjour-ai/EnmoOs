import type { Deps } from "../deps";
import { activeQueues } from "./registry";

/*
 * Starts the queue consumers and schedulers, either in the worker process or inside the API
 * (EMBEDDED_WORKER=true), for the processors in registry.ts. Phase 2 (U2, "embedded worker mode")
 * replaces the idle body with the BullMQ workers for those queues plus upsertJobScheduler
 * registrations.
 */

export interface WorkerRuntime {
  close(): Promise<void>;
}

export function startWorkers(deps: Deps): Promise<WorkerRuntime> {
  const queues = activeQueues();
  if (queues.length > 0) {
    // A registered processor must never be silently skipped.
    return Promise.reject(
      new Error(`No queue consumers exist yet for the registered queues: ${queues.join(", ")}`),
    );
  }
  deps.logger.info("worker idle — queues arrive in Phase 2");
  // Nothing else holds the event loop open yet; a standalone worker process must not exit.
  const keepAlive = setInterval(() => undefined, 2 ** 30);
  return Promise.resolve({
    close: () => {
      clearInterval(keepAlive);
      return Promise.resolve();
    },
  });
}
