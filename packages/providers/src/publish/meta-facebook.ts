import { z } from "zod";
import { publishedCaption } from "@enmo/shared";
import { PublishError } from "./errors";
import { GraphId } from "./graph-client";
import { defined, graphPath, onlyMedia, processing, type MetaFlowContext } from "./meta-context";
import { startProgress, type MetaProgress } from "./meta-progress";
import type { PublishOutcome } from "./types";

/*
 * Facebook Page publishing (DESIGN §F "FB posting"):
 *   photo        POST /{page}/photos {url, message, published: true}
 *   multi-photo  POST /{page}/photos {url, published: false} per photo, then
 *                POST /{page}/feed {message, attached_media: [{media_fbid}]}
 *   photo story  POST /{page}/photos {url, published: false}, then POST /{page}/photo_stories
 *   reel         POST /{page}/video_reels {upload_phase: start} → rupload pulls file_url →
 *                POST /{page}/video_reels {upload_phase: finish, video_state: PUBLISHED}
 *   video story  the same through /{page}/video_stories (best effort: Meta's story API is young)
 * and the live URL from GET /{post}?fields=permalink_url, or for videos from
 * GET /{video}?fields=status,permalink_url once processing is done. The calls that publish a photo,
 * feed post or story can't be repeated safely, so an outage on one of them is final (publishOnce).
 */

const Photo = z.looseObject({ id: GraphId, post_id: GraphId.optional() });
const Post = z.looseObject({ id: GraphId });
const Story = z.looseObject({ success: z.boolean().optional(), post_id: GraphId });
const VideoStarted = z.looseObject({ video_id: GraphId });
const Finished = z.looseObject({ success: z.boolean().optional(), post_id: GraphId.optional() });
const PermalinkUrl = z.looseObject({ permalink_url: z.string().optional() });

const Phase = z.looseObject({
  status: z.string(),
  errors: z.array(z.looseObject({ message: z.string().optional() })).optional(),
});
const VideoStatus = z.looseObject({
  status: z.looseObject({
    video_status: z.string(),
    uploading_phase: Phase.optional(),
    processing_phase: Phase.optional(),
    publishing_phase: Phase.optional(),
  }),
  permalink_url: z.string().optional(),
});
type VideoStatus = z.output<typeof VideoStatus>;

const FACEBOOK = "https://www.facebook.com";

/** Graph gives video permalinks relative to facebook.com ("/reel/123/"). */
function absolute(permalink: string | undefined): string | null {
  if (!permalink) return null;
  if (/^https?:\/\//.test(permalink)) return permalink;
  return permalink.startsWith("/") ? new URL(permalink, FACEBOOK).toString() : null;
}

function messageOf(ctx: MetaFlowContext): string {
  return publishedCaption(ctx.payload.caption, ctx.payload.hashtags);
}

/** The post is live once Meta created it, so reading its permalink never fails the publish. */
async function published(ctx: MetaFlowContext, postId: string): Promise<PublishOutcome> {
  let liveUrl = `${FACEBOOK}/${encodeURIComponent(postId)}`;
  try {
    const body = await ctx.get(graphPath(postId), { fields: "permalink_url" }, PermalinkUrl);
    liveUrl = absolute(body.permalink_url) ?? liveUrl;
  } catch (error) {
    if (!(error instanceof PublishError)) throw error;
  }
  return { status: "published", externalId: postId, liveUrl };
}

async function recordResult(
  ctx: MetaFlowContext,
  progress: MetaProgress,
  postId: string,
): Promise<PublishOutcome> {
  await ctx.save({ ...progress, result: postId });
  return published(ctx, postId);
}

function refused(what: string): PublishError {
  return new PublishError("REJECTED", `Facebook did not accept the ${what}`);
}

/**
 * The POST that makes a post public (a published photo, the feed post, the story) isn't
 * idempotent, and Meta can create the post and still time out or answer 5xx. Such an ambiguous
 * failure (UNAVAILABLE) is final, never retried automatically, so the Page never gets the post
 * twice: a person checks it, then retries or cancels. A clear refusal (rate limit, token, a 4xx)
 * means nothing was created and stays as it is.
 */
async function publishOnce<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof PublishError) || error.code !== "UNAVAILABLE") throw error;
    throw new PublishError(
      "UNAVAILABLE",
      `${error.message}. Facebook may have published the ${what} anyway, so it isn't retried automatically: check the Page, then retry or cancel the job`,
      { status: error.status, retryable: false, cause: error },
    );
  }
}

async function photo(ctx: MetaFlowContext, progress: MetaProgress | null) {
  if (progress?.result) return published(ctx, progress.result);
  const body = defined({
    url: onlyMedia(ctx.payload).url,
    message: messageOf(ctx),
    alt_text_custom: ctx.payload.altText,
    published: true,
  });
  const created = await publishOnce("photo post", () =>
    ctx.post(graphPath(ctx.nodeId, "photos"), body, Photo),
  );
  return recordResult(ctx, startProgress("FB_PHOTO"), created.post_id ?? created.id);
}

/** Uploads the photos not uploaded yet as unpublished, recording each id as it arrives. */
async function stagePhotos(ctx: MetaFlowContext, progress: MetaProgress): Promise<MetaProgress> {
  let current = progress;
  for (const media of ctx.payload.media.slice(current.items.length)) {
    const staged = await ctx.post(
      graphPath(ctx.nodeId, "photos"),
      { url: media.url, published: false },
      Photo,
    );
    current = { ...current, items: [...current.items, staged.id] };
    await ctx.save(current);
  }
  return current;
}

