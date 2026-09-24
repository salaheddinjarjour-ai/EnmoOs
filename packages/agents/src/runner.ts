import type { z } from "zod";
import { issuesFromZodError, type AgentName, type Issue, type RunOutcome } from "@enmo/shared";
import { agentKey, type AgentDefinition } from "./definition";
import {
  AgentEscalation,
  InvalidAgentInput,
  LlmRequestRejected,
  type EscalationReason,
} from "./errors";
import type {
  Effort,
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmSystemBlock,
  LlmUsage,
} from "./llm/types";
import { ZERO_USAGE, addUsage } from "./llm/usage";

/** Contract retries after the first attempt (3 attempts in total), then AgentEscalation. */
export const DEFAULT_MAX_RETRIES = 2;
/** After a `max_tokens` stop the next attempt gets max_tokens × 1.5, capped here. */
export const MAX_TOKENS_GROWTH = 1.5;
export const MAX_TOKENS_CAP = 32_000;
/** AgentRun.responseText is truncated to this many characters. */
export const RESPONSE_TEXT_CAP = 64 * 1024;
/** Issues listed in one correction turn; the rest are summarised (the escalation keeps them all). */
export const CORRECTION_ISSUE_LIMIT = 40;

/** One LLM attempt, as the recorder persists it (one AgentRun row). */
export interface AgentRunRecord {
  agent: AgentName;
  action: string;
  /** 1-based. */
  attempt: number;
  model: string;
  promptVersion: string;
  outcome: RunOutcome;
  stopReason: string | null;
  /** The validated agent input, revision feedback included (the verbatim-feedback tests read it). */
  inputSnapshot: unknown;
  /** Capped at RESPONSE_TEXT_CAP; null when the call failed before a reply. */
  responseText: string | null;
  /** Schema and business-rule issues of this attempt; null when it passed. */
  validationErrors: Issue[] | null;
  usage: LlmUsage;
  latencyMs: number;
}

/**
 * The runner's side effects, supplied by the orchestrator: it binds task/campaign/client ids into
 * the recorder and owns the TokenUsage ledger behind the budget.
 */
export interface RunnerHooks {
  budget: {
    /** Throws BudgetExceeded when today's input + output tokens ≥ DAILY_TOKEN_CAP. */
    check(): Promise<void>;
    /** Adds one call's usage to today's TokenUsage row. */
    record(usage: LlmUsage): Promise<void>;
  };
  recorder: {
    recordRun(run: AgentRunRecord): Promise<void>;
  };
}

export interface RunAgentOptions extends RunnerHooks {
  llm: LlmClient;
  /** Defaults to DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
  /** Defaults to llm.model. */
  model?: string;
  /** AGENT_EFFORT_<AGENT> override; defaults to the definition's effort. */
  effort?: Effort;
}

export interface AgentResult<O> {
  output: O;
  /** Attempts used, including the successful one. */
  attempts: number;
  /** Summed over every attempt. */
  usage: LlmUsage;
  model: string;
}

type Verdict<O> =
  | { kind: "ok"; output: O }
  | { kind: "refused" }
  | { kind: "truncated"; issues: Issue[]; canGrow: boolean }
  | { kind: "invalid"; issues: Issue[] };

/**
 * Runs one agent action under its contract (DESIGN §C): per attempt, budget check → LLM call →
 * record → stop_reason handling → JSON.parse + output.safeParse + validate; failing issues are fed
 * back for the complete corrected JSON. Throws BudgetExceeded or AgentEscalation; transport
 * errors propagate for BullMQ to retry.
 */
