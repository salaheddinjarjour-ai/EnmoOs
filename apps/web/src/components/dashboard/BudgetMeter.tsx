"use client";

import { cx } from "@/components/ui/cx";
import { budgetUse, formatTokens, useBudget } from "@/hooks/useBudget";

/*
 * Today's token spend against DAILY_TOKEN_CAP, in the Topbar (GET /budget, kept current by
 * budget.updated events). Neutral until it gets tight; blocked tasks are named, because they are
 * the ones waiting for the UTC reset.
 */

const RESET = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function BudgetMeter() {
  const budget = useBudget();
  if (!budget.data) return null;
  const { used, cap, remaining, blockedTasks, resetsAt } = budget.data;
  const use = budgetUse(budget.data);
  const title = [
    `${used.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")} tokens used today (UTC)`,
    `${remaining.toLocaleString("en-US")} left; resets at ${RESET.format(new Date(resetsAt))} UTC`,
    blockedTasks > 0 ? `${blockedTasks} tasks waiting for the reset` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="meter"
      aria-label="Daily token budget"
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={Math.min(used, cap)}
      aria-valuetext={`${formatTokens(used)} of ${formatTokens(cap)} tokens used today`}
      title={title}
      className="hidden items-center gap-2.5 sm:flex"
    >
      <span className="font-mono text-[10px] tracking-[0.16em] text-steel uppercase">Tokens</span>
      <span className="flex h-1 w-20 overflow-hidden rounded-full bg-paper/[0.08]">
        <span
          className={cx(
            "h-full transition-[width] duration-300 ease-enmo",
            use.exhausted ? "bg-red-400" : use.tight ? "bg-amber-300" : "bg-paper/60",
          )}
          style={{ width: `${use.fraction * 100}%` }}
        />
      </span>
      <span
        className={cx(
          "font-mono text-[11px] tabular-nums",
          use.exhausted ? "text-red-300" : use.tight ? "text-amber-200" : "text-steel",
        )}
      >
        {formatTokens(used)}/{formatTokens(cap)}
      </span>
      {blockedTasks > 0 ? (
        <span className="font-mono text-[10px] tracking-[0.12em] text-amber-200 uppercase">
          {blockedTasks} waiting
        </span>
      ) : null}
    </div>
  );
}