async function multiPhoto(ctx: MetaFlowContext, progress: MetaProgress | null) {
  if (progress?.result) return published(ctx, progress.result);
  const current = await stagePhotos(ctx, progress ?? startProgress("FB_MULTI_PHOTO"));
  const post = await publishOnce("multi-photo post", () =>
    ctx.post(
      graphPath(ctx.nodeId, "feed"),
      {
        ...defined({ message: messageOf(ctx) }),
        attached_media: current.items.map((id) => ({ media_fbid: id })),
      },
      Post,
    ),
  );
  return recordResult(ctx, current, post.id);
}

async function photoStory(ctx: MetaFlowContext, progress: MetaProgress | null) {
  if (progress?.result) return published(ctx, progress.result);
  const current = await stagePhotos(ctx, progress ?? startProgress("FB_PHOTO_STORY"));
  const [photoId] = current.items;
  if (!photoId) throw new Error("A story's photo is staged before the story is posted");
  const story = await publishOnce("photo story", () =>
    ctx.post(graphPath(ctx.nodeId, "photo_stories"), { photo_id: photoId }, Story),
  );
  if (story.success === false) throw refused("photo story");
  return recordResult(ctx, current, story.post_id);
}

async function videoStatus(ctx: MetaFlowContext, videoId: string): Promise<VideoStatus> {
  return ctx.get(graphPath(videoId), { fields: "status,permalink_url" }, VideoStatus);
}

function videoFailure(videoId: string, body: VideoStatus): PublishError | null {
  const { status } = body;
  const phases = [status.uploading_phase, status.processing_phase, status.publishing_phase];
  const failed =
    ["error", "expired"].includes(status.video_status) ||
    phases.some((phase) => phase?.status === "error");
  if (!failed) return null;
  const details = phases
    .flatMap((phase) => phase?.errors ?? [])
    .map((error) => error.message)
    .filter((message): message is string => Boolean(message));
  const why = details.length > 0 ? `: ${details.join("; ")}` : "";
  return new PublishError(
    "MEDIA_FAILED",
    `Facebook could not process video ${videoId} (${status.video_status})${why}`,
  );
}

function videoLive(body: VideoStatus): boolean {
  const publishing = body.status.publishing_phase?.status ?? "complete";
  return body.status.video_status === "ready" && publishing === "complete";
}

async function video(
  ctx: MetaFlowContext,
  progress: MetaProgress | null,
  edge: "video_reels" | "video_stories",
): Promise<PublishOutcome> {
  const media = onlyMedia(ctx.payload);
  const resumed = progress !== null && progress.items.length > 0;
  const restart = () => video({ ...ctx, restartDead: false }, null, edge);
  let current = progress ?? startProgress(ctx.flow);
  let uploaded = false;

  if (!resumed) {
    const started = await ctx.post(
      graphPath(ctx.nodeId, edge),
      { upload_phase: "start" },
      VideoStarted,
    );
    current = { ...startProgress(ctx.flow), items: [started.video_id] };
    await ctx.save(current);
  }
  const [videoId] = current.items;
  if (!videoId) throw new Error("A Facebook video is recorded before it is uploaded");

  if (!current.finished) {
    if (resumed) {
      // A crash may have come after the upload: rupload is only asked once per video.
      const status = await videoStatus(ctx, videoId);
      const failure = videoFailure(videoId, status);
      if (failure) {
        if (ctx.restartDead) return restart();
        throw failure;
      }
      uploaded = status.status.uploading_phase?.status === "complete";
    }
    if (!uploaded) await ctx.upload(videoId, media.url);
    const finish =
      edge === "video_reels"
        ? defined({
            upload_phase: "finish",
            video_id: videoId,
            video_state: "PUBLISHED",
            description: messageOf(ctx),
          })
        : { upload_phase: "finish", video_id: videoId };
    const done = await ctx.post(graphPath(ctx.nodeId, edge), finish, Finished);
    if (done.success === false) throw refused(edge === "video_reels" ? "reel" : "video story");
    current = { ...current, finished: true, result: done.post_id ?? null };
    await ctx.save(current);
  }

  const status = await videoStatus(ctx, videoId);
  const failure = videoFailure(videoId, status);
  if (failure) {
    if (resumed && ctx.restartDead) return restart();
    throw failure;
  }
  if (!videoLive(status)) return processing(current);
  const externalId = current.result ?? videoId;
  const fallback =
    edge === "video_reels"
      ? `${FACEBOOK}/reel/${encodeURIComponent(videoId)}`
      : `${FACEBOOK}/${encodeURIComponent(externalId)}`;
  return { status: "published", externalId, liveUrl: absolute(status.permalink_url) ?? fallback };
}

export function runFacebook(
  ctx: MetaFlowContext,
  progress: MetaProgress | null,
): Promise<PublishOutcome> {
  switch (ctx.flow) {
    case "FB_PHOTO":
      return photo(ctx, progress);
    case "FB_MULTI_PHOTO":
      return multiPhoto(ctx, progress);
    case "FB_PHOTO_STORY":
      return photoStory(ctx, progress);
    case "FB_REEL":
      return video(ctx, progress, "video_reels");
    case "FB_VIDEO_STORY":
      return video(ctx, progress, "video_stories");
    case "IG_IMAGE":
    case "IG_REEL":
    case "IG_STORY":
    case "IG_CAROUSEL":
      throw new Error(`${ctx.flow} is an Instagram flow`);
  }
}
