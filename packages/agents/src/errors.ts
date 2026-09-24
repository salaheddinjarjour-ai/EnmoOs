import type { AgentName, Issue, RunOutcome } from "@enmo/shared";

/**
 * Why the runner gave up (the AgentRun outcomes that end in a human). API_ERROR is a request the
 * provider rejected as malformed (HTTP 400/413): resending it can never succeed, so it escalates
 * instead of burning queue retries.
 */
export type EscalationReason = Extract<
  RunOutcome,
  "INVALID_OUTPUT" | "REFUSED" | "TRUNCATED" | "API_ERROR"
>;

/**
 * The agent could not produce an acceptable output within its retries (or refused). The task
 * becomes ESCALATED, the post needs attention and the Manager posts an ESCALATION message.
 */
export class AgentEscalation extends Error {
  override readonly name = "AgentEscalation";
  readonly agent: AgentName;
  readonly action: string;
  /** The last attempt's issues (empty for a refusal). */
  readonly issues: Issue[];
  readonly reason: EscalationReason;

  constructor(details: {
    agent: AgentName;
    action: string;
    issues: Issue[];
    reason: EscalationReason;
    message?: string;
  }) {
    super(
      details.message ??
        `${details.agent}.${details.action} escalated (${details.reason}, ${details.issues.length} issue${details.issues.length === 1 ? "" : "s"})`,
    );
    this.agent = details.agent;
    this.action = details.action;
    this.issues = details.issues;
    this.reason = details.reason;
  }
}

/**
 * Today's (UTC) input + output tokens reached DAILY_TOKEN_CAP. The task becomes BLOCKED_BUDGET and
 * the sweeper re-queues it after UTC midnight.
 */
export class BudgetExceeded extends Error {
  override readonly name = "BudgetExceeded";
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly used: number;
  readonly cap: number;

  constructor(details: { day: string; used: number; cap: number }) {
    super(`Daily token budget reached for ${details.day}: ${details.used}/${details.cap} tokens`);
    this.day = details.day;
    this.used = details.used;
    this.cap = details.cap;
  }
}

/**
 * The provider rejected the request itself (HTTP 400 or 413: prompt too long, unsupported schema,
 * …). Unlike 429/5xx/connection errors, retrying the identical request cannot help, so LlmClients
 * throw this and the runner escalates with reason API_ERROR.
 */
export class LlmRequestRejected extends Error {
  override readonly name = "LlmRequestRejected";
  readonly status: number;

  constructor(details: { status: number; message: string; cause?: unknown }) {
    super(details.message, { cause: details.cause });
    this.status = details.status;
  }
}

/**
 * The orchestrator built an input the definition's schema rejects: a bug upstream, not something a
 * model retry can fix. Thrown before any LLM call or budget check.
 */
export class InvalidAgentInput extends Error {
  override readonly name = "InvalidAgentInput";
  readonly agent: AgentName;
  readonly action: string;
  readonly issues: Issue[];

  constructor(details: { agent: AgentName; action: string; issues: Issue[] }) {
    const first = details.issues[0];
    super(
      `${details.agent}.${details.action} input is invalid` +
        (first ? `: ${first.path || "(input)"}: ${first.message}` : ""),
    );
    this.agent = details.agent;
    this.action = details.action;
    this.issues = details.issues;
  }
}
