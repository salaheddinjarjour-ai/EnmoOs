import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DryRunPublisher,
  META_DIALOG_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_BASE_URL,
  META_GRAPH_DEFAULT_VERSION,
  META_RUPLOAD_DEFAULT_BASE_URL,
  MetaOAuthProvider,
  MetaPublisher,
  PublishError,
  createMetaOAuthProvider,
  createOAuthState,
  createPkcePair,
  createPublisher,
  dryRunLiveUrl,
  isDryRunPublish,
  livePublishingAvailable,
  metaConfigured,
  metaUrl,
  publishFlowOf,
  validatePublishPayload,
  type MetaConfig,
  type PublishMedia,
  type PublishPayload,
  type PublisherConfig,
} from "../src";

const meta: MetaConfig = {
  appId: null,
  appSecret: null,
  graphVersion: META_GRAPH_DEFAULT_VERSION,
  graphBaseUrl: META_GRAPH_DEFAULT_BASE_URL,
  ruploadBaseUrl: META_RUPLOAD_DEFAULT_BASE_URL,
  dialogBaseUrl: META_DIALOG_DEFAULT_BASE_URL,
};
const withApp: MetaConfig = { ...meta, appId: "app", appSecret: "secret" };

/** A 4:5 JPEG: what Instagram's feed takes (and every other platform too). */
const image = (n = 1): PublishMedia => ({
  kind: "IMAGE",
  url: `https://assets.enmo.marketing/clients/c1/assets/a${n}-instagram-1080x1350.jpg`,
  width: 1080,
  height: 1350,
  mimeType: "image/jpeg",
});
/** A Phase 3 master as rendered: a 9:16 PNG. */
const master: PublishMedia = {
  kind: "IMAGE",
  url: "https://assets.enmo.marketing/clients/c1/assets/a1.png",
  width: 1080,
  height: 1920,
  mimeType: "image/png",
};
const video: PublishMedia = {
  kind: "VIDEO",
  url: "https://assets.enmo.marketing/clients/c1/assets/v1.mp4",
  width: 1080,
  height: 1920,
  durationSec: 14,
};

function payload(overrides: Partial<PublishPayload> = {}): PublishPayload {
  return {
    platform: "INSTAGRAM",
    postType: "STATIC",
    variantId: "var_1",
    caption: "The first sip after iftar.",
    altText: "Iced coffee on a dark table",
    hashtags: ["#iced", "ramadan"],
    media: [image()],
    ...overrides,
  };
}

describe("createPublisher", () => {
  it("publishes live only in live mode with Meta credentials", () => {
    const dry: PublisherConfig = { mode: "dry-run", meta: withApp };
    const live: PublisherConfig = { mode: "live", meta: withApp };
    const liveNoApp: PublisherConfig = { mode: "live", meta };

    expect(createPublisher("INSTAGRAM", dry)).toBeInstanceOf(DryRunPublisher);
    expect(createPublisher("INSTAGRAM", liveNoApp)).toBeInstanceOf(DryRunPublisher);
    const ig = createPublisher("INSTAGRAM", live, { fetch: () => Promise.reject(new Error("x")) });
    expect(ig).toBeInstanceOf(MetaPublisher);
    expect([ig.platform, ig.mode]).toEqual(["INSTAGRAM", "live"]);
    expect(createPublisher("FACEBOOK", live)).toBeInstanceOf(MetaPublisher);
    // TikTok publishes for real from Phase 5.
    expect(createPublisher("TIKTOK", live)).toBeInstanceOf(DryRunPublisher);

    expect(livePublishingAvailable("FACEBOOK", live)).toBe(true);
    expect(livePublishingAvailable("FACEBOOK", liveNoApp)).toBe(false);
    expect(isDryRunPublish("INSTAGRAM", live, true)).toBe(false);
    expect(isDryRunPublish("INSTAGRAM", live, false)).toBe(true);
    expect(isDryRunPublish("INSTAGRAM", dry, true)).toBe(true);
    expect(metaConfigured(meta)).toBe(false);
  });
});

