// @ts-expect-error -- generated (untyped) by `opennextjs-cloudflare build`; wrangler bundles it.
import openNextWorker from "./.open-next/worker.js";
import { isApiPath, keepAliveUrl, proxyToApi } from "./src/edge/api-proxy";

// Cloudflare Worker entry (wrangler.jsonc "main"): forwards /v1/* and /files/* to the API (same
// origin for the browser, see src/edge/api-proxy.ts), serves everything else through OpenNext, and
// on the every-5-minutes cron trigger pings the API so Render's free tier never sleeps.

/** The bindings this file reads; the runtime passes the full env through to OpenNext. */
interface Env {
  readonly API_ORIGIN?: string;
  readonly EDGE_PROXY_SECRET?: string;
  readonly KEEPALIVE_URL?: string;
  readonly [binding: string]: unknown;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

interface WorkerHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

const nextApp = openNextWorker as WorkerHandler;

const KEEPALIVE_TIMEOUT_MS = 20_000;

async function pingApi(url: string): Promise<void> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "enmo-web-keepalive" },
      signal: AbortSignal.timeout(KEEPALIVE_TIMEOUT_MS),
    });
    if (!response.ok) console.warn(`keep-alive ${url} answered ${response.status}`);
  } catch (error) {
    console.warn(`keep-alive ${url} failed`, error);
  }
}

export default {
  fetch: (request, env, ctx) =>
    isApiPath(new URL(request.url).pathname)
      ? proxyToApi(request, env)
      : nextApp.fetch(request, env, ctx),

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const target = keepAliveUrl(env);
    if (target) ctx.waitUntil(pingApi(target));
  },
} satisfies WorkerHandler & Record<string, unknown>;
