import { describe, expect, it } from "vitest";
import {
  DryRunPublisher,
  META_DIALOG_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_VERSION,
  META_RUPLOAD_DEFAULT_BASE_URL,
  MetaPublisher,
  PublishError,
  createPublisher,
  validatePublishPayload,
  type DecryptedAccount,
  type MetaConfig,
  type PublishPayload,
} from "../src";
import { toPublishError } from "../src/publish/meta-errors";
import { formatProgress, parseProgress } from "../src/publish/meta-progress";
import { isLoopbackUrl, isPublicHostname, isPublicHttpsUrl } from "../src/publish/public-url";

/*
 * MetaPublisher against the real Meta hosts through an injected fetch: what the loopback fake
 * server can't show (public media URLs, Graph's error table, transport failures, rupload's own
 * error shape). The full flows run against the fake Graph server in apps/api/test/contract.
 */

const meta: MetaConfig = {
  appId: "app",
  appSecret: "secret",
  graphVersion: META_GRAPH_DEFAULT_VERSION,
  graphBaseUrl: META_GRAPH_DEFAULT_BASE_URL,
  ruploadBaseUrl: META_RUPLOAD_DEFAULT_BASE_URL,
  dialogBaseUrl: META_DIALOG_DEFAULT_BASE_URL,
};

const account: DecryptedAccount = {
  id: "acc_fb",
  platform: "FACEBOOK",
  externalId: "1001",
  handle: "Qahwa Co",
  accessToken: "page-token",
  meta: { pageId: "1001", pageName: "Qahwa Co", source: "oauth" },
};

function payload(overrides: Partial<PublishPayload> = {}): PublishPayload {
  return {
    platform: "FACEBOOK",
    postType: "STATIC",
    variantId: "var_1",
    caption: "The first sip after iftar.",
    altText: null,
    hashtags: [],
    media: [
      {
        kind: "IMAGE",
        url: "https://assets.enmo.marketing/clients/c1/assets/a1.png",
        width: 1080,
        height: 1920,
      },
    ],
    ...overrides,
  };
}

interface Recorded {
  url: URL;
  init: RequestInit;
}

/** A fetch answering each call with the next scripted response, recording what it was asked. */
function scriptedFetch(...responses: (Response | Error)[]) {
  const calls: Recorded[] = [];
  const fetch = (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : input), init });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error("no scripted response left"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function facebookPublisher(fetch: typeof globalThis.fetch) {
  return new MetaPublisher({ ...meta, platform: "FACEBOOK", fetch, timeoutMs: 1_000 });
}

async function publishError(promise: Promise<unknown>): Promise<PublishError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PublishError);
  return error as PublishError;
}

