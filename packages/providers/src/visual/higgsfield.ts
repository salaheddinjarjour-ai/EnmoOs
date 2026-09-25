import { z } from "zod";
import type { VisualCapabilities } from "@enmo/shared";
import { mimeTypeForKey } from "../storage/keys";
import type {
  VisualJobStatus,
  VisualOutput,
  VisualProvider,
  VisualRequest,
  VisualSubmitResult,
} from "./types";

/*
 * HiggsfieldProvider (DESIGN §F), over Higgsfield's REST API through an injected fetch (never the
 * SDK, so tests aim it at a fake server):
 *   POST {baseUrl}/{model}                 → { request_id, status }
 *   GET  {baseUrl}/requests/{id}/status    → { status: queued | in_progress | completed | failed |
 *                                              nsfw | canceled, images?: [{url}], video?: {url} }
 *   POST {baseUrl}/requests/{id}/cancel    (only while the request is still queued)
 * every call carrying `Authorization: Key KEY_ID:KEY_SECRET`. Model ids come from env. Outputs are
 * Higgsfield's public CDN URLs, which the pipeline downloads into our own Storage. Phase 5 U3
 * checks the model inputs against the fake Higgsfield server.
 */

export interface HiggsfieldConfig {
  keyId: string | null;
  keySecret: string | null;
  /** HIGGSFIELD_BASE_URL, without a trailing slash (a fake server's URL in tests). */
  baseUrl: string;
  imageModel: string | null;
  videoModel: string | null;
}

export interface HiggsfieldProviderOptions extends HiggsfieldConfig {
  fetch: typeof globalThis.fetch;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** The longest clip the video model renders. Default 10 s. */
  maxVideoSec?: number;
}

export const HIGGSFIELD_DEFAULT_TIMEOUT_MS = 30_000;
export const HIGGSFIELD_DEFAULT_MAX_VIDEO_SEC = 10;

/** A Higgsfield call that failed; `retryable` says whether the same call may succeed later. */
export class HiggsfieldError extends Error {
  override readonly name = "HiggsfieldError";
  /** The HTTP status, when Higgsfield answered at all. */
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number | null; retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status ?? null;
    this.retryable = options.retryable;
  }
}

const SubmitResponse = z.object({ request_id: z.string().min(1) });

const StatusResponse = z.object({
  status: z.string(),
  images: z
    .array(z.object({ url: z.url() }))
    .nullish()
    .transform((images) => images ?? []),
  video: z.object({ url: z.url() }).nullish(),
  error: z.string().nullish(),
});

export class HiggsfieldProvider implements VisualProvider {
  readonly name = "higgsfield" as const;
  readonly options: HiggsfieldProviderOptions;

  constructor(options: HiggsfieldProviderOptions) {
    this.options = options;
  }

  capabilities(): VisualCapabilities {
    const video = this.options.videoModel !== null;
    return {
      image: this.options.imageModel !== null,
      video,
      maxVideoSec: video ? (this.options.maxVideoSec ?? HIGGSFIELD_DEFAULT_MAX_VIDEO_SEC) : 0,
    };
  }

  async submit(request: VisualRequest): Promise<VisualSubmitResult> {
    const model = request.kind === "VIDEO" ? this.options.videoModel : this.options.imageModel;
    if (!model) {
      const variable =
        request.kind === "VIDEO" ? "HIGGSFIELD_VIDEO_MODEL" : "HIGGSFIELD_IMAGE_MODEL";
      const message = `Higgsfield cannot render ${request.kind}: ${variable} is not set`;
      throw new HiggsfieldError(message, { retryable: false });
    }
    const path = model
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(encodeURIComponent)
      .join("/");
    const response = await this.#call("submit", "POST", path, requestBody(request));
    const body = await parseJson(response, SubmitResponse, "submit");
    return { jobId: body.request_id, model };
  }

  async status(jobId: string): Promise<VisualJobStatus> {
    const path = `requests/${encodeURIComponent(jobId)}/status`;
    const response = await this.#call("status", "GET", path, null, { notFoundOk: true });
    if (response.status === 404) {
      return { state: "failed", error: `Higgsfield has no request ${jobId}` };
    }
    return toJobStatus(await parseJson(response, StatusResponse, "status"));
  }

