import type { CapabilitiesResponse } from "@enmo/shared";
import { configuredIntegrations, type Config } from "../config";

/*
 * GET /v1/capabilities: which runtime modes are active and which integrations have credentials,
 * so the web app can show mode chips and hide flows that cannot work yet. Never includes secrets.
 */

export function describeCapabilities(config: Config): CapabilitiesResponse {
  return {
    llm: {
      provider: config.LLM_PROVIDER,
      // The mock provider never calls ANTHROPIC_MODEL, so naming it would mislead.
      model: config.LLM_PROVIDER === "anthropic" ? config.ANTHROPIC_MODEL : "mock",
    },
    visual: { provider: config.VISUAL_PROVIDER },
    publish: { mode: config.PUBLISH_MODE },
    storage: { driver: config.STORAGE_DRIVER },
    pipelineActions: [...config.PIPELINE_ACTIONS],
    integrations: configuredIntegrations(config),
    dailyTokenCap: config.DAILY_TOKEN_CAP,
  };
}
