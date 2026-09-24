import type { LlmProviderName } from "@enmo/shared";
import { AnthropicLlm } from "./anthropic";
import { MockLlm } from "./mock/index";
import type { LlmClient } from "./types";

export {
  AnthropicLlm,
  ANTHROPIC_MAX_RETRIES,
  outputFormatFor,
  toLlmResponse,
  toMessageParams,
} from "./anthropic";
export type { AnthropicLlmOptions } from "./anthropic";
export * from "./mock/index";
export { ZERO_USAGE, addUsage } from "./usage";

export interface LlmConfig {
  provider: LlmProviderName;
  /** Required for `anthropic`; never read from the environment by this package. */
  apiKey: string | null;
  /** Default model (ANTHROPIC_MODEL). */
  model: string;
  /** ENMO_ANTHROPIC_BASE_URL; passed explicitly so a shell's ANTHROPIC_BASE_URL is never used. */
  baseUrl: string;
  /** MOCK_LLM_FAULTS syntax, e.g. "COPYWRITER.write:invalid*2,VISUAL_DIRECTOR.review:weak*3". */
  faults: string | null;
  /** Injected fetch, for request-shape tests against a fake server. */
  fetch?: typeof globalThis.fetch;
  /** MockLlm only: artificial latency per call (ms), for demos of live progress. */
  mockDelayMs?: number;
}

/**
 * The LlmClient for LLM_PROVIDER: the Anthropic API or the deterministic MockLlm, which is also
 * the fallback when no API key is set. Construction must not fail or do I/O: every API and worker
 * process builds one at boot (apps/api deps.ts).
 */
export function createLlm(config: LlmConfig): LlmClient {
  const apiKey = config.apiKey?.trim();
  if (config.provider === "anthropic" && apiKey) {
    return new AnthropicLlm({
      apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }
  return new MockLlm({
    model: config.model,
    faults: config.faults,
    delayMs: config.mockDelayMs ?? 0,
  });
}
