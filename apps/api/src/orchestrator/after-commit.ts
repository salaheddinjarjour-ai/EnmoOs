import type { Deps } from "../deps";

/**
 * Runs a follow-up of a change that has already committed: realtime events, the progress line,
 * queueing what became ready. Its failure can't undo the change, so it is logged, not thrown: the
 * caller still reports the change as done (a retry would only meet a CONFLICT), the next
 * transition recounts progress, and the sweeper queues ready tasks that were never queued.
 */
export async function afterCommit(
  deps: Pick<Deps, "logger">,
  what: string,
  effect: () => Promise<unknown>,
): Promise<void> {
  try {
    await effect();
  } catch (error) {
    deps.logger.warn({ err: error }, `${what} failed after its change committed`);
  }
}
