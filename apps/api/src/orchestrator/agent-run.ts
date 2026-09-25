import {
  getAgentDefinition,
  runAgent,
  type AgentDefinition,
  type AgentDefinitions,
  type AgentKey,
  type AgentResult,
  type AgentRunRecord,
  type LlmImageBlock,
} from "@enmo/agents";
import type { Deps } from "../deps";
import { budgetHooks } from "../services/budget";
import { jsonOrDbNull } from "./messages";

/*
 * The orchestrator's single way into @enmo/agents: resolves the definition, applies the
 * AGENT_EFFORT_<AGENT> override and binds the runner's hooks to the database (an AgentRun row per
 * attempt, the TokenUsage ledger, AgentTask.contractAttempts).
 */

export type AgentInput<K extends AgentKey> =
  AgentDefinitions[K] extends AgentDefinition<infer I, infer _O> ? I : never;
export type AgentOutput<K extends AgentKey> =
  AgentDefinitions[K] extends AgentDefinition<infer _I, infer O> ? O : never;

/** What the AgentRun rows of this call belong to. */
export interface RunContext {
  taskId: string | null;
  campaignId: string | null;
  clientId: string | null;
}

export interface RunAgentForOptions {
  /** Images ahead of the input (VISUAL_DIRECTOR.review's render, via toReviewImage). */
  images?: readonly LlmImageBlock[];
}

export function runAgentFor<K extends AgentKey>(
  deps: Deps,
  key: K,
  input: AgentInput<K>,
  context: RunContext,
  options: RunAgentForOptions = {},
): Promise<AgentResult<AgentOutput<K>>> {
  const definition = getAgentDefinition(key) as unknown as AgentDefinition<
    AgentInput<K>,
    AgentOutput<K>
  >;
  return runAgent(definition, input, {
    llm: deps.llm,
    budget: budgetHooks(deps),
    recorder: { recordRun: (run) => recordAgentRun(deps, run, context) },
    effort: deps.config.AGENT_EFFORT[definition.agent],
    ...(options.images ? { images: options.images } : {}),
  });
}

export async function recordAgentRun(
  deps: Pick<Deps, "prisma">,
  run: AgentRunRecord,
  context: RunContext,
): Promise<void> {
  const create = deps.prisma.agentRun.create({
    data: {
      taskId: context.taskId,
      campaignId: context.campaignId,
      clientId: context.clientId,
      agent: run.agent,
      action: run.action,
      attempt: run.attempt,
      model: run.model,
      promptVersion: run.promptVersion,
      outcome: run.outcome,
      stopReason: run.stopReason,
      inputSnapshot: jsonOrDbNull(run.inputSnapshot),
      responseText: run.responseText,
      validationErrors: jsonOrDbNull(run.validationErrors),
      inputTokens: run.usage.inputTokens,
      outputTokens: run.usage.outputTokens,
      cacheReadTokens: run.usage.cacheReadTokens,
      cacheWriteTokens: run.usage.cacheWriteTokens,
      latencyMs: Math.round(run.latencyMs),
    },
    select: { id: true },
  });
  if (!context.taskId) {
    await create;
    return;
  }
  await deps.prisma.$transaction([
    create,
    deps.prisma.agentTask.update({
      where: { id: context.taskId },
      data: { contractAttempts: { increment: 1 } },
      select: { id: true },
    }),
  ]);
}
