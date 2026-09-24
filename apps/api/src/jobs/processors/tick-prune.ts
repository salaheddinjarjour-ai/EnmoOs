import { DAY_MS } from "../../lib/clock";
import type { JobProcessor } from "../types";

/** Realtime events are only needed for Last-Event-ID replay; a week covers any reconnect. */
export const REALTIME_EVENT_RETENTION_MS = 7 * DAY_MS;

/**
 * tick.prune, daily (DESIGN §D): deletes RealtimeEvent rows older than 7 days and Session rows
 * past expiresAt (sign-in only clears the signing-in user's own).
 */
export const tickPruneProcessor: JobProcessor = async (_job, deps) => {
  const now = deps.clock.now();
  const [events, sessions] = await Promise.all([
    deps.prisma.realtimeEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - REALTIME_EVENT_RETENTION_MS) } },
    }),
    deps.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  const report = { realtimeEvents: events.count, sessions: sessions.count };
  if (events.count + sessions.count > 0) deps.logger.info(report, "pruned expired rows");
  return report;
};
