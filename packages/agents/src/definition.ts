import type { z } from "zod";
import type { AgentName, Issue } from "@enmo/shared";
import type { Effort, LlmContentBlock } from "./llm/types";

/**
 * One agent action (DESIGN §C): its contract, prompt and business rules. Definitions are pure
 * data plus pure functions; the runner does all I/O.
 */
export interface AgentDefinition<I, O> {
  readonly agent: AgentName;
  /** "intake", "plan", "qa", "write", … (AgentRun.action; fault keys are `${agent}.${action}`). */
  readonly action: string;
  /** Bumped whenever the prompt text changes; stored on every AgentRun. */
  readonly promptVersion: string;
  readonly effort: Effort;
  /** Starting max_tokens; the runner grows it ×1.5 (capped at 32k) after a truncation. */
  readonly maxTokens: number;
  readonly input: z.ZodType<I>;
  /** JSON-schema-safe output contract (see packages/shared/src/contracts/common.ts). */
  readonly output: z.ZodType<O>;
  /**
   * Picks a narrower output contract for this input, e.g. intake without the clarify branch once
   * the question has been asked. Defaults to `output`.
   */
  outputFor?(input: I): z.ZodType<O>;
  /** The frozen first system block (identical across calls, so it caches). */
  readonly systemPrompt: string;
  /** Second system block: the client's brand, banned words included ("never use"). Null if none. */
  brandBlock(input: I): string | null;
  /** The first user turn. */
  userMessage(input: I): string | LlmContentBlock[];
  /** Business rules the schema can't express; [] when the output is acceptable. */
  validate(output: O, input: I): Issue[];
}

/** `${agent}.${action}`: the MockLlm fixture key and the MOCK_LLM_FAULTS key. */
export function agentKey(def: Pick<AgentDefinition<unknown, unknown>, "agent" | "action">): string {
  return `${def.agent}.${def.action}`;
}

/**
 * DESIGN §C effort defaults: high for manager.plan, strategist and analyst; medium for
 * manager.intake, copywriter and visual direct; low for everything else. AGENT_EFFORT_<AGENT>
 * overrides reach the runner through RunAgentOptions.effort.
 */
export function defaultEffort(agent: AgentName, action: string): Effort {
  if ((agent === "MANAGER" && action === "plan") || agent === "STRATEGIST" || agent === "ANALYST") {
    return "high";
  }
  if (
    (agent === "MANAGER" && action === "intake") ||
    agent === "COPYWRITER" ||
    (agent === "VISUAL_DIRECTOR" && action === "direct")
  ) {
    return "medium";
  }
  return "low";
}

/** The effort for one call: the AGENT_EFFORT_<AGENT> override when set, else the definition's. */
export function resolveEffort(
  def: Pick<AgentDefinition<unknown, unknown>, "agent" | "effort">,
  overrides: Partial<Record<AgentName, Effort>>,
): Effort {
  return overrides[def.agent] ?? def.effort;
}
