import { randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import {
  AspectRatio,
  AssetKind,
  BrandFont,
  OverlayPosition,
  pixelSizeFor,
  type VisualCapabilities,
} from "@enmo/shared";
import { renderPlaceholder } from "../imaging/placeholder";
import type { VisualJobStatus, VisualProvider, VisualRequest, VisualSubmitResult } from "./types";

/*
 * MockProvider (DESIGN §F): renders a branded PNG placeholder with sharp (imaging/placeholder.ts)
 * at the shot's aspect ratio and reports success on the second status() poll, so the async path is
 * exercised. A VIDEO shot gets a poster PNG (the pipeline marks it Asset.params.mockVideo).
 *
 * Jobs are stateless: the job id carries everything the render needs, so status() answers in any
 * process, e.g. a worker polling a job an API process submitted. The only process-local state is
 * the poll count behind "running first, then succeeded" and a small cache of finished renders; a
 * process that has not seen a job before starts its count afresh, which only delays success.
 * Outputs are `data:image/png;base64,…` URLs, which plain `fetch` downloads like any provider's.
 */

/** The longest clip MockProvider accepts; it answers VIDEO shots with a poster frame. */
export const MOCK_MAX_VIDEO_SEC = 10;

/** How a simulated job ends instead of succeeding. */
export interface MockOutcome {
  state: "failed" | "rejected";
  error: string;
}

export interface MockProviderOptions {
  /** status() polls that report `running` before the job settles (DESIGN: success on poll 2). */
  pollsBeforeSuccess?: number;
  /**
   * Decides at submit time how a job ends, so tests can drive the failed and rejected paths;
   * null (or no hook) lets it succeed. The decision travels inside the job id.
   */
  outcome?: (request: VisualRequest) => MockOutcome | null;
}

const JOB_ID_PREFIX = "mock_";
/** Enough prompt for the placeholder's detail line, which shows fewer characters than this. */
const PROMPT_EXCERPT_CHARS = 400;
const MAX_JOB_BYTES = 64 * 1024;
const MAX_TRACKED_POLLS = 10_000;
const MAX_CACHED_RENDERS = 16;

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const MockJob = z.object({
  v: z.literal(1),
  /** Makes every submit a distinct job, like a real provider's ids, even for identical requests. */
  nonce: z.string(),
  kind: AssetKind,
  aspectRatio: AspectRatio,
  durationSec: z.number().positive().nullable(),
  seed: z.int().nullable(),
  brand: z.string(),
  palette: z.object({
    primary: Hex,
    secondary: Hex,
    accent: Hex,
    background: Hex,
    text: Hex,
  }),
  fonts: z.object({ display: BrandFont, body: BrandFont }),
  position: OverlayPosition,
  shotId: z.string(),
  sceneText: z.string().nullable(),
  prompt: z.string(),
  version: z.int().positive(),
  outcome: z.object({ state: z.enum(["failed", "rejected"]), error: z.string() }).nullable(),
});
type MockJob = z.infer<typeof MockJob>;

export class MockProvider implements VisualProvider {
  readonly name = "mock" as const;
  readonly options: MockProviderOptions;
  readonly #pollsBeforeSuccess: number;
  readonly #polls = new Map<string, number>();
  readonly #renders = new Map<string, Promise<Buffer>>();

  constructor(options: MockProviderOptions = {}) {
    this.options = options;
    const polls = options.pollsBeforeSuccess ?? 1;
    if (!Number.isInteger(polls) || polls < 0) {
      throw new RangeError(`pollsBeforeSuccess must be a whole number ≥ 0, got ${polls}`);
    }
    this.#pollsBeforeSuccess = polls;
  }

  capabilities(): VisualCapabilities {
    return { image: true, video: true, maxVideoSec: MOCK_MAX_VIDEO_SEC };
  }

  async submit(request: VisualRequest): Promise<VisualSubmitResult> {
    if (request.kind === "VIDEO" && (request.durationSec ?? 0) > MOCK_MAX_VIDEO_SEC) {
      throw new RangeError(
        `MockProvider renders clips of up to ${MOCK_MAX_VIDEO_SEC}s, not ${request.durationSec}s`,
      );
    }
    const job = jobFor(request, this.options.outcome?.(request) ?? null);
    const jobId = `${JOB_ID_PREFIX}${deflateRawSync(JSON.stringify(job)).toString("base64url")}`;
    // Rendering now surfaces a broken request (or font setup) at submit, as a provider's 4xx would.
    if (!job.outcome) await this.#render(jobId, job);
    return { jobId, model: null };
  }

  async status(jobId: string): Promise<VisualJobStatus> {
    const job = decodeJob(jobId);
    if (!job) return { state: "failed", error: `MockProvider has no job ${jobId.slice(0, 48)}` };

    const polls = (this.#polls.get(jobId) ?? 0) + 1;
    remember(this.#polls, jobId, polls, MAX_TRACKED_POLLS);
    if (polls <= this.#pollsBeforeSuccess) return { state: "running" };
    if (job.outcome) return { state: job.outcome.state, error: job.outcome.error };

    const png = await this.#render(jobId, job);
    // The caller copies the output into Storage; a repeat poll re-renders the same bytes.
    this.#renders.delete(jobId);
    return {
      state: "succeeded",
      outputs: [{ url: `data:image/png;base64,${png.toString("base64")}`, mimeType: "image/png" }],
    };
  }

  #render(jobId: string, job: MockJob): Promise<Buffer> {
    const cached = this.#renders.get(jobId);
    if (cached) return cached;
    const render = renderJob(job);
    remember(this.#renders, jobId, render, MAX_CACHED_RENDERS);
    render.catch(() => this.#renders.delete(jobId));
    return render;
  }
}

function jobFor(request: VisualRequest, outcome: MockOutcome | null): MockJob {
  const { tokens } = request.brand;
  return MockJob.parse({
    v: 1,
    nonce: randomBytes(6).toString("base64url"),
    kind: request.kind,
    aspectRatio: request.aspectRatio,
    durationSec: request.kind === "VIDEO" ? request.durationSec : null,
    seed: request.seed,
    brand: request.brand.name,
    palette: tokens.palette,
    fonts: tokens.typography,
    position: tokens.overlay.position,
    shotId: request.meta.shotId,
    sceneText: request.meta.sceneText,
    prompt: request.prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_EXCERPT_CHARS),
    version: request.meta.version,
    outcome,
  } satisfies MockJob);
}

function decodeJob(jobId: string): MockJob | null {
  if (!jobId.startsWith(JOB_ID_PREFIX)) return null;
  try {
    const json = inflateRawSync(Buffer.from(jobId.slice(JOB_ID_PREFIX.length), "base64url"), {
      maxOutputLength: MAX_JOB_BYTES,
    }).toString("utf8");
    const parsed = MockJob.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function renderJob(job: MockJob): Promise<Buffer> {
  const { width, height } = pixelSizeFor(job.aspectRatio);
  return renderPlaceholder({
    width,
    height,
    palette: job.palette,
    fonts: job.fonts,
    text: job.sceneText,
    detail: job.prompt,
    footer: `MOCK · ${job.shotId} · v${job.version}`,
    label: job.brand,
    tag: job.aspectRatio,
    position: job.position,
    seed: job.seed,
    video: job.kind === "VIDEO" ? { durationSec: job.durationSec } : null,
  });
}

/** Sets key → value as the newest entry, dropping the oldest entries beyond max. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}
