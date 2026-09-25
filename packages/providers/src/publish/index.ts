import type { Platform, PublishMode } from "@enmo/shared";
import { metaConfigured, type MetaConfig } from "../meta/config";
import { DryRunPublisher } from "./dry-run";
import { MetaPublisher } from "./meta";
import type { Publisher } from "./types";

export {
  DRY_RUN_BASE_URL,
  DRY_RUN_LATENCY_MS,
  DryRunPublisher,
  dryRunExternalId,
  dryRunLiveUrl,
  type DryRunPublisherOptions,
} from "./dry-run";
export { PublishError, type PublishErrorCode } from "./errors";
export { publishFlowOf, type PublishFlow } from "./flow";
export {
  META_PLATFORMS,
  MetaPublisher,
  isMetaPlatform,
  type MetaPlatform,
  type MetaPublisherOptions,
} from "./meta";
export { isPublicHttpsUrl } from "./public-url";
export {
  assertPublishable,
  validatePublishPayload,
  type PublishValidationOptions,
} from "./validate";

export interface PublisherConfig {
  /** PUBLISH_MODE. */
  mode: PublishMode;
  /** META_*; read only for Instagram and Facebook in live mode. */
  meta: MetaConfig;
}

export interface PublisherDeps {
  /** HTTP for live publishers; tests inject one aimed at the fake Graph server. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Whether `platform` publishes for real: PUBLISH_MODE is "live" and the platform's app
 * credentials are set. TikTok stays simulated until its publisher lands (Phase 5).
 */
export function livePublishingAvailable(platform: Platform, config: PublisherConfig): boolean {
  if (config.mode !== "live") return false;
  switch (platform) {
    case "INSTAGRAM":
    case "FACEBOOK":
      return metaConfigured(config.meta);
    case "TIKTOK":
      return false;
  }
}

/**
 * Whether a job for `platform` is a dry run (PublishJob.dryRun, decided when it is scheduled): it
 * is unless the platform publishes live and the client has an account connected there.
 */
export function isDryRunPublish(
  platform: Platform,
  config: PublisherConfig,
  hasAccount: boolean,
): boolean {
  return !(hasAccount && livePublishingAvailable(platform, config));
}

/**
 * The Publisher for `platform` under PUBLISH_MODE (DESIGN §F): the live platform publisher when
 * livePublishingAvailable, else a DryRunPublisher. A job stored as a dry run always runs through
 * `new DryRunPublisher(platform)`, whatever the mode is now. Construction does no I/O and never
 * throws.
 */
export function createPublisher(
  platform: Platform,
  config: PublisherConfig,
  deps: PublisherDeps = {},
): Publisher {
  if (!livePublishingAvailable(platform, config)) return new DryRunPublisher(platform);
  switch (platform) {
    case "INSTAGRAM":
    case "FACEBOOK":
      return new MetaPublisher({
        ...config.meta,
        platform,
        fetch: deps.fetch ?? globalThis.fetch,
      });
    case "TIKTOK":
      return new DryRunPublisher(platform);
  }
}
