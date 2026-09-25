import { z } from "zod";
import { publishedCaption } from "@enmo/shared";
import { PublishError } from "./errors";
import { GraphId } from "./graph-client";
import {
  defined,
  graphPath,
  onlyMedia,
  processing,
  type GraphGet,
  type MetaFlowContext,
} from "./meta-context";
import { startProgress, type MetaProgress } from "./meta-progress";
import type { PublishMedia, PublishOutcome, PublishQuota } from "./types";

/*
 * Instagram content publishing (DESIGN §F "IG posting"):
 *   GET  /{ig}/content_publishing_limit?fields=quota_usage,config   refuse at the cap
 *   POST /{ig}/media                    image | REELS | STORIES container, or carousel children
 *                                       (is_carousel_item) and then the CAROUSEL parent
 *   GET  /{container}?fields=status_code,status                     IN_PROGRESS → FINISHED
 *   POST /{ig}/media_publish {creation_id}
 *   GET  /{media}?fields=permalink
 * Containers are checked once right after they're created, so a post Meta processes at once
 * (images, usually) goes live in one call; otherwise publish() answers `processing` and poll()
 * takes it from there.
 */

const Created = z.object({ id: GraphId });

const ContainerStatus = z.looseObject({
  status_code: z.string(),
  /** Meta's explanation, e.g. "Error: Media download has failed." */
  status: z.string().optional(),
});

const Permalink = z.looseObject({ permalink: z.string().optional() });

const PublishingLimit = z.object({
  data: z.array(
    z.looseObject({
      quota_usage: z.number(),
      config: z
        .looseObject({ quota_total: z.number(), quota_duration: z.number().optional() })
        .optional(),
    }),
  ),
});

type ContainerState =
  | { state: "IN_PROGRESS" }
  | { state: "FINISHED" }
  | { state: "PUBLISHED" }
  | { state: "DEAD"; code: string; detail: string | null };

/** content_publishing_limit, or null when Instagram doesn't report one for the account. */
export async function instagramQuota(
  get: GraphGet,
  igUserId: string,
): Promise<PublishQuota | null> {
  const body = await get(
    graphPath(igUserId, "content_publishing_limit"),
    { fields: "quota_usage,config" },
    PublishingLimit,
  );
  const entry = body.data[0];
  if (!entry?.config) return null;
  return {
    used: entry.quota_usage,
    limit: entry.config.quota_total,
    windowHours: (entry.config.quota_duration ?? 86_400) / 3_600,
  };
}

async function ensureQuota(ctx: MetaFlowContext): Promise<void> {
  const quota = await instagramQuota(ctx.get, ctx.nodeId);
  if (quota && quota.used >= quota.limit) {
    throw new PublishError(
      "RATE_LIMITED",
      `Instagram's publishing limit is reached: ${quota.used} of ${quota.limit} posts in the last ${quota.windowHours} hours. The post goes out once the window frees up.`,
    );
  }
}

function captionOf(ctx: MetaFlowContext): string {
  return publishedCaption(ctx.payload.caption, ctx.payload.hashtags);
}

function containerParams(ctx: MetaFlowContext): Record<string, string | boolean> {
  const { payload } = ctx;
  const media = onlyMedia(payload);
  switch (ctx.flow) {
    case "IG_IMAGE":
      return defined({ image_url: media.url, caption: captionOf(ctx), alt_text: payload.altText });
    case "IG_REEL":
      return defined({
        media_type: "REELS",
        video_url: media.url,
        caption: captionOf(ctx),
        share_to_feed: true,
        cover_url: payload.coverUrl,
      });
    case "IG_STORY":
      // Stories take no caption.
      return media.kind === "VIDEO"
        ? { media_type: "STORIES", video_url: media.url }
        : { media_type: "STORIES", image_url: media.url };
    case "IG_CAROUSEL":
    case "FB_PHOTO":
    case "FB_REEL":
    case "FB_PHOTO_STORY":
    case "FB_VIDEO_STORY":
    case "FB_MULTI_PHOTO":
      throw new Error(`${ctx.flow} has no single Instagram container`);
  }
}

function childParams(media: PublishMedia): Record<string, string | boolean> {
  return media.kind === "VIDEO"
    ? { media_type: "VIDEO", video_url: media.url, is_carousel_item: true }
    : { image_url: media.url, is_carousel_item: true };
}

async function containerState(ctx: MetaFlowContext, id: string): Promise<ContainerState> {
  const body = await ctx.get(graphPath(id), { fields: "status_code,status" }, ContainerStatus);
  switch (body.status_code) {
    case "FINISHED":
      return { state: "FINISHED" };
    case "PUBLISHED":
      return { state: "PUBLISHED" };
    case "ERROR":
    case "EXPIRED":
      return { state: "DEAD", code: body.status_code, detail: body.status ?? null };
    default:
      // IN_PROGRESS, or a state Meta added since: poll again (polls are capped by the caller).
      return { state: "IN_PROGRESS" };
  }
}