describe("media URLs", () => {
  it("must be public https for a live publish to the real Graph, checked before any call", async () => {
    const { calls, fetch } = scriptedFetch();
    const local = payload({
      media: [
        { kind: "IMAGE", url: "http://localhost:4000/files/a.png", width: 1080, height: 1920 },
      ],
      coverUrl: "https://10.0.0.8/cover.png",
    });
    const error = await publishError(
      facebookPublisher(fetch).publish(local, account, { containerId: null }),
    );
    expect(error.code).toBe("INVALID_PAYLOAD");
    expect(error.issues.map((issue) => issue.path)).toEqual(["media[0].url", "coverUrl"]);
    expect(calls).toEqual([]);
  });

  it("are not checked by the dry run, which runs on local storage", async () => {
    const local = payload({
      media: [
        { kind: "IMAGE", url: "http://localhost:4000/files/a.png", width: 1080, height: 1920 },
      ],
    });
    expect(validatePublishPayload(local)).toEqual([]);
    await expect(
      new DryRunPublisher("FACEBOOK", { latencyMs: 0 }).publish(local, null, { containerId: null }),
    ).resolves.toMatchObject({ status: "published" });
  });

  it("tells public hosts from loopback, private and reserved ones", () => {
    const publicHosts = ["assets.enmo.marketing", "8.8.8.8", "[2606:4700::1111]"];
    const privateHosts = [
      "localhost",
      "api.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "[::1]",
      "[fd00::1]",
      "[::ffff:192.168.0.1]",
      "minio",
      "assets.enmo.test",
      "nas.local",
      "files.internal",
    ];
    for (const host of publicHosts) expect(isPublicHostname(host), host).toBe(true);
    for (const host of privateHosts) expect(isPublicHostname(host), host).toBe(false);
    expect(isPublicHttpsUrl("http://assets.enmo.marketing/a.png")).toBe(false);
    expect(isPublicHttpsUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1:9999")).toBe(true);
    expect(isLoopbackUrl("https://graph.facebook.com")).toBe(false);
  });
});

describe("Graph calls", () => {
  it("carry the token in the header, an appsecret_proof and a JSON body", async () => {
    const { calls, fetch } = scriptedFetch(
      json({ id: "5001", post_id: "1001_7001" }),
      json({ permalink_url: "https://www.facebook.com/1001/posts/7001" }),
    );
    const outcome = await facebookPublisher(fetch).publish(payload(), account, {
      containerId: null,
    });
    expect(outcome).toEqual({
      status: "published",
      externalId: "1001_7001",
      liveUrl: "https://www.facebook.com/1001/posts/7001",
    });
    const [photo] = calls;
    expect(photo?.url.origin + photo!.url.pathname).toBe(
      "https://graph.facebook.com/v26.0/1001/photos",
    );
    expect(photo?.url.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
    expect(photo?.url.searchParams.has("access_token")).toBe(false);
    expect(photo?.init.headers).toMatchObject({
      Authorization: "OAuth page-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(photo?.init.body as string)).toEqual({
      url: payload().media[0]!.url,
      message: "The first sip after iftar.",
      published: true,
    });
  });

  it("upload reels to rupload with the version after the endpoint", async () => {
    const { calls, fetch } = scriptedFetch(
      json({ video_id: "9001" }),
      json({ success: true }),
      json({ success: true }),
      json({ status: { video_status: "processing" } }),
    );
    const reel = payload({
      postType: "REEL",
      media: [
        { kind: "VIDEO", url: "https://assets.enmo.marketing/v.mp4", width: 1080, height: 1920 },
      ],
    });
    const saved: string[] = [];
    const outcome = await facebookPublisher(fetch).publish(reel, account, {
      containerId: null,
      onContainer: (id) => {
        saved.push(id);
        return Promise.resolve();
      },
    });
    expect(outcome).toEqual({ status: "processing", containerId: "FB_REEL;items=9001;finished" });
    const upload = calls[1]!;
    expect(upload.url.toString()).toBe("https://rupload.facebook.com/video-upload/v26.0/9001");
    expect(upload.init.headers).toMatchObject({
      Authorization: "OAuth page-token",
      file_url: "https://assets.enmo.marketing/v.mp4",
    });
    expect(upload.init.body).toBeUndefined();
    expect(saved).toEqual(["FB_REEL;items=9001", "FB_REEL;items=9001;finished"]);
  });

  it("turn rupload's own refusal into MEDIA_FAILED, and its retriable one into UNAVAILABLE", async () => {
    const reel = payload({
      postType: "REEL",
      media: [
        { kind: "VIDEO", url: "https://assets.enmo.marketing/v.mp4", width: 1080, height: 1920 },
      ],
    });
    const refusal = (retriable: boolean) =>
      json({ debug_info: { retriable, type: "ProcessingFailedError", message: "Bad file" } }, 400);

    const permanent = scriptedFetch(json({ video_id: "9001" }), refusal(false));
    expect(
      await publishError(
        facebookPublisher(permanent.fetch).publish(reel, account, { containerId: null }),
      ),
    ).toMatchObject({ code: "MEDIA_FAILED", retryable: false });

    const transient = scriptedFetch(json({ video_id: "9001" }), refusal(true));
    expect(
      await publishError(
        facebookPublisher(transient.fetch).publish(reel, account, { containerId: null }),
      ),
    ).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  });

  it("never retry a 2xx answer they can't read, since the post may already exist", async () => {
    // A call that publishes nothing (a reel's upload session): refused for good, nothing to check.
    const reel = payload({
      postType: "REEL",
      media: [
        { kind: "VIDEO", url: "https://assets.enmo.marketing/v.mp4", width: 1080, height: 1920 },
      ],
    });
    const session = scriptedFetch(json({ upload_url: "no video_id" }));
    expect(
      await publishError(
        facebookPublisher(session.fetch).publish(reel, account, { containerId: null }),
      ),
    ).toMatchObject({ code: "REJECTED", retryable: false });
  });

  it("keep the posting mark when the call that publishes answers 2xx unreadably: check the Page first", async () => {
    const photos = payload({
      postType: "CAROUSEL",
      media: [1, 2].map((i) => ({
        kind: "IMAGE" as const,
        url: `https://assets.enmo.marketing/clients/c1/assets/a${i}.png`,
        width: 1080,
        height: 1920,
      })),
    });
    const cases = [
      // A proxy's HTML page instead of Graph's JSON.
      {
        flow: payload(),
        responses: [new Response("<html>ok</html>", { status: 200 })],
        marked: "FB_PHOTO;posting",
      },
      // Graph's JSON without the post's id.
      { flow: payload(), responses: [json({ success: true })], marked: "FB_PHOTO;posting" },
      {
        flow: photos,
        responses: [json({ id: "301" }), json({ id: "302" }), json({})],
        marked: "FB_MULTI_PHOTO;items=301,302;posting",
      },
      {
        flow: payload({ postType: "STORY" }),
        responses: [json({ id: "301" }), json({ success: true })],
        marked: "FB_PHOTO_STORY;items=301;posting",
      },
    ];
    for (const { flow, responses, marked } of cases) {
      const saved: string[] = [];
      const { fetch } = scriptedFetch(...responses);
      const error = await publishError(
        facebookPublisher(fetch).publish(flow, account, {
          containerId: null,
          onContainer: (id) => {
            saved.push(id);
            return Promise.resolve();
          },
        }),
      );
      expect(error).toMatchObject({ code: "UNCONFIRMED", retryable: false });
      expect(error.message).toMatch(
        /^Meta answered .*may have published the .+ anyway.*check the Page/,
      );
      // The mark stays: a resume stops rather than posting it a second time.
      expect(saved.at(-1)).toBe(marked);
    }
  });

  it("take the posting mark back on a clear refusal, which created nothing", async () => {
    const refusals = [
      { flow: payload(), responses: [json({ error: { message: "No", code: 100 } }, 400)] },
      // A story Meta answers `success: false` for, in a 2xx.
      {
        flow: payload({ postType: "STORY" }),
        responses: [json({ id: "301" }), json({ success: false, post_id: "1001_1" })],
      },
    ];
    for (const { flow, responses } of refusals) {
      const saved: string[] = [];
      const { fetch } = scriptedFetch(...responses);
      const error = await publishError(
        facebookPublisher(fetch).publish(flow, account, {
          containerId: null,
          onContainer: (id) => {
            saved.push(id);
            return Promise.resolve();
          },
        }),
      );
      expect(error).toMatchObject({ code: "REJECTED", retryable: false });
      expect(saved.at(-2)).toMatch(/;posting$/);
      expect(saved.at(-1)).not.toMatch(/posting/);
    }
  });

  it("treat network failures and timeouts as UNAVAILABLE", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    // A reel's first call only opens an upload session: nothing public, safe to repeat.
    const reel = payload({
      postType: "REEL",
      media: [
        { kind: "VIDEO", url: "https://assets.enmo.marketing/v.mp4", width: 1080, height: 1920 },
      ],
    });
    for (const failure of [new TypeError("fetch failed"), timeout]) {
      const { fetch } = scriptedFetch(failure);
      const error = await publishError(
        facebookPublisher(fetch).publish(reel, account, { containerId: null }),
      );
      expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true, status: null });
    }
  });

  it("never retry an outage on the call that publishes a Facebook post, which may have gone out", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    const unavailable = () => json({ error: { message: "Try later", code: 2 } }, 500);
    const photos = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "IMAGE" as const,
        url: `https://assets.enmo.marketing/clients/c1/assets/a${i + 1}.png`,
        width: 1080,
        height: 1920,
      }));
    const cases = [
      { flow: payload(), responses: [new TypeError("fetch failed")], call: "photos" },
      { flow: payload(), responses: [timeout], call: "photos" },
      { flow: payload(), responses: [unavailable()], call: "photos" },
      {
        flow: payload({ postType: "CAROUSEL", media: photos(2) }),
        responses: [json({ id: "301" }), json({ id: "302" }), unavailable()],
        call: "feed",
      },
      {
        flow: payload({ postType: "STORY" }),
        responses: [json({ id: "301" }), timeout],
        call: "photo_stories",
      },
    ];
    for (const { flow, responses, call } of cases) {
      const { fetch, calls } = scriptedFetch(...responses);
      const error = await publishError(
        facebookPublisher(fetch).publish(flow, account, { containerId: null }),
      );
      expect(calls.at(-1)?.url.pathname).toBe(`/v26.0/1001/${call}`);
      expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: false });
      expect(error.message).toMatch(/may have published the .+ anyway.*check the Page/);
    }

    // A clear refusal means nothing was created: a rate limit is still retried.
    const { fetch } = scriptedFetch(json({ error: { message: "Slow down", code: 32 } }, 400));
    expect(
      await publishError(
        facebookPublisher(fetch).publish(payload(), account, { containerId: null }),
      ),
    ).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });
});

