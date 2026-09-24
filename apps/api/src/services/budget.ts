import { BudgetExceeded, type LlmUsage, type RunnerHooks } from "@enmo/agents";
import type { DbClient, DbTransaction } from "@enmo/db";
import { costUsdMicros, pricingFor, type BudgetDto } from "@enmo/shared";
import type { Deps } from "../deps";
import { DAY_MS } from "../lib/clock";
import { publishGlobal } from "../orchestrator/events";

/*
 * The daily token budget (DESIGN §C "Runner" step 1): today's (UTC, from deps.clock) TokenUsage
 * row against DAILY_TOKEN_CAP. The runner calls check() before every LLM attempt and record()
 * after it; a task whose check fails waits in BLOCKED_BUDGET until the sweeper sees room again.
 */

type Db = DbClient | DbTransaction;

/** Midnight UTC of the instant's day (TokenUsage.day). */
export function utcDayStart(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

/** "YYYY-MM-DD" (UTC). */
export function utcDay(instant: Date): string {
  return utcDayStart(instant).toISOString().slice(0, 10);
}

export function nextUtcMidnight(instant: Date): Date {
  return new Date(utcDayStart(instant).getTime() + DAY_MS);
}

/** Input + output tokens spent on the UTC day of `instant` (cache traffic doesn't count). */
export async function tokensUsedOn(db: Db, instant: Date): Promise<number> {
  const row = await db.tokenUsage.findUnique({
    where: { day: utcDayStart(instant) },
    select: { inputTokens: true, outputTokens: true },
  });
  return row ? Number(row.inputTokens + row.outputTokens) : 0;
}

/** True while today's spend is below the cap, i.e. an LLM call would be allowed. */
export async function hasBudgetToday(deps: Pick<Deps, "prisma" | "clock" | "config">) {
  return (await tokensUsedOn(deps.prisma, deps.clock.now())) < deps.config.DAILY_TOKEN_CAP;
}

/** GET /budget: used, cap, remaining, tasks waiting in BLOCKED_BUDGET and the next reset. */
export async function getBudget(deps: Deps): Promise<BudgetDto> {
  const now = deps.clock.now();
  const [used, blockedTasks] = await Promise.all([
    tokensUsedOn(deps.prisma, now),
    deps.prisma.agentTask.count({ where: { status: "BLOCKED_BUDGET" } }),
  ]);
  const cap = deps.config.DAILY_TOKEN_CAP;
  return {
    day: utcDay(now),
    used,
    cap,
    remaining: Math.max(0, cap - used),
    blockedTasks,
    resetsAt: nextUtcMidnight(now).toISOString(),
  };
}

/** The runner's budget hooks: the cap check and the TokenUsage ledger (plus budget.updated). */
export function budgetHooks(deps: Deps): RunnerHooks["budget"] {
  return {
    async check() {
      const now = deps.clock.now();
      const used = await tokensUsedOn(deps.prisma, now);
      const cap = deps.config.DAILY_TOKEN_CAP;
      if (used >= cap) throw new BudgetExceeded({ day: utcDay(now), used, cap });
    },
    async record(usage: LlmUsage) {
      await recordTokenUsage(deps, usage);
      await publishGlobal(deps, "budget.updated", await getBudget(deps));
    },
  };
}

/** Adds one call to today's TokenUsage row (INSERT … ON CONFLICT, so concurrent calls add up). */
export async function recordTokenUsage(
  deps: Pick<Deps, "prisma" | "clock" | "config">,
  usage: LlmUsage,
): Promise<void> {
  const day = utcDayStart(deps.clock.now());
  const counts = {
    inputTokens: BigInt(usage.inputTokens),
    outputTokens: BigInt(usage.outputTokens),
    cacheReadTokens: BigInt(usage.cacheReadTokens),
    cacheWriteTokens: BigInt(usage.cacheWriteTokens),
    costUsdMicros: BigInt(costUsdMicros(usage, pricingFor(deps.config.ANTHROPIC_MODEL))),
  };
  await deps.prisma.tokenUsage.upsert({
    where: { day },
    create: { day, ...counts, calls: 1 },
    update: {
      inputTokens: { increment: counts.inputTokens },
      outputTokens: { increment: counts.outputTokens },
      cacheReadTokens: { increment: counts.cacheReadTokens },
      cacheWriteTokens: { increment: counts.cacheWriteTokens },
      costUsdMicros: { increment: counts.costUsdMicros },
      calls: { increment: 1 },
    },
  });
}
