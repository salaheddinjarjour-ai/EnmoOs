import { HealthResponse, ReadyResponse } from "@enmo/shared";
import type { Redis } from "ioredis";
import type { RouteModule } from "../types";

/*
 * GET /healthz (liveness: no dependency checks, Render health check and the Cloudflare keep-alive)
 * and GET /readyz (Postgres `SELECT 1` + Redis PING; 503 when either fails). Registered both at the
 * root and under /v1, and public.
 */

/** How long /readyz waits on each dependency before calling it down. */
export const READY_CHECK_TIMEOUT_MS = 2000;

async function probe(check: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), READY_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * The shared client retries commands forever (maxRetriesPerRequest: null), so a PING sent while
 * the connection is down would wait in the offline queue until Redis returns: one more per probe
 * for the whole outage, and any queued command keeps quit() from resolving on shutdown. So only
 * ping a ready connection; a lazy client that never connected is opened with connect(), which
 * rejects instead of queueing when Redis is unreachable.
 */
async function pingRedis(redis: Redis): Promise<unknown> {
  if (redis.status === "wait") await redis.connect();
  if (redis.status !== "ready") throw new Error(`Redis is ${redis.status}`);
  return redis.ping();
}

export const healthRoutes: RouteModule = (app) => {
  app.get(
    "/healthz",
    { config: { public: true }, schema: { response: { 200: HealthResponse } } },
    () => ({ status: "ok" as const }),
  );

  app.get(
    "/readyz",
    { config: { public: true }, schema: { response: { 200: ReadyResponse, 503: ReadyResponse } } },
    async (_request, reply) => {
      const { prisma, redis } = app.deps;
      const [database, redisOk] = await Promise.all([
        probe(() => prisma.$queryRaw`SELECT 1`),
        probe(() => pingRedis(redis)),
      ]);
      const ok = database && redisOk;
      return reply
        .status(ok ? 200 : 503)
        .send({ status: ok ? "ok" : "unavailable", checks: { database, redis: redisOk } });
    },
  );
};
