import { describe, expect, it } from "vitest";
import { defaultVisualStyle } from "@enmo/shared";
import {
  HIGGSFIELD_DEFAULT_MAX_VIDEO_SEC,
  HiggsfieldError,
  HiggsfieldProvider,
  createVisualProvider,
  type HiggsfieldProviderOptions,
  type VisualRequest,
} from "../src";

const BASE_URL = "https://hf.fake.test";

interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

type Route = (request: Recorded) => Response | Promise<Response>;

/** A fetch that records every call and answers with `route`. */
function fakeFetch(route: Route) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const recorded: Recorded = {
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(recorded);
    return route(recorded);
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function provider(
  route: Route,
  overrides: Partial<HiggsfieldProviderOptions> = {},
): { higgsfield: HiggsfieldProvider; calls: Recorded[] } {
  const { fetch, calls } = fakeFetch(route);
  const higgsfield = new HiggsfieldProvider({
    keyId: "kid",
    keySecret: "ksecret",
    baseUrl: BASE_URL,
    imageModel: "higgsfield-ai/soul/standard",
    videoModel: "higgsfield-ai/dop/standard",
    fetch,
    ...overrides,
  });
  return { higgsfield, calls };
}

function request(overrides: Partial<VisualRequest> = {}): VisualRequest {
  return {
    kind: "IMAGE",
    prompt: "Cold brew on dark marble, golden hour",
    negativePrompt: "text, watermark",
    aspectRatio: "4:5",
    durationSec: null,
    seed: 42,
    referenceImageUrl: null,
    brand: { name: "Qahwa House", tokens: defaultVisualStyle() },
    meta: { shotId: "s1", sceneText: "Iftar, iced.", version: 1 },
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<HiggsfieldError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HiggsfieldError);
  return error as HiggsfieldError;
}

describe("HiggsfieldProvider.capabilities", () => {
  it("offers what its configured models render", () => {
    const route = () => json({});
    expect(provider(route).higgsfield.capabilities()).toEqual({
      image: true,
      video: true,
      maxVideoSec: HIGGSFIELD_DEFAULT_MAX_VIDEO_SEC,
    });
    expect(provider(route, { videoModel: null, maxVideoSec: 5 }).higgsfield.capabilities()).toEqual(
      { image: true, video: false, maxVideoSec: 0 },
    );
    expect(provider(route, { maxVideoSec: 5 }).higgsfield.capabilities().maxVideoSec).toBe(5);
  });

  it("is what createVisualProvider builds for VISUAL_PROVIDER=higgsfield, with its fetch", async () => {
    const { fetch, calls } = fakeFetch(() => json({ request_id: "r1", status: "queued" }));
    const higgsfield = createVisualProvider(
      {
        provider: "higgsfield",
        higgsfield: {
          keyId: "kid",
          keySecret: "ksecret",
          baseUrl: `${BASE_URL}/`,
          imageModel: "img-model",
          videoModel: null,
        },
      },
      { fetch },
    );
    expect(higgsfield).toBeInstanceOf(HiggsfieldProvider);
    await higgsfield.submit(request());
    expect(calls[0]!.url).toBe(`${BASE_URL}/img-model`);
  });
});

describe("HiggsfieldProvider.submit", () => {
  it("POSTs the model input to {baseUrl}/{model} with the Key credentials", async () => {
    const { higgsfield, calls } = provider(() =>
      json({ request_id: "req-1", status: "queued", status_url: "…", cancel_url: "…" }),
    );

    expect(await higgsfield.submit(request())).toEqual({
      jobId: "req-1",
      model: "higgsfield-ai/soul/standard",
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe("POST");
    expect(call!.url).toBe(`${BASE_URL}/higgsfield-ai/soul/standard`);
    expect(call!.headers.get("authorization")).toBe("Key kid:ksecret");
    expect(call!.headers.get("content-type")).toBe("application/json");
    expect(call!.body).toEqual({
      prompt: "Cold brew on dark marble, golden hour",
      aspect_ratio: "4:5",
      negative_prompt: "text, watermark",
      seed: 42,
    });
  });

  it("sends a video shot to the video model with its length and source image", async () => {
    const { higgsfield, calls } = provider(() => json({ request_id: "req-2", status: "queued" }));
    const submitted = await higgsfield.submit(
      request({
        kind: "VIDEO",
        aspectRatio: "9:16",
        durationSec: 4.5,
        seed: null,
        negativePrompt: null,
        referenceImageUrl: "https://assets.enmo.marketing/clients/c1/assets/a1.png",
      }),
    );
    expect(submitted.model).toBe("higgsfield-ai/dop/standard");
    expect(calls[0]!.url).toBe(`${BASE_URL}/higgsfield-ai/dop/standard`);
    expect(calls[0]!.body).toEqual({
      prompt: "Cold brew on dark marble, golden hour",
      aspect_ratio: "9:16",
      duration: 5,
      input_images: [
        {
          type: "image_url",
          image_url: "https://assets.enmo.marketing/clients/c1/assets/a1.png",
        },
      ],
    });
  });

  it("refuses to call Higgsfield without credentials or a model for the kind", async () => {
    const noKeys = provider(() => json({}), { keyId: null });
    const missingKeys = await rejection(noKeys.higgsfield.submit(request()));
    expect(missingKeys.message).toMatch(/HIGGSFIELD_CREDENTIALS/);
    expect(missingKeys.retryable).toBe(false);
    expect(noKeys.calls).toHaveLength(0);

    const noVideo = provider(() => json({}), { videoModel: null });
    const missingModel = await rejection(
      noVideo.higgsfield.submit(request({ kind: "VIDEO", durationSec: 3 })),
    );
    expect(missingModel.message).toMatch(/HIGGSFIELD_VIDEO_MODEL/);
    expect(noVideo.calls).toHaveLength(0);
  });

  it("explains HTTP errors, never echoing the secret, and says which are worth retrying", async () => {
    const unauthorized = await rejection(
      provider(() => new Response("invalid key", { status: 401 })).higgsfield.submit(request()),
    );
    expect(unauthorized.message).toBe("Higgsfield submit answered 401: invalid key");
    expect(unauthorized.message).not.toContain("ksecret");
    expect([unauthorized.status, unauthorized.retryable]).toEqual([401, false]);

    const throttled = await rejection(
      provider(() => new Response("slow down", { status: 429 })).higgsfield.submit(request()),
    );
    expect([throttled.status, throttled.retryable]).toEqual([429, true]);

    const down = await rejection(
      provider(() => new Response(null, { status: 503 })).higgsfield.submit(request()),
    );
    expect(down.message).toBe("Higgsfield submit answered 503");
    expect(down.retryable).toBe(true);
  });

  it("rejects a success body without a request id", async () => {
    const error = await rejection(
      provider(() => json({ status: "queued" })).higgsfield.submit(request()),
    );
    expect(error.message).toMatch(/unexpected body/);
    const notJson = await rejection(
      provider(() => new Response("<html>", { status: 200 })).higgsfield.submit(request()),
    );
    expect(notJson.message).toMatch(/invalid JSON/);
  });
});

describe("HiggsfieldProvider.status", () => {
  const statusOf = async (body: unknown, status = 200) => {
    const { higgsfield, calls } = provider(() => json(body, status));
    const result = await higgsfield.status("req/1");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${BASE_URL}/requests/req%2F1/status`);
    expect(calls[0]!.headers.get("authorization")).toBe("Key kid:ksecret");
    return result;
  };

  it("maps queued and in_progress to queued and running", async () => {
    expect(await statusOf({ status: "queued", request_id: "req/1" })).toEqual({ state: "queued" });
    expect(await statusOf({ status: "in_progress" })).toEqual({ state: "running" });
  });

  it("returns a completed image request's outputs with their types", async () => {
    expect(
      await statusOf({
        status: "completed",
        images: [
          { url: "https://cdn.higgsfield.ai/out/a.webp" },
          { url: "https://cdn.higgsfield.ai/out/b" },
        ],
        video: null,
      }),
    ).toEqual({
      state: "succeeded",
      outputs: [
        { url: "https://cdn.higgsfield.ai/out/a.webp", mimeType: "image/webp" },
        { url: "https://cdn.higgsfield.ai/out/b", mimeType: "image/png" },
      ],
    });
  });

  it("puts a completed video first and its still frames after it", async () => {
    expect(
      await statusOf({
        status: "completed",
        video: { url: "https://cdn.higgsfield.ai/out/clip.mp4?sig=1" },
        images: [{ url: "https://cdn.higgsfield.ai/out/poster.jpg" }],
      }),
    ).toEqual({
      state: "succeeded",
      outputs: [
        { url: "https://cdn.higgsfield.ai/out/clip.mp4?sig=1", mimeType: "video/mp4" },
        { url: "https://cdn.higgsfield.ai/out/poster.jpg", mimeType: "image/jpeg" },
      ],
    });
  });

  it("maps failed, nsfw and cancelled, and a completion without output", async () => {
    expect(await statusOf({ status: "failed", error: "model crashed" })).toEqual({
      state: "failed",
      error: "model crashed",
    });
    expect(await statusOf({ status: "failed" })).toMatchObject({ state: "failed" });
    expect(await statusOf({ status: "nsfw" })).toEqual({
      state: "rejected",
      error: "Higgsfield's content filter rejected the render (nsfw)",
    });
    expect(await statusOf({ status: "canceled" })).toMatchObject({ state: "failed" });
    expect(await statusOf({ status: "completed", images: [] })).toEqual({
      state: "failed",
      error: "Higgsfield completed the request without any output",
    });
  });

  it("fails a request Higgsfield doesn't know, and throws on errors and unknown statuses", async () => {
    expect(await statusOf({ detail: "Not found" }, 404)).toEqual({
      state: "failed",
      error: "Higgsfield has no request req/1",
    });

    const unknown = await rejection(
      provider(() => json({ status: "levitating" })).higgsfield.status("r"),
    );
    expect(unknown.message).toMatch(/unknown status "levitating"/);

    const down = await rejection(
      provider(() => new Response("bad gateway", { status: 502 })).higgsfield.status("r"),
    );
    expect([down.status, down.retryable]).toEqual([502, true]);
  });
});

describe("HiggsfieldProvider.cancel", () => {
  it("POSTs /requests/{id}/cancel and shrugs at requests past cancelling", async () => {
    const { higgsfield, calls } = provider(() => new Response(null, { status: 202 }));
    await higgsfield.cancel("req-1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE_URL}/requests/req-1/cancel`);
    expect(calls[0]!.headers.get("authorization")).toBe("Key kid:ksecret");

    await expect(
      provider(() => json({ detail: "already processing" }, 400)).higgsfield.cancel("req-1"),
    ).resolves.toBeUndefined();

    const error = await rejection(
      provider(() => new Response(null, { status: 500 })).higgsfield.cancel("req-1"),
    );
    expect(error.status).toBe(500);
  });
});

describe("HiggsfieldProvider transport", () => {
  it("times out a call that hangs", async () => {
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      });
    const higgsfield = new HiggsfieldProvider({
      keyId: "kid",
      keySecret: "ksecret",
      baseUrl: BASE_URL,
      imageModel: "m",
      videoModel: null,
      fetch: hang,
      timeoutMs: 25,
    });
    const error = await rejection(higgsfield.status("req-1"));
    expect(error.message).toBe("Higgsfield status timed out after 25 ms");
    expect(error.retryable).toBe(true);
  });

  it("wraps network failures as retryable errors", async () => {
    const offline: typeof globalThis.fetch = () => Promise.reject(new TypeError("fetch failed"));
    const higgsfield = new HiggsfieldProvider({
      keyId: "kid",
      keySecret: "ksecret",
      baseUrl: BASE_URL,
      imageModel: "m",
      videoModel: null,
      fetch: offline,
    });
    const error = await rejection(higgsfield.submit(request()));
    expect(error.message).toBe("Higgsfield submit failed: fetch failed");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});