function deadContainer(id: string, state: Extract<ContainerState, { state: "DEAD" }>) {
  const why = state.detail ? `: ${state.detail}` : "";
  const expired =
    state.code === "EXPIRED" ? " (containers expire 24 hours after they are created)" : "";
  return new PublishError(
    "MEDIA_FAILED",
    `Instagram could not process the media; container ${id} is ${state.code}${expired}${why}`,
  );
}

function alreadyPublished(id: string) {
  return new PublishError(
    "REJECTED",
    `Instagram already published container ${id}, but this job never recorded the post; check the account before publishing again`,
  );
}

function fallbackUrl(ctx: MetaFlowContext, mediaId: string): string {
  const handle = encodeURIComponent(ctx.handle);
  return ctx.flow === "IG_STORY"
    ? `https://www.instagram.com/stories/${handle}/${mediaId}/`
    : `https://www.instagram.com/${handle}/`;
}

/**
 * The post is live once media_publish answered, so reading its permalink never fails the publish:
 * without one the account's page stands in.
 */
async function published(ctx: MetaFlowContext, mediaId: string): Promise<PublishOutcome> {
  let liveUrl = fallbackUrl(ctx, mediaId);
  try {
    const { permalink } = await ctx.get(graphPath(mediaId), { fields: "permalink" }, Permalink);
    if (permalink && /^https?:\/\//.test(permalink)) liveUrl = permalink;
  } catch (error) {
    if (!(error instanceof PublishError)) throw error;
  }
  return { status: "published", externalId: mediaId, liveUrl };
}

/** Publishes `container` once it is FINISHED; `resumed`: it came from an earlier call. */
async function publishContainer(
  ctx: MetaFlowContext,
  progress: MetaProgress,
  container: string,
  resumed: boolean,
  restart: () => Promise<PublishOutcome>,
): Promise<PublishOutcome> {
  const status = await containerState(ctx, container);
  switch (status.state) {
    case "IN_PROGRESS":
      return processing(progress);
    case "DEAD":
      if (resumed && ctx.restartDead) return restart();
      throw deadContainer(container, status);
    case "PUBLISHED":
      throw alreadyPublished(container);
    case "FINISHED":
      break;
  }
  const media = await ctx.post(
    graphPath(ctx.nodeId, "media_publish"),
    { creation_id: container },
    Created,
  );
  await ctx.save({ ...progress, result: media.id });
  return published(ctx, media.id);
}

async function runSingle(
  ctx: MetaFlowContext,
  progress: MetaProgress | null,
): Promise<PublishOutcome> {
  if (progress?.result) return published(ctx, progress.result);
  const resumed = progress !== null && progress.items.length > 0;
  let current = progress ?? startProgress(ctx.flow);
  if (!resumed) {
    await ensureQuota(ctx);
    const container = await ctx.post(graphPath(ctx.nodeId, "media"), containerParams(ctx), Created);
    current = { ...startProgress(ctx.flow), items: [container.id] };
    await ctx.save(current);
  }
  const [container] = current.items;
  if (!container) throw new Error("An Instagram container is recorded before it is published");
  return publishContainer(ctx, current, container, resumed, () =>
    runSingle({ ...ctx, restartDead: false }, null),
  );
}

async function runCarousel(
  ctx: MetaFlowContext,
  progress: MetaProgress | null,
): Promise<PublishOutcome> {
  if (progress?.result) return published(ctx, progress.result);
  const resumed = progress !== null;
  const restart = () => runCarousel({ ...ctx, restartDead: false }, null);
  let current = progress ?? startProgress("IG_CAROUSEL");
  if (current.parent !== null) {
    return publishContainer(ctx, current, current.parent, resumed, restart);
  }

  if (!resumed) await ensureQuota(ctx);
  for (const media of ctx.payload.media.slice(current.items.length)) {
    const child = await ctx.post(graphPath(ctx.nodeId, "media"), childParams(media), Created);
    current = { ...current, items: [...current.items, child.id] };
    await ctx.save(current);
  }
  // Every child is checked each round: Meta processes them in parallel.
  let waiting = false;
  for (const child of current.items) {
    const status = await containerState(ctx, child);
    if (status.state === "DEAD") {
      if (resumed && ctx.restartDead) return restart();
      throw deadContainer(child, status);
    }
    if (status.state === "PUBLISHED") throw alreadyPublished(child);
    if (status.state === "IN_PROGRESS") waiting = true;
  }
  if (waiting) return processing(current);

  const parent = await ctx.post(
    graphPath(ctx.nodeId, "media"),
    defined({ media_type: "CAROUSEL", children: current.items.join(","), caption: captionOf(ctx) }),
    Created,
  );
  current = { ...current, parent: parent.id };
  await ctx.save(current);
  return publishContainer(ctx, current, parent.id, resumed, restart);
}

export function runInstagram(
  ctx: MetaFlowContext,
  progress: MetaProgress | null,
): Promise<PublishOutcome> {
  return ctx.flow === "IG_CAROUSEL" ? runCarousel(ctx, progress) : runSingle(ctx, progress);
}
