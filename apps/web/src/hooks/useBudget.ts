import { BudgetDto } from "@enmo/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { queryKeys } from "./query-keys";

/*
 * Today's (UTC) token spend against DAILY_TOKEN_CAP (GET /budget). budget.updated events replace
 * the cached value as agents run, so the Topbar meter and the PlanCard stay current without polling.
 */
export function useBudget() {
  return useQuery({
    queryKey: queryKeys.budget,
    queryFn: ({ signal }) => api("/budget", { schema: BudgetDto, signal }),
    staleTime: 60_000,
  });
}

export interface BudgetUse {
  /** 0–1, capped. */
  fraction: number;
  /** At or past the cap: new agent work waits for the reset. */
  exhausted: boolean;
  /** Past 80%: worth a warning. */
  tight: boolean;
}

export function budgetUse(budget: Pick<BudgetDto, "used" | "cap">): BudgetUse {
  if (budget.cap <= 0) return { fraction: 1, exhausted: true, tight: true };
  const fraction = Math.min(1, budget.used / budget.cap);
  return { fraction, exhausted: budget.used >= budget.cap, tight: fraction >= 0.8 };
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 39600 → "39.6K" */
export function formatTokens(tokens: number): string {
  return COMPACT.format(tokens);
}