describe("Graph errors", () => {
  const graphError = (status: number, error: Record<string, unknown>) =>
    json({ error: { message: "Graph says no", type: "OAuthException", ...error } }, status);

  it.each([
    [400, { code: 190, error_subcode: 463 }, "AUTH"],
    [400, { code: 10 }, "AUTH"],
    [403, { code: 200 }, "AUTH"],
    [400, { code: 4 }, "RATE_LIMITED"],
    [400, { code: 32 }, "RATE_LIMITED"],
    [400, { code: 80002 }, "RATE_LIMITED"],
    [400, { code: 9, error_subcode: 2207042 }, "RATE_LIMITED"],
    [429, { code: 1234 }, "RATE_LIMITED"],
    [500, { code: 2 }, "UNAVAILABLE"],
    [400, { code: 1, is_transient: true }, "UNAVAILABLE"],
    [400, { code: 9004 }, "MEDIA_FAILED"],
    [400, { code: 100, error_subcode: 2207026 }, "MEDIA_FAILED"],
    [400, { code: 6000, error_subcode: 1363030 }, "MEDIA_FAILED"],
    [400, { code: 100 }, "REJECTED"],
    [400, { code: 368 }, "REJECTED"],
  ] as const)("HTTP %i %o is %s", async (status, error, code) => {
    const { fetch } = scriptedFetch(graphError(status, error));
    const failure = await publishError(
      facebookPublisher(fetch).publish(payload(), account, { containerId: null }),
    );
    expect(failure.code).toBe(code);
    expect(failure.status).toBe(status);
    expect(failure.message).toContain("POST /v26.0/1001/photos");
    expect(failure.message).not.toContain("appsecret_proof");
  });

  it("keeps PublishErrors as they are", () => {
    const original = new PublishError("AUTH", "no");
    expect(toPublishError(original)).toBe(original);
  });
});