export async function runAgent<I, O>(
  def: AgentDefinition<I, O>,
  rawInput: I,
  options: RunAgentOptions,
): Promise<AgentResult<O>> {
  const parsedInput = def.input.safeParse(rawInput);
  if (!parsedInput.success) {
    throw new InvalidAgentInput({
      agent: def.agent,
      action: def.action,
      issues: issuesFromZodError(parsedInput.error),
    });
  }
  const input = parsedInput.data;
  const outputSchema = def.outputFor?.(input) ?? def.output;
  const model = options.model ?? options.llm.model;
  const effort = options.effort ?? def.effort;
  const maxAttempts = 1 + Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
  const system = systemBlocks(def.systemPrompt, def.brandBlock(input));
  const messages: LlmMessage[] = [{ role: "user", content: def.userMessage(input) }];

  let maxTokens = Math.min(def.maxTokens, MAX_TOKENS_CAP);
  let usage: LlmUsage = { ...ZERO_USAGE };
  let last: { reason: EscalationReason; issues: Issue[] } = {
    reason: "INVALID_OUTPUT",
    issues: [],
  };

  const record = (
    run: Omit<AgentRunRecord, "agent" | "action" | "promptVersion" | "inputSnapshot">,
  ) =>
    options.recorder.recordRun({
      agent: def.agent,
      action: def.action,
      promptVersion: def.promptVersion,
      inputSnapshot: input,
      ...run,
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await options.budget.check();

    const request: LlmRequest = {
      model,
      maxTokens,
      effort,
      system,
      messages: [...messages],
      outputSchema,
      meta: { agent: def.agent, action: def.action, attempt, input },
    };

    const started = Date.now();
    let response: LlmResponse;
    try {
      response = await options.llm.complete(request);
    } catch (error) {
      // Recording is best effort here: the caller must see the provider's error, not ours.
      await record({
        attempt,
        model,
        outcome: "API_ERROR",
        stopReason: null,
        responseText: null,
        validationErrors: null,
        usage: { ...ZERO_USAGE },
        latencyMs: Date.now() - started,
      }).catch(() => undefined);
      if (error instanceof LlmRequestRejected) {
        throw new AgentEscalation({
          agent: def.agent,
          action: def.action,
          reason: "API_ERROR",
          issues: [
            { path: "", message: `The model provider rejected the request: ${error.message}` },
          ],
        });
      }
      throw error;
    }

    usage = addUsage(usage, response.usage);
    const verdict = judge(def, outputSchema, input, response, maxTokens);

    await record({
      attempt,
      model: response.model,
      outcome: outcomeOf(verdict),
      stopReason: response.stopReason,
      responseText: response.text.slice(0, RESPONSE_TEXT_CAP),
      validationErrors: verdict.kind === "ok" || verdict.kind === "refused" ? null : verdict.issues,
      usage: response.usage,
      latencyMs: response.latencyMs,
    });
    await options.budget.record(response.usage);

    switch (verdict.kind) {
      case "ok":
        return { output: verdict.output, attempts: attempt, usage, model: response.model };
      case "refused":
        throw new AgentEscalation({
          agent: def.agent,
          action: def.action,
          reason: "REFUSED",
          issues: [],
          message: refusalMessage(agentKey(def), response),
        });
      case "truncated":
        last = { reason: "TRUNCATED", issues: verdict.issues };
        if (!verdict.canGrow) {
          throw new AgentEscalation({ agent: def.agent, action: def.action, ...last });
        }
        // The same conversation again with more room; the partial JSON is not worth echoing.
        maxTokens = Math.min(Math.ceil(maxTokens * MAX_TOKENS_GROWTH), MAX_TOKENS_CAP);
        break;
      case "invalid":
        last = { reason: "INVALID_OUTPUT", issues: verdict.issues };
        // An empty assistant turn is rejected by the API; the correction then stands alone.
        if (response.text.trim()) messages.push({ role: "assistant", content: response.text });
        messages.push({ role: "user", content: correctionMessage(verdict.issues) });
        break;
    }
  }

  throw new AgentEscalation({
    agent: def.agent,
    action: def.action,
    reason: last.reason,
    issues: last.issues,
  });
}

/** The frozen prompt, then the brand block; the cache breakpoint sits on the last block. */
function systemBlocks(systemPrompt: string, brandBlock: string | null): LlmSystemBlock[] {
  return brandBlock === null
    ? [{ text: systemPrompt, cache: true }]
    : [
        { text: systemPrompt, cache: false },
        { text: brandBlock, cache: true },
      ];
}

function judge<I, O>(
  def: AgentDefinition<I, O>,
  outputSchema: z.ZodType<O>,
  input: I,
  response: LlmResponse,
  maxTokens: number,
): Verdict<O> {
  switch (response.stopReason) {
    case "refusal":
      return { kind: "refused" };
    case "max_tokens":
      return {
        kind: "truncated",
        canGrow: true,
        issues: [
          {
            path: "",
            message: `The reply was cut off at max_tokens (${maxTokens}) before the JSON was complete.`,
          },
        ],
      };
    case "model_context_window_exceeded":
      // More output room cannot help when the context itself is full.
      return {
        kind: "truncated",
        canGrow: false,
        issues: [
          { path: "", message: "The reply was cut off: the model's context window is full." },
        ],
      };
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
    case "pause_turn":
      break;
  }

  let json: unknown;
  try {
    json = JSON.parse(response.text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      issues: [
        {
          path: "",
          message: `The reply is not valid JSON (${reason}). Reply with exactly one JSON object and nothing else.`,
        },
      ],
    };
  }

  const parsed = outputSchema.safeParse(json);
  if (!parsed.success) return { kind: "invalid", issues: issuesFromZodError(parsed.error) };

  const issues = def.validate(parsed.data, input);
  return issues.length > 0 ? { kind: "invalid", issues } : { kind: "ok", output: parsed.data };
}

function outcomeOf(verdict: Verdict<unknown>): RunOutcome {
  switch (verdict.kind) {
    case "ok":
      return "OK";
    case "refused":
      return "REFUSED";
    case "truncated":
      return "TRUNCATED";
    case "invalid":
      return "INVALID_OUTPUT";
  }
}

/** The user turn that asks for the corrected output (DESIGN §C step 5). */
export function correctionMessage(issues: readonly Issue[]): string {
  const listed = issues
    .slice(0, CORRECTION_ISSUE_LIMIT)
    .map((issue) => `- ${issue.path || "(whole reply)"}: ${issue.message}`);
  const hidden = issues.length - listed.length;
  if (hidden > 0) listed.push(`- …and ${hidden} more issue${hidden === 1 ? "" : "s"} like these.`);
  return [
    "Your reply was rejected by the output contract. Fix every issue below, keep everything that was already right, and reply with the complete corrected JSON object: every field, not only the changed ones, and no commentary.",
    "",
    ...listed,
  ].join("\n");
}

function refusalMessage(key: string, response: LlmResponse): string {
  const details = [response.refusal?.category, response.refusal?.explanation].filter(Boolean);
  return `${key} escalated (REFUSED${details.length > 0 ? `: ${details.join(" — ")}` : ""})`;
}
