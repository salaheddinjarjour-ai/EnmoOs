import type { Logger } from "./logger";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const FORCE_EXIT_AFTER_MS = 15_000;

/**
 * Runs `cleanup` once on SIGINT/SIGTERM, then exits. A second signal, or a cleanup that hangs
 * (e.g. a long-running job), forces the exit so Render's deploys never stall.
 */
export function onShutdown(logger: Logger, cleanup: () => Promise<void>): void {
  let shuttingDown = false;

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.warn({ signal }, "second signal, exiting now");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const force = setTimeout(() => {
      logger.error("shutdown timed out, exiting");
      process.exit(1);
    }, FORCE_EXIT_AFTER_MS);
    force.unref();

    cleanup().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      },
    );
  };

  for (const signal of SIGNALS) process.once(signal, handle);
}
