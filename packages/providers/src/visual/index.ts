import type { VisualProviderName } from "@enmo/shared";
import { HiggsfieldProvider, type HiggsfieldConfig } from "./higgsfield";
import { MockProvider, type MockProviderOptions } from "./mock";
import type { VisualProvider } from "./types";

export { downloadOutput, type DownloadedOutput } from "./download";
export {
  HIGGSFIELD_DEFAULT_MAX_VIDEO_SEC,
  HIGGSFIELD_DEFAULT_TIMEOUT_MS,
  HiggsfieldError,
  HiggsfieldProvider,
  type HiggsfieldConfig,
  type HiggsfieldProviderOptions,
} from "./higgsfield";
export {
  MOCK_MAX_VIDEO_SEC,
  MockProvider,
  type MockOutcome,
  type MockProviderOptions,
} from "./mock";

export interface VisualProviderConfig {
  /** VISUAL_PROVIDER. */
  provider: VisualProviderName;
  /** HIGGSFIELD_*; read only when provider is "higgsfield". */
  higgsfield: HiggsfieldConfig;
}

export interface VisualProviderDeps {
  /** HTTP for real providers; tests inject one aimed at a fake server. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** MockProvider tuning (tests shorten or lengthen its poll count). */
  mock?: MockProviderOptions;
}

/**
 * Whether takes rendered by `provider` (Asset.provider) are placeholders rather than generated
 * images: MockProvider draws branded cards (imaging/placeholder.ts), which the Visual Director's
 * review can only judge on their frame and palette. A new provider generates real images.
 */
export function rendersPlaceholders(provider: string): boolean {
  return provider === ("mock" satisfies VisualProviderName);
}

/**
 * The VisualProvider for VISUAL_PROVIDER (DESIGN §F). Swapping providers is this one switch plus
 * the provider's own file. Construction does no I/O and never throws: every API and worker process
 * builds one at boot, and a provider missing its credentials reports that from submit().
 */
export function createVisualProvider(
  config: VisualProviderConfig,
  deps: VisualProviderDeps = {},
): VisualProvider {
  switch (config.provider) {
    case "mock":
      return new MockProvider(deps.mock);
    case "higgsfield":
      return new HiggsfieldProvider({
        ...config.higgsfield,
        fetch: deps.fetch ?? globalThis.fetch,
      });
  }
}
