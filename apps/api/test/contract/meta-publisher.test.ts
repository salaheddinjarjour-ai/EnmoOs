import { createHmac } from "node:crypto";
import {
  MetaPublisher,
  PublishError,
  createPublisher,
  type DecryptedAccount,
  type PublishMedia,
  type PublishOutcome,
  type PublishPayload,
  type PublishResume,
  type Publisher,
} from "@enmo/providers";
import type { Platform } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { publisherConfigFrom } from "../../src/deps";
import {
  FAKE_META_APP,
  FAKE_META_PAGES,
  GRAPH_ERRORS,
  fakeGraphEnv,
  startFakeGraph,
  type FakeGraph,
} from "../fakes/meta-graph";

/*
 * The real MetaPublisher (DESIGN §F "Meta") against the fake Graph server: the exact call sequence
 * and request shapes of every Instagram and Facebook flow, resuming persisted containers, and how
 * Graph's failures become PublishErrors the publish service can act on.
 */

let graph: FakeGraph;

beforeAll(async () => {
  graph = await startFakeGraph();
});

afterAll(async () => {
  await graph.close();
});

beforeEach(() => {
  graph.reset();
});

const PAGE = FAKE_META_PAGES[0]!;
const IG_USER = PAGE.instagram!.id;
const TOKEN = PAGE.accessToken;
const V = "/v26.0";

const instagram: DecryptedAccount = {
  id: "acc_ig",
  platform: "INSTAGRAM",
  externalId: IG_USER,
  handle: "qahwa.co",
  accessToken: TOKEN,
  meta: {
    pageId: PAGE.id,
    pageName: PAGE.name,
    igUserId: IG_USER,
    username: "qahwa.co",
    source: "oauth",
  },
};

const facebook: DecryptedAccount = {
  id: "acc_fb",
  platform: "FACEBOOK",
  externalId: PAGE.id,
  handle: PAGE.name,
  accessToken: TOKEN,
  meta: { pageId: PAGE.id, pageName: PAGE.name, source: "oauth" },
};

function publisherFor(platform: Platform): Publisher {
  const config = loadConfig({ NODE_ENV: "test", PUBLISH_MODE: "live", ...fakeGraphEnv(graph.url) });
  const publisher = createPublisher(platform, publisherConfigFrom(config));
  expect(publisher).toBeInstanceOf(MetaPublisher);
  return publisher;
}

const image = (n = 1): PublishMedia => ({
  kind: "IMAGE",
  url: `https://assets.enmo.marketing/clients/c1/assets/a${n}.png`,
  width: 1080,
  height: 1920,
});
const video: PublishMedia = {
  kind: "VIDEO",
  url: "https://assets.enmo.marketing/clients/c1/assets/v1.mp4",
  width: 1080,
  height: 1920,
  durationSec: 14,
};
const CAPTION = "The first sip after iftar.\n\n#iced #ramadan";

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

/** A resume that records every container the publisher persists. */
function resumable(containerId: string | null = null): PublishResume & { saved: string[] } {
  const saved: string[] = [];
  return {
    containerId,
    saved,
    onContainer: (id) => {
      saved.push(id);
      return Promise.resolve();
    },
  };
}

const ids = {
  containers: () => [...graph.state.containers.keys()],
  media: () => [...graph.state.media.keys()],
  photos: () => [...graph.state.photos.keys()],
  videos: () => [...graph.state.videos.keys()],
  posts: () => [...graph.state.posts.keys()],
};

function bodyOf(call: number): unknown {
  return graph.calls[call]?.body;
}

async function failure(promise: Promise<unknown>): Promise<PublishError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PublishError);
  return error as PublishError;
}

function published(outcome: PublishOutcome) {
  expect(outcome.status).toBe("published");
  return outcome as Extract<PublishOutcome, { status: "published" }>;
}

/** The container id a `processing` outcome says to poll. */
function processingId(outcome: PublishOutcome): string {
  if (outcome.status !== "processing")
    throw new Error(`Expected processing, got ${outcome.status}`);
  return outcome.containerId;
}

