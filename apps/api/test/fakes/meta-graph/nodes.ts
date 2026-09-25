import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readContainer, statusText } from "./instagram";
import {
  authenticate,
  checkVersion,
  nowSeconds,
  routeParams,
  unknownObject,
  type FakeGraphState,
  type FakeVideo,
} from "./world";

/*
 * GET /{v}/{id}: whatever object the fake holds under that id. An Instagram container reports
 * status_code (each read uses up one of its IN_PROGRESS polls), published media its permalink, a
 * Facebook post its permalink_url, a video its upload/processing/publishing status and a relative
 * permalink_url (as Graph gives video links).
 */

type Phase = { status: string; errors?: { code: number; message: string }[] };

function phases(
  videoStatus: string,
  uploading: Phase,
  processing: Phase,
  publishing: Phase & { publish_status?: string; publish_time?: number },
) {
  return {
    video_status: videoStatus,
    uploading_phase: uploading,
    processing_phase: processing,
    publishing_phase: publishing,
  };
}

const NOT_STARTED = { status: "not_started" };
const COMPLETE = { status: "complete" };

/** A status read: a finished video is `processing` while polls are left, then its outcome. */
function readVideo(video: FakeVideo) {
  if (video.phase === "processing") {
    if (video.pollsLeft > 0) {
      video.pollsLeft -= 1;
      return phases("processing", COMPLETE, { status: "in_progress" }, NOT_STARTED);
    }
    video.phase = video.outcome;
  }
  switch (video.phase) {
    case "created":
      return phases("uploading", NOT_STARTED, NOT_STARTED, NOT_STARTED);
    case "uploaded":
      return phases("upload_complete", COMPLETE, NOT_STARTED, NOT_STARTED);
    case "ready":
      return phases("ready", COMPLETE, COMPLETE, {
        status: "complete",
        publish_status: "published",
        publish_time: nowSeconds(),
      });
    case "error":
      return phases(
        "error",
        COMPLETE,
        {
          status: "error",
          errors: [
            { code: 1363008, message: "Video processing failed: the file could not be decoded" },
          ],
        },
        NOT_STARTED,
      );
  }
}

function node(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  if (!authenticate(state, request, reply)) return reply;
  const { id } = routeParams(request);

  const container = state.containers.get(id);
  if (container) {
    const statusCode = readContainer(container);
    return { id, status_code: statusCode, status: statusText(statusCode) };
  }
  const media = state.media.get(id);
  if (media) {
    return {
      id,
      media_type: media.mediaType,
      permalink: media.permalink,
      ...(media.caption ? { caption: media.caption } : {}),
    };
  }
  const post = state.posts.get(id);
  if (post) {
    return {
      id,
      permalink_url: post.permalink,
      ...(post.message ? { message: post.message } : {}),
    };
  }
  const video = state.videos.get(id);
  if (video) {
    return {
      id,
      status: readVideo(video),
      permalink_url: video.kind === "reel" ? `/reel/${id}/` : `/${video.pageId}/videos/${id}/`,
      ...(video.description ? { description: video.description } : {}),
    };
  }
  const photo = state.photos.get(id);
  if (photo) return { id, link: `https://www.facebook.com/photo/?fbid=${id}` };
  const page = state.pages.find((candidate) => candidate.id === id);
  if (page) return { id, name: page.name };
  const instagram = state.pages.find((candidate) => candidate.instagram?.id === id)?.instagram;
  if (instagram) return { id, username: instagram.username };
  return unknownObject(reply, id);
}

export function registerNodes(app: FastifyInstance, state: FakeGraphState): void {
  app.get("/:version/:id", (request, reply) =>
    checkVersion(request, reply) ? node(state, request, reply) : reply,
  );
}
