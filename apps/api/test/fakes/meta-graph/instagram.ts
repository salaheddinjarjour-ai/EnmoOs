import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  GRAPH_ERRORS,
  authenticate,
  checkVersion,
  flag,
  invalidParameter,
  newId,
  paramsOf,
  routeParams,
  sendGraphError,
  text,
  type ContainerStatusCode,
  type FakeContainer,
  type FakeGraphState,
} from "./world";

/*
 * Instagram content publishing as the fake plays it:
 *   POST /{v}/{ig}/media                            a container (image, REELS, STORIES, carousel
 *                                                   item, CAROUSEL), IN_PROGRESS for
 *                                                   state.containerPolls status reads, then
 *                                                   state.containerOutcome (ERROR for an image
 *                                                   that isn't a JPEG)
 *   POST /{v}/{ig}/media_publish {creation_id}      publishes a FINISHED container, counting it
 *                                                   against state.quotaUsage/quotaTotal
 *   GET  /{v}/{ig}/content_publishing_limit
 * GET /{v}/{container|media} is in nodes.ts.
 */

const PUBLISH_SCOPE = "instagram_content_publish";
const CAROUSEL_MIN = 2;
const CAROUSEL_MAX = 10;

/**
 * Instagram fetches images as JPEG only; anything else ends its container in ERROR once Meta has
 * tried to download it. The fake goes by the URL's extension.
 */
export function isJpegUrl(url: string): boolean {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a URL: judged as written.
  }
  return /\.jpe?g$/i.test(path);
}

/** A status read: answers IN_PROGRESS while polls are left, then the container's outcome. */
export function readContainer(container: FakeContainer): ContainerStatusCode {
  if (container.status === "IN_PROGRESS") {
    if (container.pollsLeft > 0) {
      container.pollsLeft -= 1;
      return "IN_PROGRESS";
    }
    container.status = container.outcome;
  }
  return container.status;
}

/** The status without using up a poll: done processing once no polls are left. */
function settledStatus(container: FakeContainer): ContainerStatusCode {
  if (container.status === "IN_PROGRESS" && container.pollsLeft === 0) {
    container.status = container.outcome;
  }
  return container.status;
}

export function statusText(status: ContainerStatusCode): string {
  switch (status) {
    case "IN_PROGRESS":
      return "In Progress: Media is still being processed.";
    case "FINISHED":
      return "Finished: Media has been uploaded and it is ready to be published.";
    case "PUBLISHED":
      return "Published: Media has been published.";
    case "ERROR":
      return "Error: Media download has failed. The media URI doesn't meet our requirements.";
    case "EXPIRED":
      return "Expired: The container was not published within 24 hours and has expired.";
  }
}

export function instagramUsername(state: FakeGraphState, igUserId: string): string {
  return (
    state.pages.find((page) => page.instagram?.id === igUserId)?.instagram?.username ?? "enmo.fake"
  );
}

function permalinkFor(state: FakeGraphState, container: FakeContainer, mediaId: string): string {
  const shortcode = Buffer.from(mediaId).toString("base64url").slice(-11);
  switch (container.mediaType) {
    case "REELS":
      return `https://www.instagram.com/reel/${shortcode}/`;
    case "STORIES":
      return `https://www.instagram.com/stories/${instagramUsername(state, container.igUserId)}/${mediaId}/`;
    case "IMAGE":
    case "VIDEO":
    case "CAROUSEL":
      return `https://www.instagram.com/p/${shortcode}/`;
  }
}

/** The CAROUSEL's children, or null after answering why they won't do. */
function carouselChildren(
  state: FakeGraphState,
  igUserId: string,
  params: Record<string, unknown>,
  reply: FastifyReply,
): string[] | null {
  const raw = params.children;
  const children = (
    Array.isArray(raw) ? raw.map(String) : (text(params, "children") ?? "").split(",")
  )
    .map((id) => id.trim())
    .filter(Boolean);
  if (children.length < CAROUSEL_MIN || children.length > CAROUSEL_MAX) {
    void invalidParameter(reply, `A carousel takes ${CAROUSEL_MIN} to ${CAROUSEL_MAX} children`);
    return null;
  }
  for (const id of children) {
    const child = state.containers.get(id);
    if (!child || child.igUserId !== igUserId || !child.isCarouselItem) {
      void invalidParameter(reply, `The children parameter holds an invalid carousel item: ${id}`);
      return null;
    }
    if (settledStatus(child) !== "FINISHED") {
      void sendGraphError(reply, 400, GRAPH_ERRORS.notReady);
      return null;
    }
  }
  return children;
}

