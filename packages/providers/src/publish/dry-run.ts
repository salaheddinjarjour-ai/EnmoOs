import { setTimeout as delay } from "node:timers/promises";
import type { Platform } from "@enmo/shared";
import { PublishError } from "./errors";
import type {
  DecryptedAccount,
  PublishOutcome,
  PublishPayload,
  PublishResume,
  Publisher,
} from "./types";
import { assertPublishable } from "./validate";

/*
 * DryRunPublisher (DESIGN §F "Dry-run"): used whenever PUBLISH_MODE isn't "live", the job has no
 * account, or the platform has no credentials. It runs the same payload validation a live publish
 * does and answers with a simulated live URL, so the whole pipeline (slots, ticks, guards,
 * LIVE status, metric pull-back) runs without touching a platform.
 */

export const DRY_RUN_BASE_URL = "https://dryrun.enmo.marketing";
/** How long a simulated publish takes, so a job visibly passes through PUBLISHING. */
export const DRY_RUN_LATENCY_MS = 25;

export interface DryRunPublisherOptions {
  /** Default DRY_RUN_LATENCY_MS; 0 answers at once. */
  latencyMs?: number;
}

/** `https://dryrun.enmo.marketing/<platform>/<variantId>` */
export function dryRunLiveUrl(platform: Platform, variantId: string): string {
  return `${DRY_RUN_BASE_URL}/${platform.toLowerCase()}/${encodeURIComponent(variantId)}`;
}

export function dryRunExternalId(variantId: string): string {
  return `dryrun_${variantId}`;
}

export class DryRunPublisher implements Publisher {
  readonly mode = "dry-run" as const;
  readonly platform: Platform;
  readonly #latencyMs: number;

  constructor(platform: Platform, options: DryRunPublisherOptions = {}) {
    this.platform = platform;
    this.#latencyMs = options.latencyMs ?? DRY_RUN_LATENCY_MS;
  }

  publish(
    payload: PublishPayload,
    _account: DecryptedAccount | null,
    _resume: PublishResume,
  ): Promise<PublishOutcome> {
    return this.#simulate(payload);
  }

  /** A dry run never leaves anything processing; a resumed job simply completes. */
  poll(
    _containerId: string,
    _account: DecryptedAccount | null,
    payload: PublishPayload,
  ): Promise<PublishOutcome> {
    return this.#simulate(payload);
  }

  async #simulate(payload: PublishPayload): Promise<PublishOutcome> {
    // Validation comes first, like a live publish, which fails before any network call.
    const outcome = this.#outcome(payload);
    if (this.#latencyMs > 0) await delay(this.#latencyMs);
    return outcome;
  }

  #outcome(payload: PublishPayload): PublishOutcome {
    const valid = assertPublishable(payload);
    if (valid.platform !== this.platform) {
      throw new PublishError(
        "INVALID_PAYLOAD",
        `A ${valid.platform} payload reached the ${this.platform} publisher`,
        { issues: [{ path: "platform", message: `Expected ${this.platform}` }] },
      );
    }
    return {
      status: "published",
      externalId: dryRunExternalId(valid.variantId),
      liveUrl: dryRunLiveUrl(valid.platform, valid.variantId),
    };
  }
}