  /** Best effort: a request that already started or finished can't be cancelled, and that's fine. */
  async cancel(jobId: string): Promise<void> {
    await this.#call("cancel", "POST", `requests/${encodeURIComponent(jobId)}/cancel`, null, {
      notCancellableOk: true,
    });
  }

  async #call(
    operation: string,
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | null,
    accept: { notFoundOk?: boolean; notCancellableOk?: boolean } = {},
  ): Promise<Response> {
    const { keyId, keySecret } = this.options;
    if (!keyId || !keySecret) {
      throw new HiggsfieldError(
        "HiggsfieldProvider needs HIGGSFIELD_CREDENTIALS (or HIGGSFIELD_KEY_ID and HIGGSFIELD_KEY_SECRET)",
        { retryable: false },
      );
    }
    const timeoutMs = this.options.timeoutMs ?? HIGGSFIELD_DEFAULT_TIMEOUT_MS;
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/${path}`;
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers: {
          Authorization: `Key ${keyId}:${keySecret}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new HiggsfieldError(
        timedOut
          ? `Higgsfield ${operation} timed out after ${timeoutMs} ms`
          : `Higgsfield ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, cause: error },
      );
    }

    if (response.ok) return response;
    if (response.status === 404 && accept.notFoundOk) return response;
    // Higgsfield answers 400 for a request that is already running or done; 404 once it's gone.
    if (accept.notCancellableOk && [400, 404, 409, 422].includes(response.status)) return response;
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new HiggsfieldError(
      `Higgsfield ${operation} answered ${response.status}${detail ? `: ${detail}` : ""}`,
      { status: response.status, retryable: isRetryableStatus(response.status) },
    );
  }
}

/** The model input: prompt, aspect ratio and the optional seed, clip length and source image. */
function requestBody(request: VisualRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
    ...(request.seed === null ? {} : { seed: request.seed }),
    ...(request.kind === "VIDEO" && request.durationSec !== null
      ? { duration: Math.ceil(request.durationSec) }
      : {}),
    ...(request.referenceImageUrl
      ? { input_images: [{ type: "image_url", image_url: request.referenceImageUrl }] }
      : {}),
  };
}

function toJobStatus(body: z.output<typeof StatusResponse>): VisualJobStatus {
  switch (body.status) {
    case "queued":
      return { state: "queued" };
    case "in_progress":
      return { state: "running" };
    case "completed": {
      // The render first; a video's still frames, if any, after it (VisualJobStatus.outputs).
      const outputs: VisualOutput[] = [
        ...(body.video ? [output(body.video.url, "video/mp4")] : []),
        ...body.images.map((image) => output(image.url, "image/png")),
      ];
      return outputs.length > 0
        ? { state: "succeeded", outputs }
        : { state: "failed", error: "Higgsfield completed the request without any output" };
    }
    case "failed":
      return { state: "failed", error: body.error ?? "Higgsfield failed to render the request" };
    case "nsfw":
      return {
        state: "rejected",
        error: body.error ?? "Higgsfield's content filter rejected the render (nsfw)",
      };
    case "canceled":
    case "cancelled":
      return { state: "failed", error: "The Higgsfield request was cancelled" };
    default:
      throw new HiggsfieldError(`Higgsfield status answered an unknown status "${body.status}"`, {
        retryable: false,
      });
  }
}

/** The output's type from its URL's extension, or the kind's usual type when it has none. */
function output(url: string, fallback: string): VisualOutput {
  const fromPath = mimeTypeForKey(new URL(url).pathname);
  return { url, mimeType: fromPath === "application/octet-stream" ? fallback : fromPath };
}

async function parseJson<T extends z.ZodType>(
  response: Response,
  schema: T,
  operation: string,
): Promise<z.output<T>> {
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new HiggsfieldError(`Higgsfield ${operation} answered with invalid JSON`, {
      status: response.status,
      retryable: true,
      cause: error,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HiggsfieldError(
      `Higgsfield ${operation} answered an unexpected body: ${z.prettifyError(parsed.error)}`,
      { status: response.status, retryable: false },
    );
  }
  return parsed.data;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