describe("DryRunPublisher", () => {
  it("validates, then answers with a simulated live URL", async () => {
    const publisher = new DryRunPublisher("INSTAGRAM");
    const outcome = await publisher.publish(payload(), null, { containerId: null });
    expect(outcome).toEqual({
      status: "published",
      externalId: "dryrun_var_1",
      liveUrl: "https://dryrun.enmo.marketing/instagram/var_1",
    });
    await expect(publisher.poll("c1", null, payload())).resolves.toEqual(outcome);
    expect(dryRunLiveUrl("TIKTOK", "a/b")).toBe("https://dryrun.enmo.marketing/tiktok/a%2Fb");
  });

  it("refuses what the platform would refuse", async () => {
    const publisher = new DryRunPublisher("INSTAGRAM");
    const error = await publisher
      .publish(payload({ postType: "REEL", media: [image()] }), null, { containerId: null })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublishError);
    expect(error).toMatchObject({ code: "INVALID_PAYLOAD", retryable: false });
    expect((error as PublishError).issues).toEqual([
      { path: "media[0].kind", message: "A reel takes VIDEO, not IMAGE." },
    ]);
    await expect(
      publisher.publish(payload({ platform: "FACEBOOK" }), null, { containerId: null }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });
});

describe("validatePublishPayload", () => {
  it("accepts each native post shape", () => {
    const valid: PublishPayload[] = [
      payload(),
      payload({ postType: "REEL", media: [video], coverUrl: image().url }),
      payload({ postType: "STORY", media: [video] }),
      payload({ postType: "CAROUSEL", media: [image(1), video, image(3)] }),
      payload({ platform: "FACEBOOK", postType: "CAROUSEL", media: [image(1), image(2)] }),
      payload({ platform: "FACEBOOK", postType: "STORY", media: [image()] }),
      payload({ platform: "TIKTOK", postType: "TIKTOK", media: [video] }),
      payload({ platform: "TIKTOK", postType: "CAROUSEL", media: [image(1), image(2)] }),
    ];
    for (const value of valid) expect(validatePublishPayload(value), value.postType).toEqual([]);
  });

  it("maps post types to platform flows", () => {
    expect(
      [
        payload(),
        payload({ postType: "TIKTOK", media: [video] }),
        payload({ platform: "FACEBOOK", postType: "STORY", media: [video] }),
        payload({ platform: "FACEBOOK", postType: "STORY" }),
        payload({ platform: "FACEBOOK", postType: "CAROUSEL" }),
        payload({ platform: "TIKTOK", postType: "STATIC" }),
      ].map(publishFlowOf),
    ).toEqual([
      "IG_IMAGE",
      "IG_REEL",
      "FB_VIDEO_STORY",
      "FB_PHOTO_STORY",
      "FB_MULTI_PHOTO",
      "TIKTOK_PHOTO",
    ]);
  });

  it("checks captions and hashtags as published", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `tag${i}`);
    expect(validatePublishPayload(payload({ hashtags: tags }))).toEqual([
      { path: "hashtags", message: "31 hashtags; the platform takes 30." },
    ]);
    expect(validatePublishPayload(payload({ platform: "FACEBOOK", hashtags: tags }))).toEqual([]);
    const long = validatePublishPayload(payload({ caption: "x".repeat(2195), hashtags: ["iced"] }));
    expect(long.map((issue) => issue.path)).toEqual(["caption"]);
  });

  it("checks media counts, kinds and durations", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => image(i));
    expect(validatePublishPayload(payload({ postType: "CAROUSEL", media: eleven }))).toEqual([
      { path: "media", message: "A carousel takes 2 to 10 media files, not 11." },
    ]);
    expect(
      validatePublishPayload(
        payload({ platform: "FACEBOOK", postType: "CAROUSEL", media: [image(), video] }),
      ),
    ).toEqual([{ path: "media[1].kind", message: "A carousel takes IMAGE, not VIDEO." }]);
    expect(
      validatePublishPayload(
        payload({
          platform: "FACEBOOK",
          postType: "REEL",
          media: [{ ...video, durationSec: 120 }],
        }),
      ),
    ).toEqual([
      { path: "media[0].durationSec", message: "A reel's video must run 3–90s, not 120s." },
    ]);
    expect(
      validatePublishPayload(payload({ postType: "STATIC", media: [image(1), image(2)] })),
    ).toEqual([
      { path: "media", message: "A single-image post takes exactly 1 media file, not 2." },
    ]);
  });

  it("takes Instagram images as JPEG only, and feed images from 4:5 to 1.91:1", () => {
    const paths = (value: PublishPayload) =>
      validatePublishPayload(value).map((issue) => issue.path);
    expect(paths(payload({ media: [master] }))).toEqual(["media[0].mimeType", "media[0]"]);
    expect(validatePublishPayload(payload({ media: [master] }))[1]!.message).toBe(
      "A feed image must be 0.80:1 to 1.91:1 (width to height); 1080×1920 is 0.56:1.",
    );
    expect(
      paths(payload({ postType: "CAROUSEL", media: [image(1), { ...image(2), height: 1351 }] })),
    ).toEqual(["media[1]"]);
    expect(paths(payload({ media: [{ ...image(), width: 1910, height: 1000 }] }))).toEqual([]);
    // A story is full-screen: 9:16 is fine, PNG isn't.
    expect(
      paths(payload({ postType: "STORY", media: [{ ...master, mimeType: "image/jpeg" }] })),
    ).toEqual([]);
    expect(paths(payload({ postType: "STORY", media: [master] }))).toEqual(["media[0].mimeType"]);
    // Undeclared, the type follows the URL's extension.
    const { mimeType: _, ...undeclared } = master;
    expect(validatePublishPayload(payload({ postType: "STORY", media: [undeclared] }))).toEqual([
      {
        path: "media[0].mimeType",
        message: "The platform fetches images as image/jpeg only, not image/png.",
      },
    ]);
    // Facebook and TikTok take the master as it is.
    expect(paths(payload({ platform: "FACEBOOK", media: [master] }))).toEqual([]);
    expect(paths(payload({ platform: "TIKTOK", media: [master] }))).toEqual([]);
  });

  it("rejects malformed payloads with zod paths", () => {
    const issues = validatePublishPayload({
      ...payload(),
      platform: "TIKTOK",
      postType: "STORY",
      media: [{ ...image(), url: "/files/a.png" }],
    });
    expect(issues.map((issue) => issue.path).sort()).toEqual(["media[0].url", "postType"]);
    expect(validatePublishPayload({ ...payload(), media: [] })).toHaveLength(1);
  });
});

describe("Meta plumbing", () => {
  it("builds Graph URLs on an overridable base", () => {
    expect(
      metaUrl("http://127.0.0.1:9999/", "v26.0", "/123/media", { fields: "id,permalink" }),
    ).toBe("http://127.0.0.1:9999/v26.0/123/media?fields=id%2Cpermalink");
  });

  it("makes OAuth state and S256 PKCE pairs", () => {
    const pair = createPkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.codeChallenge).toBe(
      createHash("sha256").update(pair.codeVerifier).digest("base64url"),
    );
    expect(createOAuthState()).not.toBe(createOAuthState());
  });

  it("builds the Meta OAuth provider without I/O", () => {
    const provider = createMetaOAuthProvider({
      ...meta,
      redirectUri: "http://localhost:4000/v1/oauth/meta/callback",
    });
    expect(provider).toBeInstanceOf(MetaOAuthProvider);
    expect(provider.name).toBe("meta");
  });
});
