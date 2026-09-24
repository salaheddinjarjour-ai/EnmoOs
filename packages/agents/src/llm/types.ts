import type { z } from "zod";
import type { AgentName, LlmProviderName, TokenCounts } from "@enmo/shared";

/** `output_config.effort` levels. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface LlmSystemBlock {
  text: string;
  /** Put a prompt-cache breakpoint (`cache_control: {type: "ephemeral"}`) on this block. */
  cache: boolean;
}

export type LlmImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type LlmContentBlock =
  | { type: "text"; text: string }
  /** `data` is base64 (Visual Director review sends the render downscaled to 1568px). */
  | { type: "image"; mediaType: LlmImageMediaType; data: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
}

export interface LlmRequestMeta {
  agent: AgentName;
  action: string;
  /** 1-based contract attempt within one runAgent call. */
  attempt: number;
  /** The validated agent input. MockLlm builds its fixtures from it; real clients ignore it. */
  input: unknown;
}

export interface LlmRequest {
  model: string;
  maxTokens: number;
  effort: Effort;
  /** In order: the frozen agent prompt, then the brand block (cached). */
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  /** The contract's JSON-schema-safe output schema, sent as `output_config.format`. */
  outputSchema: z.ZodType;
  meta: LlmRequestMeta;
}

export type LlmStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

/** Billed token counts for one call (input excludes cache reads/writes). */
export type LlmUsage = TokenCounts;

/** `stop_details` of a `refusal` stop. */
export interface LlmRefusal {
  /** The policy category (e.g. "cyber"), when the API names one. */
  category: string | null;
  explanation: string | null;
}

export interface LlmResponse {
  /** The concatenated text blocks: the JSON the runner parses. */
  text: string;
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** The model that actually served the call. */
  model: string;
  latencyMs: number;
  /** Set when stopReason is "refusal" and the provider explained it. */
  refusal?: LlmRefusal | null;
}

export interface LlmClient {
  readonly provider: LlmProviderName;
  /** Default model for requests (ANTHROPIC_MODEL). */
  readonly model: string;
  /** Resolves for any model reply (refusals and truncations included); rejects on transport errors. */
  complete(request: LlmRequest): Promise<LlmResponse>;
}
