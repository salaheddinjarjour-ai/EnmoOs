import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  authenticate,
  checkVersion,
  flag,
  invalidParameter,
  newId,
  paramsOf,
  routeParams,
  sendGraphError,
  text,
  type FakeGraphState,
  type FakePhoto,
  type FakePost,
  type FakeVideo,
} from "./world";

/*
 * Facebook Page publishing as the fake plays it:
 *   POST /{v}/{page}/photos          {url, message, published}: a photo post, or an unpublished
 *                                    photo for a multi-photo post or a story
 *   POST /{v}/{page}/feed            {message, attached_media: [{media_fbid}]}
 *   POST /{v}/{page}/photo_stories   {photo_id}
 *   POST /{v}/{page}/video_reels     upload_phase start | finish (video_state, description)
 *   POST /{v}/{page}/video_stories   upload_phase start | finish
 *   POST /video-upload/{v}/{video}   rupload: pulls the `file_url` header's file
 * A finished video answers `processing` for state.videoPolls status reads, then
 * state.videoOutcome. GET /{v}/{post|video|photo} is in nodes.ts.
 */

const PUBLISH_SCOPE = "pages_manage_posts";

function pageOf(request: FastifyRequest): string {
  return routeParams(request).id;
}

function createPost(
  state: FakeGraphState,
  pageId: string,
  kind: FakePost["kind"],
  message: string | null,
  photoIds: string[],
): FakePost {
  const serial = newId(state, "4");
  const id = `${pageId}_${serial}`;
  const permalink =
    kind === "photo_story" || kind === "video_story"
      ? `https://www.facebook.com/stories/${pageId}/${serial}/`
      : `https://www.facebook.com/${pageId}/posts/${serial}/`;
  const post: FakePost = { id, pageId, kind, message, photoIds, permalink };
  state.posts.set(id, post);
  for (const photoId of photoIds) {
    const photo = state.photos.get(photoId);
    if (photo) photo.postId = id;
  }
  return post;
}

/** An unpublished photo of the Page not used in any post yet, or null after answering why not. */
function stagedPhoto(
  state: FakeGraphState,
  pageId: string,
  id: string | undefined,
  reply: FastifyReply,
): FakePhoto | null {
  const photo = id === undefined ? undefined : state.photos.get(id);
  if (!photo || photo.pageId !== pageId || photo.published || photo.postId !== null) {
    void invalidParameter(
      reply,
      `Invalid photo id ${id ?? "(missing)"}: not an unused unpublished photo of this Page`,
    );
    return null;
  }
  return photo;
}

function photos(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply, { scope: PUBLISH_SCOPE })) return reply;
  const pageId = pageOf(request);
  const params = paramsOf(request);
  const url = text(params, "url");
  if (!url) {
    return sendGraphError(reply, 400, {
      message: "(#324) Requires upload file",
      type: "OAuthException",
      code: 324,
    });
  }
  const published = flag(params, "published") ?? true;
  const photo: FakePhoto = { id: newId(state, "301"), pageId, url, published, postId: null };
  state.photos.set(photo.id, photo);
  if (!published) return { id: photo.id };
  const message = text(params, "message") ?? text(params, "caption") ?? null;
  const post = createPost(state, pageId, "photo", message, [photo.id]);
  return { id: photo.id, post_id: post.id };
}

/** attached_media as JSON (an array or its string), or form fields attached_media[0], …. */
function attachedMedia(params: Record<string, unknown>): unknown[] {
  const raw = params.attached_media;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Object.entries(params)
    .filter(([key]) => /^attached_media\[\d+\]$/.test(key))
    .map(([, value]) => (typeof value === "string" ? (JSON.parse(value) as unknown) : value));
}

function mediaFbid(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const id = (entry as { media_fbid?: unknown }).media_fbid;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function feed(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply, { scope: PUBLISH_SCOPE })) return reply;
  const pageId = pageOf(request);
  const params = paramsOf(request);
  const message = text(params, "message") ?? null;
  const attached = attachedMedia(params);
  if (!message && attached.length === 0) {
    return invalidParameter(reply, "A post needs a message or attached_media");
  }
  const photoIds: string[] = [];
  for (const entry of attached) {
    const photo = stagedPhoto(state, pageId, mediaFbid(entry), reply);
    if (!photo) return reply;
    photoIds.push(photo.id);
  }
  return { id: createPost(state, pageId, "feed", message, photoIds).id };
}

