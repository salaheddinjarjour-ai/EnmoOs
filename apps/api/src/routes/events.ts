import { setMaxListeners } from "node:events";
import { Id, realtimeRedisChannel } from "@enmo/shared";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { authenticateWithoutRefresh, resolveSessionUser } from "../plugins/auth";
import { createRealtimeHub, type RealtimeHub } from "../realtime/hub";
import {
  EventId,
  resolveChannels,
  resolveLastEventId,
  SSE_SESSION_CHECK_MS,
  streamEvents,
} from "../realtime/sse";
import type { RouteModule } from "../types";

/*
 * Realtime (DESIGN §D "Endpoint"):
 *   GET /events?threadId=&lastEventId=   any session   text/event-stream
 * Always the global channel, plus `thread:<id>` when the page names a thread. The module owns its
 * hub: the SUBSCRIBE connection opens with the first stream and closes with the app, so only API
 * processes that serve streams hold one. The reply is hijacked, so it can't re-issue the session
 * cookie: the stream checks its session (on open and every sessionCheckMs) without rolling it.
 */

export const EventsQuery = z.object({
  threadId: Id.optional(),
  /** For a page that remembers where it was; EventSource's Last-Event-ID header wins over it. */
  lastEventId: EventId.optional(),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export interface EventsRoutesOptions {
  /** Defaults to SSE_HEARTBEAT_MS; tests shorten it. */
  heartbeatMs?: number;
  /** Defaults to SSE_SESSION_CHECK_MS; tests shorten it. */
  sessionCheckMs?: number;
  /** A hub the caller owns and closes; by default the module creates one per app. */
  hub?: RealtimeHub;
}

export function createEventsRoutes(options: EventsRoutesOptions = {}): RouteModule {
  return (app) => {
    const { config, logger, prisma } = app.deps;
    const hub =
      options.hub ??
      createRealtimeHub({
        redisUrl: config.REDIS_URL,
        redisChannel: realtimeRedisChannel(config.BULLMQ_PREFIX),
        logger,
      });
    const allowedOrigins: ReadonlySet<string> = new Set(config.APP_ORIGINS);

    // Open streams would hold server.close() until every browser left, so they end first.
    const shutdown = new AbortController();
    setMaxListeners(0, shutdown.signal);
    app.addHook("preClose", (done) => {
      shutdown.abort();
      done();
    });
    if (!options.hub) app.addHook("onClose", () => hub.close());

    app.get(
      "/events",
      { onRequest: authenticateWithoutRefresh, schema: { querystring: EventsQuery } },
      async (request, reply) => {
        const lastEventId = resolveLastEventId(
          request.headers["last-event-id"],
          request.query.lastEventId,
        );
        const channels = await resolveChannels(prisma, request.query.threadId);
        try {
          await hub.start();
        } catch (error) {
          throw new AppError("UNAVAILABLE", "Live updates are unavailable right now", {
            cause: error,
          });
        }
        await streamEvents(request, reply, hub, {
          channels,
          lastEventId,
          allowedOrigins,
          heartbeatMs: options.heartbeatMs,
          signal: shutdown.signal,
          session: {
            everyMs: options.sessionCheckMs ?? SSE_SESSION_CHECK_MS,
            isValid: async () => (await resolveSessionUser(request, { refresh: false })) !== null,
          },
        });
      },
    );
  };
}

export const eventsRoutes: RouteModule = createEventsRoutes();
