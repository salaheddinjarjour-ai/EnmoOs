/*
 * Model pricing, in one place. Used for plan estimates (task-graph.ts), the TokenUsage.costUsdMicros
 * ledger and the budget meter. The daily cap itself is counted in tokens, not dollars.
 */

export const DEFAULT_LLM_MODEL = "claude-sonnet-5";

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  /** Prompt-cache reads (0.1× input). */
  cacheRead: number;
  /** Prompt-cache writes with the default 5-minute TTL (1.25× input). */
  cacheWrite: number;
}

/** Claude Sonnet 5 list prices (Anthropic API, 2026): $2 in / $10 out per MTok. */
export const SONNET_5_PRICING: Readonly<ModelPricing> = Object.freeze({
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
});

const MODEL_PRICING: Readonly<Record<string, Readonly<ModelPricing>>> = {
  "claude-sonnet-5": SONNET_5_PRICING,
};

/** Unknown models (and the mock) are priced as Sonnet 5, so estimates never read as free. */
export function pricingFor(model: string): Readonly<ModelPricing> {
  return MODEL_PRICING[model] ?? SONNET_5_PRICING;
}

/**
 * Token counts as the API bills them: `inputTokens` excludes cache reads and writes, which are
 * billed separately.
 */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost in integer micro-dollars (TokenUsage.costUsdMicros). $/MTok equals µ$/token. */
export function costUsdMicros(
  usage: TokenCounts,
  pricing: Readonly<ModelPricing> = SONNET_5_PRICING,
): number {
  return Math.round(
    usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheWriteTokens * pricing.cacheWrite,
  );
}

export function costUsd(usage: TokenCounts, pricing?: Readonly<ModelPricing>): number {
  return costUsdMicros(usage, pricing) / 1_000_000;
}