function createContainer(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply, { scope: PUBLISH_SCOPE })) return reply;
  const { id: igUserId } = routeParams(request);
  const params = paramsOf(request);
  const mediaType = text(params, "media_type")?.toUpperCase() ?? "IMAGE";
  const isCarouselItem = flag(params, "is_carousel_item") === true;
  const imageUrl = text(params, "image_url");
  const videoUrl = text(params, "video_url");
  let children: string[] = [];

  switch (mediaType) {
    case "IMAGE":
      if (!imageUrl) return invalidParameter(reply, "The parameter image_url is required");
      break;
    case "REELS":
      if (isCarouselItem) return invalidParameter(reply, "A reel cannot be a carousel item");
      if (!videoUrl) return invalidParameter(reply, "The parameter video_url is required");
      break;
    case "VIDEO":
      if (!isCarouselItem) {
        return invalidParameter(reply, "media_type VIDEO is only for carousel items; use REELS");
      }
      if (!videoUrl) return invalidParameter(reply, "The parameter video_url is required");
      break;
    case "STORIES":
      if (Boolean(imageUrl) === Boolean(videoUrl)) {
        return invalidParameter(reply, "A story takes exactly one of image_url or video_url");
      }
      break;
    case "CAROUSEL": {
      const found = carouselChildren(state, igUserId, params, reply);
      if (!found) return reply;
      children = found;
      break;
    }
    default:
      return invalidParameter(
        reply,
        "Param media_type must be one of {IMAGE, VIDEO, REELS, STORIES, CAROUSEL}",
      );
  }

  const container: FakeContainer = {
    id: newId(state, "178"),
    igUserId,
    mediaType,
    isCarouselItem,
    children,
    params:
      request.body !== null && typeof request.body === "object"
        ? { ...(request.body as Record<string, unknown>) }
        : {},
    status: "IN_PROGRESS",
    pollsLeft: state.containerPolls,
    outcome: imageUrl && !isJpegUrl(imageUrl) ? "ERROR" : state.containerOutcome,
    mediaId: null,
  };
  state.containers.set(container.id, container);
  return { id: container.id };
}

function publishContainer(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply, { scope: PUBLISH_SCOPE })) return reply;
  const { id: igUserId } = routeParams(request);
  const creationId = text(paramsOf(request), "creation_id");
  if (!creationId) return invalidParameter(reply, "The parameter creation_id is required");
  const container = state.containers.get(creationId);
  if (!container || container.igUserId !== igUserId) {
    return invalidParameter(reply, `Invalid creation_id ${creationId}`);
  }
  if (container.isCarouselItem) {
    return invalidParameter(reply, "A carousel item is published through its carousel");
  }
  const status = settledStatus(container);
  if (status === "PUBLISHED") {
    return invalidParameter(reply, "The media has already been published");
  }
  if (status === "IN_PROGRESS") return sendGraphError(reply, 400, GRAPH_ERRORS.notReady);
  if (status !== "FINISHED") {
    return invalidParameter(reply, `The container is ${status} and cannot be published`);
  }
  if (state.quotaUsage >= state.quotaTotal) {
    return sendGraphError(reply, 400, GRAPH_ERRORS.publishLimitReached);
  }

  const mediaId = newId(state, "179");
  const caption = text(container.params, "caption") ?? null;
  state.media.set(mediaId, {
    id: mediaId,
    igUserId,
    containerId: container.id,
    mediaType: container.mediaType,
    caption,
    permalink: permalinkFor(state, container, mediaId),
  });
  container.status = "PUBLISHED";
  container.mediaId = mediaId;
  state.quotaUsage += 1;
  return { id: mediaId };
}

function publishingLimit(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply)) return reply;
  return {
    data: [
      {
        quota_usage: state.quotaUsage,
        config: { quota_total: state.quotaTotal, quota_duration: 86_400 },
      },
    ],
  };
}

export function registerInstagram(app: FastifyInstance, state: FakeGraphState): void {
  app.post("/:version/:id/media", (request, reply) =>
    checkVersion(request, reply) ? createContainer(state, request, reply) : reply,
  );
  app.post("/:version/:id/media_publish", (request, reply) =>
    checkVersion(request, reply) ? publishContainer(state, request, reply) : reply,
  );
  app.get("/:version/:id/content_publishing_limit", (request, reply) =>
    checkVersion(request, reply) ? publishingLimit(state, request, reply) : reply,
  );
}
