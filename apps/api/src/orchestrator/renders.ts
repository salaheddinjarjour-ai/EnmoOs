import type { Asset } from "@enmo/db";
import {
  assetStorageKey,
  downloadOutput,
  type VisualOutput,
  type VisualRequest,
} from "@enmo/providers";
import { CopywriterOutput, pixelSizeFor, VisualStyleTokens, type Shot } from "@enmo/shared";
import sharp from "sharp";
import type { Deps } from "../deps";
import { enqueueRenderPoll, renderPollDelayMs, type RenderPollJob } from "../jobs/queues";
import { parseStored } from "../lib/stored";
import { afterCommit } from "./after-commit";
import { EventBatch } from "./events";
import { assetUpdated, jsonParams, takeParams, type TakeParams } from "./takes";
import { failTake, onRenderReady } from "./render-outcomes";

/*
 * The provider side of the visual loop (DESIGN §D media queue, §F): render.submit hands a QUEUED
 * take to deps.visual, render.poll asks how it is doing (re-enqueued with a growing 3-10s delay)
 * and, once it succeeded, downloads every output (MockProvider's are data: URLs),
 * stores it under assetStorageKey and marks the take READY for the Visual Director's review. Every
 * step acts only from the status it expects, so a repeated or stale job does nothing. Downloads go
 * through deps.fetch, the same injected fetch the provider calls with.
 */

/** Polls before a render that never settles is given up (≈15 minutes at the 10s ceiling). */
export const RENDER_POLL_MAX_ATTEMPTS = 90;

const SCENE_TEXT_MAX = 300;

type RenderAsset = Asset & {
  client: { name: string; visualStyle: unknown };
  post: { id: string; copy: unknown } | null;
  campaign: { status: string } | null;
};

function loadRenderAsset(deps: Deps, assetId: string): Promise<RenderAsset | null> {
  return deps.prisma.asset.findUnique({
    where: { id: assetId },
    include: {
      client: { select: { name: true, visualStyle: true } },
      post: { select: { id: true, copy: true } },
      campaign: { select: { status: true } },
    },
  });
}

/** The words the shot illustrates, for providers that label their renders (MockProvider does). */
export function sceneTextFor(copy: CopywriterOutput | null, shot: Shot): string | null {
  if (!copy) return null;
  let text: string | null = null;
  if (shot.sceneIndex !== null) {
    const scene = copy.script?.scenes.find((candidate) => candidate.index === shot.sceneIndex);
    text = scene ? scene.overlayText.trim() || scene.voiceover : null;
  } else if (shot.slideIndex !== null) {
    text = copy.slides?.find((candidate) => candidate.index === shot.slideIndex)?.headline ?? null;
  } else {
    text = copy.onScreenText;
  }
  return text ? text.slice(0, SCENE_TEXT_MAX) : null;
}

function visualRequest(asset: RenderAsset, shot: Shot): VisualRequest {
  const copy =
    asset.post?.copy === null || asset.post?.copy === undefined
      ? null
      : parseStored(CopywriterOutput, asset.post.copy, `Post ${asset.post.id}.copy`);
  return {
    kind: asset.kind,
    prompt: asset.prompt,
    negativePrompt: asset.negativePrompt,
    aspectRatio: shot.aspectRatio,
    durationSec: asset.kind === "VIDEO" ? shot.durationSec : null,
    seed: shot.seed,
    referenceImageUrl: null,
    brand: {
      name: asset.client.name,
      tokens: parseStored(VisualStyleTokens, asset.client.visualStyle, `Client ${asset.clientId}`),
    },
    meta: { shotId: shot.shotId, sceneText: sceneTextFor(copy, shot), version: asset.version },
  };
}

function enqueuePoll(deps: Deps, data: RenderPollJob): Promise<string> {
  return enqueueRenderPoll(deps.queues, data, {
    delayMs: renderPollDelayMs(deps.config, data.attempt),
  });
}

/** render.submit: QUEUED → RENDERING with the provider's job id, then the first poll. */
export async function submitRender(deps: Deps, assetId: string): Promise<void> {
  const asset = await loadRenderAsset(deps, assetId);
  if (!asset || asset.campaign?.status === "ARCHIVED") return;
  if (asset.status === "RENDERING" && asset.providerJobId) {
    // An earlier attempt of this job submitted but failed to queue the first poll.
    await enqueuePoll(deps, { assetId, attempt: 1 });
    return;
  }
  if (asset.status !== "QUEUED") return;
  const params = takeParams(asset);
  if (params.pendingDirection) return;
  if (!params.shot) {
    await failTake(deps, assetId, "FAILED", "the take has no shot to render");
    return;
  }

  const submitted = await deps.visual.submit(visualRequest(asset, params.shot));
  const [updated] = await deps.prisma.asset.updateManyAndReturn({
    where: { id: assetId, status: "QUEUED" },
    data: {
      status: "RENDERING",
      provider: deps.visual.name,
      providerJobId: submitted.jobId,
      providerModel: submitted.model,
    },
  });
  if (!updated) {
    // Someone else moved the take on (a duplicate job, a superseding re-plan): drop ours.
    await deps.visual.cancel?.(submitted.jobId).catch(() => undefined);
    return;
  }
  await assetUpdated(new EventBatch(), updated).publish(deps);
  await enqueuePoll(deps, { assetId, attempt: 1 });
}

