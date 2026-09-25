/*
 * Same-origin API proxy for the Cloudflare Worker (worker.ts). In production the browser only
 * talks to the web app's own origin: /v1/* (every API route, the SSE stream included) and /files/*
 * (assets under STORAGE_DRIVER=local) are forwarded to API_ORIGIN. The session cookie is then
 * first-party wherever the app is served, a workers.dev address included, without the web app and
 * the API sharing a parent domain.
 *
 * The API sees every request arrive from Cloudflare's Workers egress address, so the visitor's
 * address travels in X-Enmo-Client-IP, vouched for by X-Enmo-Edge-Auth (the EDGE_PROXY_SECRET both
 * sides hold). Whatever X-Enmo-* headers the browser sent are dropped first.
 */

export interface ProxyEnv {
  /** The API's origin, e.g. https://enmo-api.onrender.com (no path). */
  readonly API_ORIGIN?: string;
  /** Shared with the API's EDGE_PROXY_SECRET; lets it believe X-Enmo-Client-IP. */
  readonly EDGE_PROXY_SECRET?: string;
}

const PROXIED_PREFIXES = ["/v1/", "/files/"] as const;

/** Request headers that describe this hop or were written by the client for a proxy to read. */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "forwarded",
  "x-real-ip",
]);

const DROPPED_REQUEST_PREFIXES = ["cf-", "x-forwarded-", "x-enmo-"] as const;

/** Whether the Worker forwards this path to the API instead of rendering it. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/v1" || PROXIED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** API_ORIGIN as a bare origin, or null when it is missing or not an http(s) URL. */
export function apiOrigin(env: ProxyEnv): string | null {
  const raw = env.API_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function errorResponse(status: number, code: "UNAVAILABLE", message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** The headers sent upstream: the browser's own, minus hop and spoofable ones, plus ours. */
export function upstreamHeaders(request: Request, env: ProxyEnv): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower)) return;
    if (DROPPED_REQUEST_PREFIXES.some((prefix) => lower.startsWith(prefix))) return;
    headers.append(name, value);
  });
  const url = new URL(request.url);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  // Cloudflare's edge writes CF-Connecting-IP on the request that reached this Worker.
  const visitor = request.headers.get("cf-connecting-ip")?.trim();
  const secret = env.EDGE_PROXY_SECRET?.trim();
  if (visitor && secret) {
    headers.set("x-enmo-client-ip", visitor);
    headers.set("x-enmo-edge-auth", secret);
  }
  return headers;
}

/**
 * Forwards the request to the API and streams the answer back unchanged (status, Set-Cookie,
 * redirects and SSE bodies included).
 */
export async function proxyToApi(
  request: Request,
  env: ProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const origin = apiOrigin(env);
  if (!origin) {
    return errorResponse(
      503,
      "UNAVAILABLE",
      "The web app has no API to talk to yet: set API_ORIGIN on the Cloudflare Worker.",
    );
  }
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, origin);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetchImpl(target.toString(), {
      method: request.method,
      headers: upstreamHeaders(request, env),
      // API bodies are small JSON documents; buffering keeps Content-Length exact.
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch {
    return errorResponse(502, "UNAVAILABLE", "The API could not be reached. Try again shortly.");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/** The keep-alive target: KEEPALIVE_URL, else the API's liveness probe. */
export function keepAliveUrl(env: ProxyEnv & { readonly KEEPALIVE_URL?: string }): string | null {
  const explicit = env.KEEPALIVE_URL?.trim();
  if (explicit) return explicit;
  const origin = apiOrigin(env);
  return origin ? `${origin}/healthz` : null;
}
