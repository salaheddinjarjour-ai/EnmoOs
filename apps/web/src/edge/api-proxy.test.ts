import { describe, expect, it, vi } from "vitest";
import { apiOrigin, isApiPath, keepAliveUrl, proxyToApi, upstreamHeaders } from "./api-proxy";

const APP = "https://enmoos.example.workers.dev";
const ENV = { API_ORIGIN: "https://enmo-api.onrender.com", EDGE_PROXY_SECRET: "s".repeat(40) };

function capture(response: Response = new Response("ok")) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("isApiPath", () => {
  it("forwards the API and local files, and nothing else", () => {
    expect(isApiPath("/v1/auth/me")).toBe(true);
    expect(isApiPath("/v1")).toBe(true);
    expect(isApiPath("/files/clients/c1/p1/s1/v1.png")).toBe(true);
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/brief/abc")).toBe(false);
    expect(isApiPath("/v10/x")).toBe(false);
    expect(isApiPath("/_next/static/chunk.js")).toBe(false);
  });
});

describe("apiOrigin", () => {
  it("keeps only the origin of an http(s) URL", () => {
    expect(apiOrigin({ API_ORIGIN: "https://enmo-api.onrender.com/" })).toBe(
      "https://enmo-api.onrender.com",
    );
    expect(apiOrigin({ API_ORIGIN: " https://api.enmo.marketing/ignored/path " })).toBe(
      "https://api.enmo.marketing",
    );
    expect(apiOrigin({})).toBeNull();
    expect(apiOrigin({ API_ORIGIN: "ftp://x" })).toBeNull();
    expect(apiOrigin({ API_ORIGIN: "not a url" })).toBeNull();
  });
});

describe("upstreamHeaders", () => {
  it("drops hop-by-hop, Cloudflare and client-written proxy headers, then vouches for the visitor", () => {
    const request = new Request(`${APP}/v1/auth/login`, {
      method: "POST",
      headers: {
        cookie: "enmo_session=abc",
        origin: APP,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.7",
        "cf-ray": "x",
        "x-forwarded-for": "6.6.6.6",
        "x-enmo-client-ip": "6.6.6.6",
        "x-enmo-edge-auth": "forged",
        connection: "keep-alive",
      },
    });
    const headers = upstreamHeaders(request, ENV);
    expect(headers.get("cookie")).toBe("enmo_session=abc");
    expect(headers.get("origin")).toBe(APP);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cf-connecting-ip")).toBeNull();
    expect(headers.get("cf-ray")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("x-enmo-client-ip")).toBe("203.0.113.7");
    expect(headers.get("x-enmo-edge-auth")).toBe(ENV.EDGE_PROXY_SECRET);
    expect(headers.get("x-forwarded-host")).toBe("enmoos.example.workers.dev");
    expect(headers.get("x-forwarded-proto")).toBe("https");
  });

  it("sends no client address without a secret, so the API never trusts a forged one", () => {
    const request = new Request(`${APP}/v1/auth/me`, {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-enmo-client-ip": "6.6.6.6" },
    });
    const headers = upstreamHeaders(request, { API_ORIGIN: ENV.API_ORIGIN });
    expect(headers.get("x-enmo-client-ip")).toBeNull();
    expect(headers.get("x-enmo-edge-auth")).toBeNull();
  });
});

describe("proxyToApi", () => {
  it("forwards method, path, query and body to API_ORIGIN without following redirects", async () => {
    const { calls, fetchImpl } = capture(new Response(null, { status: 204 }));
    const body = JSON.stringify({ email: "a@b.co", password: "x".repeat(12) });
    const response = await proxyToApi(
      new Request(`${APP}/v1/auth/login?next=%2Fcommand`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      }),
      ENV,
      fetchImpl,
    );
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://enmo-api.onrender.com/v1/auth/login?next=%2Fcommand");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(new TextDecoder().decode(calls[0]!.init.body as ArrayBuffer)).toBe(body);
  });

  it("returns the API's status, headers and cookies untouched", async () => {
    const upstream = new Response('{"ok":true}', {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "enmo_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax"],
        ["set-cookie", "other=1; Path=/"],
      ],
    });
    const { fetchImpl } = capture(upstream);
    const response = await proxyToApi(new Request(`${APP}/v1/auth/me`), ENV, fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.getSetCookie()).toEqual([
      "enmo_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
      "other=1; Path=/",
    ]);
  });

  it("passes redirects through for the browser to follow", async () => {
    const { fetchImpl } = capture(
      new Response(null, { status: 302, headers: { location: `${APP}/clients/c1` } }),
    );
    const response = await proxyToApi(
      new Request(`${APP}/v1/oauth/meta/callback?code=x&state=y`),
      ENV,
      fetchImpl,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${APP}/clients/c1`);
  });

  it("streams an SSE body instead of buffering it", async () => {
    const encoder = new TextEncoder();
    let push: ((chunk: string) => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
      },
    });
    const { fetchImpl } = capture(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const response = await proxyToApi(new Request(`${APP}/v1/events`), ENV, fetchImpl);
    const reader = response.body!.getReader();
    push!("retry: 3000\n\n");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("retry: 3000\n\n");
    await reader.cancel();
  });

  it("answers 503 in the API's error shape when API_ORIGIN is missing", async () => {
    const { calls, fetchImpl } = capture();
    const response = await proxyToApi(new Request(`${APP}/v1/auth/me`), {}, fetchImpl);
    expect(calls).toHaveLength(0);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
  });

  it("answers 502 when the API can't be reached", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError("network down")),
    ) as unknown as typeof fetch;
    const response = await proxyToApi(new Request(`${APP}/v1/auth/me`), ENV, fetchImpl);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
  });
});

describe("keepAliveUrl", () => {
  it("prefers KEEPALIVE_URL, else pings the API's /healthz", () => {
    expect(keepAliveUrl({ KEEPALIVE_URL: "https://x.test/healthz", ...ENV })).toBe(
      "https://x.test/healthz",
    );
    expect(keepAliveUrl(ENV)).toBe("https://enmo-api.onrender.com/healthz");
    expect(keepAliveUrl({})).toBeNull();
  });
});
