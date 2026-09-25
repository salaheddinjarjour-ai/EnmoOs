import type {
  AspectRatio,
  AssetKind,
  VisualCapabilities,
  VisualProviderName,
  VisualStyleTokens,
} from "@enmo/shared";

/*
 * The visual provider abstraction (DESIGN §F). Rendering is always asynchronous: submit() queues a
 * job, the media queue polls status() until the job settles, then downloads every output into our
 * own Storage. Adding a provider means one new file implementing VisualProvider and one new case in
 * createVisualProvider (./index.ts); nothing else in the pipeline knows which one is active.
 */

/** The brand the render is for: MockProvider paints its placeholder from these tokens. */
export interface VisualBrand {
  name: string;
  tokens: VisualStyleTokens;
}

/** Where the render sits in the pipeline; providers may only use it for labels and logs. */
export interface VisualRequestMeta {
  /** The Visual Director's shot id ("s2"); MockProvider prints it in its footer. */
  shotId: string;
  /** The words the shot illustrates (scene voiceover/overlay, slide headline, on-screen text). */
  sceneText: string | null;
  /** The Asset version this render becomes (1 for the first take). */
  version: number;
}

export interface VisualRequest {
  kind: AssetKind;
  prompt: string;
  /** null when the shot has nothing to exclude. */
  negativePrompt: string | null;
  /** The output size follows from it (pixelSizeFor in @enmo/shared). */
  aspectRatio: AspectRatio;
  /** VIDEO only; null for IMAGE. */
  durationSec: number | null;
  seed: number | null;
  /** Image-to-image / image-to-video source, when the provider supports one. */
  referenceImageUrl: string | null;
  brand: VisualBrand;
  meta: VisualRequestMeta;
}

export interface VisualSubmitResult {
  /** The provider's job id, stored as Asset.providerJobId and passed back to status(). */
  jobId: string;
  /** The model that took the job (Asset.providerModel); null when the provider has only one. */
  model: string | null;
}

export type VisualJobState = "queued" | "running" | "succeeded" | "failed" | "rejected";

/**
 * One rendered file. `url` is fetchable with plain `fetch`: an https URL for real providers, a
 * `data:` URL for MockProvider, so downloading into Storage is the same code for every provider.
 */
export interface VisualOutput {
  url: string;
  mimeType: string;
}

export interface VisualJobStatus {
  /** `rejected`: the provider refused the content (e.g. Higgsfield's nsfw); retrying won't help. */
  state: VisualJobState;
  /** Set when state is `succeeded`: the render first (a VIDEO's poster, if any, after it). */
  outputs?: VisualOutput[];
  /** Why the job failed or was rejected, as the provider put it. */
  error?: string;
}

export interface VisualProvider {
  /** Stored as Asset.provider. */
  readonly name: VisualProviderName;
  /** What it can render; the Visual Director plans shots within these limits. */
  capabilities(): VisualCapabilities;
  submit(request: VisualRequest): Promise<VisualSubmitResult>;
  status(jobId: string): Promise<VisualJobStatus>;
  /** Best effort; providers without cancellation leave it out. */
  cancel?(jobId: string): Promise<void>;
}