describe("Instagram", () => {
  it("publishes an image: quota, container, status, media_publish, permalink", async () => {
    const resume = resumable();
    const outcome = await publisherFor("INSTAGRAM").publish(payload(), instagram, resume);

    const [container] = ids.containers();
    const [media] = ids.media();
    expect(graph.sequence()).toEqual([
      `GET ${V}/${IG_USER}/content_publishing_limit`,
      `POST ${V}/${IG_USER}/media`,
      `GET ${V}/${container}`,
      `POST ${V}/${IG_USER}/media_publish`,
      `GET ${V}/${media}`,
    ]);
    expect(bodyOf(1)).toEqual({
      image_url: image().url,
      caption: CAPTION,
      alt_text: "Iced coffee on a dark table",
    });
    expect(graph.calls[0]?.query).toMatchObject({ fields: "quota_usage,config" });
    expect(graph.calls[2]?.query).toMatchObject({ fields: "status_code,status" });
    expect(bodyOf(3)).toEqual({ creation_id: container });
    expect(graph.calls[4]?.query).toMatchObject({ fields: "permalink" });
    expect(outcome).toEqual({
      status: "published",
      externalId: media,
      liveUrl: graph.state.media.get(media!)!.permalink,
    });
    expect(resume.saved).toEqual([
      `IG_IMAGE;items=${container}`,
      `IG_IMAGE;items=${container};result=${media}`,
    ]);
    expect(graph.state.quotaUsage).toBe(1);
  });

  it("sends the page token in the header with an appsecret_proof, never in the URL", async () => {
    await publisherFor("INSTAGRAM").publish(payload(), instagram, resumable());
    const proof = createHmac("sha256", FAKE_META_APP.appSecret).update(TOKEN).digest("hex");
    for (const call of graph.calls) {
      expect(call.headers.authorization).toBe(`OAuth ${TOKEN}`);
      expect(call.query.appsecret_proof).toBe(proof);
      expect(call.query.access_token).toBeUndefined();
    }
  });

  it("answers processing while a reel's container runs, then publishes it from poll()", async () => {
    graph.state.containerPolls = 2;
    const publisher = publisherFor("INSTAGRAM");
    const reel = payload({ postType: "REEL", media: [video], coverUrl: image(9).url });

    const first = await publisher.publish(reel, instagram, resumable());
    const [container] = ids.containers();
    expect(first).toEqual({ status: "processing", containerId: `IG_REEL;items=${container}` });
    expect(bodyOf(1)).toEqual({
      media_type: "REELS",
      video_url: video.url,
      caption: CAPTION,
      share_to_feed: true,
      cover_url: image(9).url,
    });

    graph.calls.length = 0;
    await expect(publisher.poll(`IG_REEL;items=${container}`, instagram, reel)).resolves.toEqual(
      first,
    );
    const done = published(await publisher.poll(`IG_REEL;items=${container}`, instagram, reel));
    const [media] = ids.media();
    expect(graph.sequence()).toEqual([
      `GET ${V}/${container}`,
      `GET ${V}/${container}`,
      `POST ${V}/${IG_USER}/media_publish`,
      `GET ${V}/${media}`,
    ]);
    expect(done.liveUrl).toMatch(/^https:\/\/www\.instagram\.com\/reel\//);
  });

  it("resumes a persisted container instead of creating another one", async () => {
    graph.failNext({
      match: /media_publish$/,
      status: 400,
      error: GRAPH_ERRORS.appRateLimited,
    });
    const publisher = publisherFor("INSTAGRAM");
    const resume = resumable();
    const error = await failure(publisher.publish(payload(), instagram, resume));
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    const [container] = ids.containers();
    expect(resume.saved).toEqual([`IG_IMAGE;items=${container}`]);

    graph.calls.length = 0;
    const outcome = await publisher.publish(payload(), instagram, resumable(resume.saved[0]));
    expect(published(outcome).externalId).toBe(ids.media()[0]);
    expect(graph.sequence()).not.toContain(`POST ${V}/${IG_USER}/media`);
    expect(ids.containers()).toEqual([container]);
  });

  it("posts a story without a caption, from an image or a video", async () => {
    const publisher = publisherFor("INSTAGRAM");
    await publisher.publish(payload({ postType: "STORY" }), instagram, resumable());
    await publisher.publish(payload({ postType: "STORY", media: [video] }), instagram, resumable());
    const creates = graph.calls.filter((call) => call.path === `${V}/${IG_USER}/media`);
    expect(creates.map((call) => call.body)).toEqual([
      { media_type: "STORIES", image_url: image().url },
      { media_type: "STORIES", video_url: video.url },
    ]);
    const [story] = ids.media();
    expect(graph.state.media.get(story!)?.permalink).toContain("/stories/qahwa.co/");
  });

  it("builds a carousel from its children, then publishes the parent", async () => {
    const resume = resumable();
    const carousel = payload({ postType: "CAROUSEL", media: [image(1), video, image(3)] });
    const outcome = published(await publisherFor("INSTAGRAM").publish(carousel, instagram, resume));

    const [c1, c2, c3, parent] = ids.containers();
    const [media] = ids.media();
    expect(graph.sequence()).toEqual([
      `GET ${V}/${IG_USER}/content_publishing_limit`,
      `POST ${V}/${IG_USER}/media`,
      `POST ${V}/${IG_USER}/media`,
      `POST ${V}/${IG_USER}/media`,
      `GET ${V}/${c1}`,
      `GET ${V}/${c2}`,
      `GET ${V}/${c3}`,
      `POST ${V}/${IG_USER}/media`,
      `GET ${V}/${parent}`,
      `POST ${V}/${IG_USER}/media_publish`,
      `GET ${V}/${media}`,
    ]);
    expect([bodyOf(1), bodyOf(2), bodyOf(3), bodyOf(7)]).toEqual([
      { image_url: image(1).url, is_carousel_item: true },
      { media_type: "VIDEO", video_url: video.url, is_carousel_item: true },
      { image_url: image(3).url, is_carousel_item: true },
      { media_type: "CAROUSEL", children: `${c1},${c2},${c3}`, caption: CAPTION },
    ]);
    expect(bodyOf(9)).toEqual({ creation_id: parent });
    expect(outcome.externalId).toBe(media);
    expect(resume.saved).toEqual([
      `IG_CAROUSEL;items=${c1}`,
      `IG_CAROUSEL;items=${c1},${c2}`,
      `IG_CAROUSEL;items=${c1},${c2},${c3}`,
      `IG_CAROUSEL;items=${c1},${c2},${c3};parent=${parent}`,
      `IG_CAROUSEL;items=${c1},${c2},${c3};parent=${parent};result=${media}`,
    ]);
  });

  it("waits for a carousel's children and parent across polls, never recreating them", async () => {
    graph.state.containerPolls = 1;
    const publisher = publisherFor("INSTAGRAM");
    const carousel = payload({ postType: "CAROUSEL", media: [image(1), image(2)] });

    const first = await publisher.publish(carousel, instagram, resumable());
    const [c1, c2] = ids.containers();
    expect(first).toEqual({ status: "processing", containerId: `IG_CAROUSEL;items=${c1},${c2}` });

    const second = await publisher.poll(`IG_CAROUSEL;items=${c1},${c2}`, instagram, carousel);
    const parent = ids.containers()[2];
    expect(second).toEqual({
      status: "processing",
      containerId: `IG_CAROUSEL;items=${c1},${c2};parent=${parent}`,
    });

    graph.calls.length = 0;
    const third = await publisher.poll(processingId(second), instagram, carousel);
    expect(published(third).externalId).toBe(ids.media()[0]);
    expect(graph.sequence()).toEqual([
      `GET ${V}/${parent}`,
      `POST ${V}/${IG_USER}/media_publish`,
      `GET ${V}/${ids.media()[0]}`,
    ]);
    expect(ids.containers()).toHaveLength(3);
  });

  it("refuses to create anything once the publishing quota is used up", async () => {
    graph.state.quotaUsage = 100;
    const error = await failure(
      publisherFor("INSTAGRAM").publish(payload(), instagram, resumable()),
    );
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(error.message).toContain("100 of 100 posts in the last 24 hours");
    expect(graph.sequence()).toEqual([`GET ${V}/${IG_USER}/content_publishing_limit`]);
  });

  it("reports the account's quota", async () => {
    graph.state.quotaUsage = 7;
    const publisher = publisherFor("INSTAGRAM");
    await expect(publisher.checkLimit!(instagram)).resolves.toEqual({
      used: 7,
      limit: 100,
      windowHours: 24,
    });
    expect(Reflect.has(publisherFor("FACEBOOK"), "checkLimit")).toBe(false);
  });

  it("fails with MEDIA_FAILED when Instagram can't process the media", async () => {
    graph.state.containerOutcome = "ERROR";
    const error = await failure(
      publisherFor("INSTAGRAM").publish(payload(), instagram, resumable()),
    );
    expect(error).toMatchObject({ code: "MEDIA_FAILED", retryable: false });
    expect(error.message).toContain("Media download has failed");
  });

  it("replaces a dead container when a retry resumes it, but not when polling", async () => {
    graph.state.containerOutcome = "EXPIRED";
    const publisher = publisherFor("INSTAGRAM");
    const resume = resumable();
    await failure(publisher.publish(payload(), instagram, resume));
    const [dead] = ids.containers();

    await expect(
      publisher.poll(`IG_IMAGE;items=${dead}`, instagram, payload()),
    ).rejects.toMatchObject({ code: "MEDIA_FAILED" });

    graph.state.containerOutcome = "FINISHED";
    graph.calls.length = 0;
    const retry = resumable(`IG_IMAGE;items=${dead}`);
    const outcome = await publisher.publish(payload(), instagram, retry);
    const fresh = ids.containers()[1];
    expect(published(outcome).externalId).toBe(ids.media()[0]);
    expect(graph.sequence().slice(0, 3)).toEqual([
      `GET ${V}/${dead}`,
      `GET ${V}/${IG_USER}/content_publishing_limit`,
      `POST ${V}/${IG_USER}/media`,
    ]);
    expect(retry.saved[0]).toBe(`IG_IMAGE;items=${fresh}`);
  });

  it("still reports the post live when its permalink can't be read", async () => {
    graph.failNext({
      match: /^GET \/v26\.0\/179\d+$/,
      status: 500,
      error: GRAPH_ERRORS.unavailable,
    });
    const outcome = await publisherFor("INSTAGRAM").publish(payload(), instagram, resumable());
    expect(outcome).toEqual({
      status: "published",
      externalId: ids.media()[0],
      liveUrl: "https://www.instagram.com/qahwa.co/",
    });
  });

  it("refuses a resume that doesn't match the post, before any call", async () => {
    const publisher = publisherFor("INSTAGRAM");
    await expect(
      publisher.publish(payload(), instagram, resumable("IG_REEL;items=1789")),
    ).rejects.toMatchObject({ code: "REJECTED", retryable: false });
    await expect(publisher.poll("not-a-container", instagram, payload())).rejects.toMatchObject({
      code: "REJECTED",
    });
    expect(graph.calls).toEqual([]);
  });
});

describe("Facebook", () => {
  it("publishes a photo post and reads its permalink", async () => {
    const resume = resumable();
    const outcome = await publisherFor("FACEBOOK").publish(
      payload({ platform: "FACEBOOK" }),
      facebook,
      resume,
    );
    const [post] = ids.posts();
    expect(graph.sequence()).toEqual([`POST ${V}/${PAGE.id}/photos`, `GET ${V}/${post}`]);
    expect(bodyOf(0)).toEqual({
      url: image().url,
      message: CAPTION,
      alt_text_custom: "Iced coffee on a dark table",
      published: true,
    });
    expect(graph.calls[1]?.query).toMatchObject({ fields: "permalink_url" });
    expect(outcome).toEqual({
      status: "published",
      externalId: post,
      liveUrl: graph.state.posts.get(post!)!.permalink,
    });
    expect(resume.saved).toEqual([`FB_PHOTO;result=${post}`]);
  });

  it("stages unpublished photos, then attaches them to one feed post", async () => {
    const resume = resumable();
    const carousel = payload({
      platform: "FACEBOOK",
      postType: "CAROUSEL",
      media: [image(1), image(2)],
    });
    const outcome = published(await publisherFor("FACEBOOK").publish(carousel, facebook, resume));
    const [p1, p2] = ids.photos();
    const [post] = ids.posts();
    expect(graph.sequence()).toEqual([
      `POST ${V}/${PAGE.id}/photos`,
      `POST ${V}/${PAGE.id}/photos`,
      `POST ${V}/${PAGE.id}/feed`,
      `GET ${V}/${post}`,
    ]);
    expect([bodyOf(0), bodyOf(1), bodyOf(2)]).toEqual([
      { url: image(1).url, published: false },
      { url: image(2).url, published: false },
      { message: CAPTION, attached_media: [{ media_fbid: p1 }, { media_fbid: p2 }] },
    ]);
    expect(outcome.externalId).toBe(post);
    expect(resume.saved).toEqual([
      `FB_MULTI_PHOTO;items=${p1}`,
      `FB_MULTI_PHOTO;items=${p1},${p2}`,
      `FB_MULTI_PHOTO;items=${p1},${p2};result=${post}`,
    ]);
  });

  it("uploads a reel through rupload's file_url, finishes it as PUBLISHED, then reads it", async () => {
    const resume = resumable();
    const reel = payload({ platform: "FACEBOOK", postType: "REEL", media: [video] });
    const outcome = await publisherFor("FACEBOOK").publish(reel, facebook, resume);
    const [videoId] = ids.videos();
    expect(graph.sequence()).toEqual([
      `POST ${V}/${PAGE.id}/video_reels`,
      `POST /video-upload/v26.0/${videoId}`,
      `POST ${V}/${PAGE.id}/video_reels`,
      `GET ${V}/${videoId}`,
    ]);
    expect(bodyOf(0)).toEqual({ upload_phase: "start" });
    expect(graph.calls[1]).toMatchObject({
      body: null,
      headers: { authorization: `OAuth ${TOKEN}`, file_url: video.url },
    });
    expect(graph.calls[1]?.query.appsecret_proof).toBeUndefined();
    expect(bodyOf(2)).toEqual({
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      description: CAPTION,
    });
    expect(graph.calls[3]?.query).toMatchObject({ fields: "status,permalink_url" });
    expect(outcome).toEqual({
      status: "published",
      externalId: videoId,
      liveUrl: `https://www.facebook.com/reel/${videoId}/`,
    });
    expect(resume.saved).toEqual([`FB_REEL;items=${videoId}`, `FB_REEL;items=${videoId};finished`]);
  });

  it("polls a reel that is still processing", async () => {
    graph.state.videoPolls = 1;
    const publisher = publisherFor("FACEBOOK");
    const reel = payload({ platform: "FACEBOOK", postType: "REEL", media: [video] });
    const first = await publisher.publish(reel, facebook, resumable());
    const [videoId] = ids.videos();
    expect(first).toEqual({
      status: "processing",
      containerId: `FB_REEL;items=${videoId};finished`,
    });

    graph.calls.length = 0;
    expect(published(await publisher.poll(processingId(first), facebook, reel)).externalId).toBe(
      videoId,
    );
    expect(graph.sequence()).toEqual([`GET ${V}/${videoId}`]);
  });

  it("resumes a reel where it stopped, uploading only a file that never arrived", async () => {
    const seeded = {
      pageId: PAGE.id,
      kind: "reel",
      description: null,
      pollsLeft: 0,
      outcome: "ready",
      postId: null,
    } as const;
    graph.state.videos.set("3020000000001", {
      ...seeded,
      id: "3020000000001",
      fileUrl: video.url,
      phase: "uploaded",
    });
    graph.state.videos.set("3020000000002", {
      ...seeded,
      id: "3020000000002",
      fileUrl: null,
      phase: "created",
    });
    const publisher = publisherFor("FACEBOOK");
    const reel = payload({ platform: "FACEBOOK", postType: "REEL", media: [video] });

    const uploaded = resumable("FB_REEL;items=3020000000001");
    expect(published(await publisher.publish(reel, facebook, uploaded)).externalId).toBe(
      "3020000000001",
    );
    expect(graph.sequence()).toEqual([
      `GET ${V}/3020000000001`,
      `POST ${V}/${PAGE.id}/video_reels`,
      `GET ${V}/3020000000001`,
    ]);
    expect(uploaded.saved).toEqual(["FB_REEL;items=3020000000001;finished"]);

    graph.calls.length = 0;
    await publisher.publish(reel, facebook, resumable("FB_REEL;items=3020000000002"));
    expect(graph.sequence()).toEqual([
      `GET ${V}/3020000000002`,
      `POST /video-upload/v26.0/3020000000002`,
      `POST ${V}/${PAGE.id}/video_reels`,
      `GET ${V}/3020000000002`,
    ]);
    expect(ids.videos()).toEqual(["3020000000001", "3020000000002"]);
  });

  it("posts a photo story from an unpublished photo", async () => {
    const story = payload({ platform: "FACEBOOK", postType: "STORY" });
    const outcome = published(await publisherFor("FACEBOOK").publish(story, facebook, resumable()));
    const [photo] = ids.photos();
    const [post] = ids.posts();
    expect(graph.sequence()).toEqual([
      `POST ${V}/${PAGE.id}/photos`,
      `POST ${V}/${PAGE.id}/photo_stories`,
      `GET ${V}/${post}`,
    ]);
    expect([bodyOf(0), bodyOf(1)]).toEqual([
      { url: image().url, published: false },
      { photo_id: photo },
    ]);
    expect(outcome.externalId).toBe(post);
  });

  it("posts a video story through video_stories", async () => {
    const story = payload({ platform: "FACEBOOK", postType: "STORY", media: [video] });
    const outcome = published(await publisherFor("FACEBOOK").publish(story, facebook, resumable()));
    const [videoId] = ids.videos();
    expect(graph.sequence()).toEqual([
      `POST ${V}/${PAGE.id}/video_stories`,
      `POST /video-upload/v26.0/${videoId}`,
      `POST ${V}/${PAGE.id}/video_stories`,
      `GET ${V}/${videoId}`,
    ]);
    expect(bodyOf(2)).toEqual({ upload_phase: "finish", video_id: videoId });
    expect(outcome.externalId).toBe(graph.state.videos.get(videoId!)?.postId);
  });

  it("fails with MEDIA_FAILED when Facebook can't process the video", async () => {
    graph.state.videoOutcome = "error";
    const reel = payload({ platform: "FACEBOOK", postType: "REEL", media: [video] });
    const error = await failure(publisherFor("FACEBOOK").publish(reel, facebook, resumable()));
    expect(error).toMatchObject({ code: "MEDIA_FAILED", retryable: false });
    expect(error.message).toContain("could not be decoded");
  });
});

describe("failures", () => {
  it("is AUTH when the token is invalid or lacks the publishing scope", async () => {
    graph.state.invalidTokens.add(TOKEN);
    await expect(
      publisherFor("INSTAGRAM").publish(payload(), instagram, resumable()),
    ).rejects.toMatchObject({ code: "AUTH", retryable: false, status: 400 });

    graph.reset();
    graph.state.tokens.set(TOKEN, {
      type: "PAGE",
      subjectId: PAGE.id,
      userId: graph.state.user.id,
      scopes: ["pages_show_list"],
      expiresAt: 0,
    });
    await expect(
      publisherFor("FACEBOOK").publish(payload({ platform: "FACEBOOK" }), facebook, resumable()),
    ).rejects.toMatchObject({ code: "AUTH", status: 403 });
  });

  it("retries rate limits and outages, and rejects other refusals for good", async () => {
    const publisher = publisherFor("FACEBOOK");
    const attempt = () =>
      failure(publisher.publish(payload({ platform: "FACEBOOK" }), facebook, resumable()));

    graph.failNext({ match: /photos$/, status: 400, error: GRAPH_ERRORS.pageRateLimited });
    expect(await attempt()).toMatchObject({ code: "RATE_LIMITED", retryable: true });

    // An outage creating an Instagram container is retried: a container isn't public.
    graph.failNext({ match: /\/media$/, status: 500, error: GRAPH_ERRORS.unavailable });
    expect(
      await failure(publisherFor("INSTAGRAM").publish(payload(), instagram, resumable())),
    ).toMatchObject({ code: "UNAVAILABLE", retryable: true, status: 500 });

    // One on the call that publishes the Facebook post isn't: Meta may have created it anyway.
    graph.failNext({ match: /photos$/, status: 500, error: GRAPH_ERRORS.unavailable });
    const ambiguous = await attempt();
    expect(ambiguous).toMatchObject({ code: "UNAVAILABLE", retryable: false, status: 500 });
    expect(ambiguous.message).toContain("check the Page, then retry or cancel the job");

    graph.failNext({
      match: /photos$/,
      status: 400,
      error: { message: "(#100) Invalid parameter", type: "OAuthException", code: 100 },
    });
    const rejected = await attempt();
    expect(rejected).toMatchObject({ code: "REJECTED", retryable: false });
    expect(rejected.message).toContain(`POST /v26.0/${PAGE.id}/photos (#100)`);
    expect(rejected.message).not.toContain(TOKEN);
  });

  it("takes local-storage media URLs while Graph itself runs on this machine", async () => {
    // What the harness's live runs publish: LocalStorage serves http://localhost/files/...
    const local = payload({
      media: [{ ...image(), url: "http://localhost:4000/files/clients/c1/assets/a1.png" }],
    });
    const outcome = await publisherFor("INSTAGRAM").publish(local, instagram, resumable());
    expect(outcome.status).toBe("published");
    expect(bodyOf(1)).toMatchObject({
      image_url: "http://localhost:4000/files/clients/c1/assets/a1.png",
    });
  });

  it("validates the payload and the account before any call", async () => {
    const instagramPublisher = publisherFor("INSTAGRAM");
    await expect(
      instagramPublisher.publish(payload({ postType: "REEL" }), instagram, resumable()),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      instagramPublisher.publish(payload({ platform: "FACEBOOK" }), instagram, resumable()),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(instagramPublisher.publish(payload(), null, resumable())).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    await expect(
      instagramPublisher.publish(payload(), facebook, resumable()),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(graph.calls).toEqual([]);
  });
});