function photoStory(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply, { scope: PUBLISH_SCOPE })) return reply;
  const pageId = pageOf(request);
  const photo = stagedPhoto(state, pageId, text(paramsOf(request), "photo_id"), reply);
  if (!photo) return reply;
  return { success: true, post_id: createPost(state, pageId, "photo_story", null, [photo.id]).id };
}

function uploadUrl(request: FastifyRequest, videoId: string): string {
  const { version } = routeParams(request);
  return `http://${request.headers.host ?? "fake-graph"}/video-upload/${version}/${videoId}`;
}

function videoUpload(kind: FakeVideo["kind"]) {
  const edge = kind === "reel" ? "video_reels" : "video_stories";
  return (state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) => {
    if (!authenticate(state, request, reply, { scope: PUBLISH_SCOPE })) return reply;
    const pageId = pageOf(request);
    const params = paramsOf(request);
    const phase = text(params, "upload_phase");

    if (phase === "start") {
      const video: FakeVideo = {
        id: newId(state, "302"),
        pageId,
        kind,
        fileUrl: null,
        phase: "created",
        description: null,
        pollsLeft: 0,
        outcome: state.videoOutcome,
        postId: null,
      };
      state.videos.set(video.id, video);
      return { video_id: video.id, upload_url: uploadUrl(request, video.id) };
    }
    if (phase !== "finish") {
      return invalidParameter(reply, `${edge}: upload_phase must be start or finish`);
    }

    const videoId = text(params, "video_id");
    const video = videoId === undefined ? undefined : state.videos.get(videoId);
    if (!video || video.pageId !== pageId || video.kind !== kind) {
      return invalidParameter(reply, `Invalid video_id ${videoId ?? "(missing)"}`);
    }
    if (video.phase === "created") {
      return sendGraphError(reply, 400, {
        message: "There was a problem uploading your video file. Please try again.",
        type: "OAuthException",
        code: 6000,
        error_subcode: 1363030,
      });
    }
    if (kind === "reel" && text(params, "video_state") !== "PUBLISHED") {
      return invalidParameter(reply, "video_state must be PUBLISHED for the fake");
    }
    if (video.phase === "uploaded") {
      video.phase = "processing";
      video.pollsLeft = state.videoPolls;
      video.outcome = state.videoOutcome;
      video.description = text(params, "description") ?? null;
      if (kind === "story") video.postId = createPost(state, pageId, "video_story", null, []).id;
    }
    return kind === "story" ? { success: true, post_id: video.postId } : { success: true };
  };
}

/** rupload answers its own failures as `{debug_info}`, not Graph's error envelope. */
function ruploadError(reply: FastifyReply, message: string) {
  return reply
    .status(400)
    .send({ debug_info: { retriable: false, type: "ProcessingFailedError", message } });
}

function rupload(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply, { skipProof: true })) return reply;
  const video = state.videos.get(routeParams(request).id);
  if (!video) return ruploadError(reply, "Invalid video id");
  const fileUrl = request.headers.file_url;
  if (typeof fileUrl !== "string" || !URL.canParse(fileUrl)) {
    return ruploadError(reply, "The file_url header is missing or not a URL");
  }
  video.fileUrl = fileUrl;
  if (video.phase === "created") video.phase = "uploaded";
  return { success: true };
}

export function registerFacebook(app: FastifyInstance, state: FakeGraphState): void {
  const routes: [string, (s: FakeGraphState, q: FastifyRequest, r: FastifyReply) => unknown][] = [
    ["photos", photos],
    ["feed", feed],
    ["photo_stories", photoStory],
    ["video_reels", videoUpload("reel")],
    ["video_stories", videoUpload("story")],
  ];
  for (const [edge, handler] of routes) {
    app.post(`/:version/:id/${edge}`, (request, reply) =>
      checkVersion(request, reply) ? handler(state, request, reply) : reply,
    );
  }
  app.post("/video-upload/:version/:id", (request, reply) =>
    checkVersion(request, reply) ? rupload(state, request, reply) : reply,
  );
}