describe("progress in PublishJob.containerId", () => {
  it("round-trips every stage", () => {
    const progress = {
      flow: "IG_CAROUSEL" as const,
      items: ["17890000000000001", "17890000000000002"],
      parent: "17890000000000003",
      finished: false,
      posting: false,
      result: "17900000000000001",
    };
    const text = formatProgress(progress);
    expect(text).toBe(
      "IG_CAROUSEL;items=17890000000000001,17890000000000002;parent=17890000000000003;result=17900000000000001",
    );
    expect(parseProgress(text)).toEqual(progress);
    expect(parseProgress("FB_REEL;items=9001;finished")).toMatchObject({
      flow: "FB_REEL",
      items: ["9001"],
      finished: true,
    });
    expect(parseProgress("FB_PHOTO;result=1001_7001")).toMatchObject({ result: "1001_7001" });
    // A Facebook post whose publishing call went out unanswered.
    const posting = { ...progress, flow: "FB_MULTI_PHOTO" as const, parent: null, result: null };
    const marked = formatProgress({ ...posting, posting: true });
    expect(marked).toBe("FB_MULTI_PHOTO;items=17890000000000001,17890000000000002;posting");
    expect(parseProgress(marked)).toEqual({ ...posting, posting: true });
  });

  it("rejects anything that isn't one of ours", () => {
    for (const bad of [
      "",
      "17890000000000001",
      "TIKTOK_VIDEO;items=1",
      "IG_IMAGE;items=",
      "IG_IMAGE;items=1;items=2",
      "IG_IMAGE;parent",
      "IG_IMAGE;finished=yes",
      "FB_PHOTO;posting=1",
      "IG_IMAGE;items=1 2",
      "IG_IMAGE;owner=1",
    ]) {
      expect(parseProgress(bad), bad).toBeNull();
    }
  });
});

describe("createPublisher", () => {
  it("builds the live Meta publisher with the injected fetch", async () => {
    const { calls, fetch } = scriptedFetch(json({ id: "5001", post_id: "1001_7001" }), json({}));
    const publisher = createPublisher("FACEBOOK", { mode: "live", meta }, { fetch });
    expect(publisher).toBeInstanceOf(MetaPublisher);
    await expect(publisher.publish(payload(), account, { containerId: null })).resolves.toEqual({
      status: "published",
      externalId: "1001_7001",
      liveUrl: "https://www.facebook.com/1001_7001",
    });
    expect(calls).toHaveLength(2);
  });
});
