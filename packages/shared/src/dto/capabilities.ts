import { z } from "zod";
import { PipelineAction } from "../enums";

/* Runtime modes, parsed from env by the API config and shown as chips in the web Topbar. */

export const LlmProviderName = z.enum(["mock", "anthropic"]);
export type LlmProviderName = z.infer<typeof LlmProviderName>;

export const VisualProviderName = z.enum(["mock", "higgsfield"]);
export type VisualProviderName = z.infer<typeof VisualProviderName>;

export const PublishMode = z.enum(["dry-run", "live"]);
export type PublishMode = z.infer<typeof PublishMode>;

export const StorageDriver = z.enum(["local", "r2"]);
export type StorageDriver = z.infer<typeof StorageDriver>;

/** GET /v1/capabilities — modes and which integrations have credentials; never secrets. */
export const CapabilitiesResponse = z.object({
  llm: z.object({ provider: LlmProviderName, model: z.string() }),
  visual: z.object({ provider: VisualProviderName }),
  publish: z.object({ mode: PublishMode }),
  storage: z.object({ driver: StorageDriver }),
  pipelineActions: z.array(PipelineAction),
  integrations: z.object({
    anthropic: z.boolean(),
    meta: z.boolean(),
    tiktok: z.boolean(),
    higgsfield: z.boolean(),
    r2: z.boolean(),
  }),
  /** DAILY_TOKEN_CAP: the input+output token budget per UTC day across all agents. */
  dailyTokenCap: z.number().int().nonnegative(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponse>;

/** GET /v1/healthz — liveness only, no dependency checks (Render health check). */
export const HealthResponse = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof HealthResponse>;

/** GET /v1/readyz — 200 when every check passes, 503 otherwise. */
export const ReadyResponse = z.object({
  status: z.enum(["ok", "unavailable"]),
  checks: z.object({ database: z.boolean(), redis: z.boolean() }),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;
