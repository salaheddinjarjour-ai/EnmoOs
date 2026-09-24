"use client";

import type { AlertKind, PostDto } from "@enmo/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { RelativeTime } from "@/components/ui/time";
import { budgetUse, formatTokens, useBudget } from "@/hooks/useBudget";
import { useLiveAlerts, type LiveAlert } from "@/lib/realtime";

/*
 * What needs a human (MASTER_PLAN §03 "failure/stuck alerts"): the daily token budget when work
 * is waiting on it, posts flagged needsAttention (escalations, failures), and alerts that arrived
 * live this session about things the other two don't cover (a Manager step that failed, an
 * expiring token). Dismissing a live alert only hides it here.
 */

const KIND_LABEL: Readonly<Record<AlertKind, string>> = {
  stuck: "Stuck",
  failed: "Failed",
  escalated: "Escalated",
  budget: "Budget",
  token_expiring: "Token",
};

function relevantLiveAlerts(
  alerts: readonly LiveAlert[],
  attention: readonly PostDto[],
  clientId: string | undefined,
): LiveAlert[] {
  const campaignsWithAttention = new Set(attention.map((post) => post.campaignId));
  return alerts.filter((alert) => {
    if (clientId && alert.clientId !== clientId) return false;
    // The budget line and the flagged posts already carry these.
    if (alert.kind === "budget") return false;
    if (
      (alert.entityType === "AgentTask" || alert.entityType === "Post") &&
      alert.campaignId &&
      campaignsWithAttention.has(alert.campaignId)
    ) {
      return false;
    }
    return true;
  });
}

export function AlertsPanel({
  posts,
  clientId,
  hideWhenClear = false,
}: {
  posts: readonly PostDto[];
  clientId?: string;
  /** Render nothing (rather than "All clear") when no alert is open. */
  hideWhenClear?: boolean;
}) {
  const budget = useBudget();
  const { alerts, dismissAlert } = useLiveAlerts();
  const attention = posts.filter((post) => post.needsAttention || post.failed);
  const live = relevantLiveAlerts(alerts, attention, clientId);
  const use = budget.data ? budgetUse(budget.data) : null;
  const budgetAlert =
    budget.data && (use?.exhausted || budget.data.blockedTasks > 0) ? budget.data : null;
  const count = attention.length + live.length + (budgetAlert ? 1 : 0);
  if (count === 0 && hideWhenClear) return null;

  return (
    <section aria-label="Alerts" className="flex flex-col gap-3">
      <h2 className="flex items-baseline gap-2.5 font-display text-base font-medium tracking-tight text-paper">
        Alerts
        <span className="font-mono text-[11px] text-steel">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="rounded-xl border border-line bg-panel/50 px-4 py-3 text-sm text-steel">
          All clear. Nothing is waiting on a human.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {budgetAlert ? (
            <AlertRow kind="Budget">
              {use?.exhausted
                ? `Today's token budget is spent (${formatTokens(budgetAlert.used)}/${formatTokens(budgetAlert.cap)}).`
                : `${formatTokens(budgetAlert.remaining)} tokens left today.`}{" "}
              {budgetAlert.blockedTasks > 0
                ? `${budgetAlert.blockedTasks} ${budgetAlert.blockedTasks === 1 ? "task waits" : "tasks wait"} for the reset at UTC midnight.`
                : ""}
            </AlertRow>
          ) : null}
          {attention.map((post) => (
            <AlertRow
              key={post.id}
              kind={post.failed ? "Failed" : "Attention"}
              action={
                <Link
                  href={`/brief/${encodeURIComponent(post.campaignId)}`}
                  className="text-xs text-steel underline decoration-steel/40 underline-offset-4 hover:text-paper"
                >
                  Open thread
                </Link>
              }
            >
              <span className="font-mono text-paper">{post.ref}</span>{" "}
              {post.attentionReason ?? "needs a human."}
            </AlertRow>
          ))}
          {live.map((alert) => (
            <AlertRow
              key={alert.id}
              kind={KIND_LABEL[alert.kind]}
              meta={<RelativeTime iso={alert.receivedAt} />}
              action={
                <button
                  type="button"
                  onClick={() => dismissAlert(alert.id)}
                  className="text-xs text-steel underline decoration-steel/40 underline-offset-4 hover:text-paper"
                >
                  Dismiss
                </button>
              }
            >
              {alert.message}
              {alert.campaignId ? (
                <>
                  {" "}
                  <Link
                    href={`/brief/${encodeURIComponent(alert.campaignId)}`}
                    className="text-steel underline decoration-steel/40 underline-offset-4 hover:text-paper"
                  >
                    Thread
                  </Link>
                </>
              ) : null}
            </AlertRow>
          ))}
        </ul>
      )}
    </section>
  );
}

function AlertRow({
  kind,
  meta,
  action,
  children,
}: {
  kind: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      className={cx(
        "flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.03] px-4 py-3",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 font-mono text-[10px] tracking-[0.16em] whitespace-nowrap text-amber-200 uppercase">
          {kind}
        </span>
        <p className="min-w-0 text-sm leading-relaxed text-paper/85">{children}</p>
      </div>
      <div className="flex items-center gap-3 font-mono text-[10px] text-steel">
        {meta}
        {action}
      </div>
    </li>
  );
}