/** render.poll: re-poll, store the output, or hand a failed render to the loop. */
export async function pollRender(deps: Deps, job: RenderPollJob): Promise<void> {
  const asset = await loadRenderAsset(deps, job.assetId);
  if (!asset || asset.status !== "RENDERING" || !asset.providerJobId) return;

  const status = await deps.visual.status(asset.providerJobId);
  switch (status.state) {
    case "queued":
    case "running":
      if (job.attempt >= RENDER_POLL_MAX_ATTEMPTS) {
        await failTake(
          deps,
          asset.id,
          "FAILED",
          `the render didn't finish after ${job.attempt} polls`,
        );
        return;
      }
      await enqueuePoll(deps, { assetId: asset.id, attempt: job.attempt + 1 });
      return;
    case "failed":
      await failTake(deps, asset.id, "FAILED", status.error ?? "the provider reported a failure");
      return;
    case "rejected":
      await failTake(
        deps,
        asset.id,
        "REJECTED",
        status.error ?? "the provider refused the content",
      );
      return;
    case "succeeded":
      await storeRender(deps, asset, status.outputs ?? []);
      return;
  }
}

/**
 * The still's pixel size, after decoding every pixel of it: the header alone reads fine on a
 * truncated download, which the review could then never decode. Failing here lets the poll's
 * retry download it again (and its last attempt fail the take).
 */
async function imageSize(bytes: Buffer): Promise<{ width: number; height: number } | null> {
  const image = sharp(bytes, { failOn: "error" });
  await image.stats();
  const { width, height } = await image.metadata();
  return width && height ? { width, height } : null;
}

/** Copies the provider's outputs into our Storage and marks the take READY. */
async function storeRender(deps: Deps, asset: RenderAsset, outputs: VisualOutput[]) {
  const [main, ...rest] = outputs;
  if (!main) {
    await failTake(deps, asset.id, "FAILED", "the provider returned no file");
    return;
  }
  const params = takeParams(asset);
  const file = await downloadOutput(main, deps.fetch);
  const isImage = file.mimeType.startsWith("image/");
  const posterOutput = isImage ? undefined : rest.find((o) => o.mimeType.startsWith("image/"));
  const poster = posterOutput ? await downloadOutput(posterOutput, deps.fetch) : null;

  const still = isImage ? file : poster;
  const size =
    (still ? await imageSize(still.bytes) : null) ??
    (params.shot ? pixelSizeFor(params.shot.aspectRatio) : null);

  const key = assetStorageKey({
    clientId: asset.clientId,
    assetId: asset.id,
    mimeType: file.mimeType,
  });
  const { url } = await deps.storage.put(key, file.bytes, file.mimeType);
  let posterUrl: string | null = asset.kind === "VIDEO" && isImage ? url : null;
  const stored: TakeParams = { ...params };
  if (poster) {
    const posterKey = assetStorageKey({
      clientId: asset.clientId,
      assetId: asset.id,
      mimeType: poster.mimeType,
      poster: true,
    });
    posterUrl = (await deps.storage.put(posterKey, poster.bytes, poster.mimeType)).url;
    stored.posterStorageKey = posterKey;
  }

  const [ready] = await deps.prisma.asset.updateManyAndReturn({
    where: { id: asset.id, status: "RENDERING" },
    data: {
      status: "READY",
      storageKey: key,
      url,
      posterUrl,
      mimeType: file.mimeType,
      width: size?.width ?? null,
      height: size?.height ?? null,
      durationSec: asset.kind === "VIDEO" ? (params.shot?.durationSec ?? null) : null,
      bytes: file.bytes.length,
      params: jsonParams(stored),
    },
  });
  if (!ready) return;
  // The take is stored; a lost review enqueue is re-driven by the sweeper, not by failing the job.
  await afterCommit(deps, "announcing a rendered take", () =>
    assetUpdated(new EventBatch(), ready).publish(deps),
  );
  await afterCommit(deps, "queueing a take's review", () => onRenderReady(deps, ready.id));
}
