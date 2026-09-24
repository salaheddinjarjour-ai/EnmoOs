"use client";

import { VerbatimText, type BudgetDto, type TaskGraphDto } from "@enmo/shared";
import { useState } from "react";
import { formatCalendarDay } from "@/components/post/format";
import { PlatformChips, PostTypeChip } from "@/components/post/PlatformChips";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { FormAlert } from "@/components/ui/Field";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { formatDateTime } from "@/components/ui/time";
import { useToast } from "@/components/ui/Toast";
import { budgetUse, formatTokens, useBudget } from "@/hooks/useBudget";
import { useApprovePlan, useRequestPlanChanges, useTaskGraph } from "@/hooks/useTaskGraph";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";

/*
 * The plan, for a human to approve BEFORE any generation spend (DESIGN "Plan approval"): the
 * plain-language summary, every planned post, and the code-computed estimate against what is left
 * of today's token budget. Approving (MANAGER+) creates the posts and starts the Arsenal; anyone
 * who can brief may ask for a new version, with their words passed to the Manager verbatim.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const RESET_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

const FEEDBACK_MAX = 4000;

export function PlanCard({ graphId, version }: { graphId: string; version: number }) {
  const graph = useTaskGraph(graphId);

  if (graph.isPending) {
    return (
      <section
        aria-label={`Plan v${version}`}
        aria-busy="true"
        className="flex flex-col gap-4 rounded-xl border border-line bg-panel px-5 py-4"
      >
        <Skeleton className="h-5 w-40" />
        <SkeletonText lines={3} />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }
  if (graph.isError) {
    return (
      <section aria-label={`Plan v${version}`} className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(graph.error)}</FormAlert>
        <Button size="sm" onClick={() => void graph.refetch()}>
          Try again
        </Button>
      </section>
    );
  }
  return <PlanBody graph={graph.data} />;
}

const STATUS_BADGE: Record<
  TaskGraphDto["status"],
  { label: string; tone: "muted" | "neutral" | "positive" | "warning" }
> = {
  PROPOSED: { label: "Awaiting approval", tone: "neutral" },
  APPROVED: { label: "Approved", tone: "positive" },
  COMPLETED: { label: "Completed", tone: "positive" },
  SUPERSEDED: { label: "Superseded", tone: "muted" },
  REJECTED: { label: "Rejected", tone: "muted" },
};

function PlanBody({ graph }: { graph: TaskGraphDto }) {
  // Owned here, not by PlanActions: approving unmounts the actions, and the mutation must still
  // hear back (its toast) after they are gone.
  const approve = useApprovePlan();
  const requestChanges = useRequestPlanChanges();
  const proposed = graph.status === "PROPOSED";
  const inactive = graph.status === "SUPERSEDED" || graph.status === "REJECTED";
  const badge = STATUS_BADGE[graph.status];

  return (
    <section
      aria-label={`Plan v${graph.version}`}
      className={cx(
        "flex flex-col gap-5 rounded-xl border bg-panel px-5 py-4 transition-opacity duration-300 ease-enmo",
        graph.status === "APPROVED" ? "border-enmo/40" : "border-line",
        inactive && "opacity-60",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2.5 font-display text-lg font-medium tracking-tight text-paper">
          The plan
          <span className="font-mono text-xs text-steel">v{graph.version}</span>
        </h3>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </header>

      {graph.changeRequest !== null ? (
        <blockquote className="border-l border-paper/20 pl-3 text-sm text-steel">
          <span className="mb-1 block font-mono text-[10px] tracking-[0.16em] uppercase">
            You asked
          </span>
          <span className="whitespace-pre-wrap text-paper/80">{graph.changeRequest}</span>
        </blockquote>
      ) : null}

      <p className="text-[15px] leading-relaxed whitespace-pre-line text-paper/90">
        {graph.summary}
      </p>

      <div className="flex flex-col gap-2">
        <h4 className="font-mono text-[11px] tracking-[0.16em] text-steel uppercase">
          {graph.posts.length} planned {graph.posts.length === 1 ? "post" : "posts"}
        </h4>
        <ol
          aria-label="Planned posts"
          className="flex max-h-96 flex-col divide-y divide-line overflow-y-auto rounded-lg border border-line"
        >
          {graph.posts.map((post) => (
            <li
              key={post.ref}
              className="grid grid-cols-[2.5rem_1fr] items-start gap-x-3 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[2.5rem_6.5rem_1fr_auto]"
            >
              <span className="font-mono text-xs text-paper">{post.ref}</span>
              <span className="flex items-center">
                <PostTypeChip type={post.type} />
              </span>
              <span className="col-span-2 text-sm leading-snug text-paper/85 sm:col-span-1">
                {post.angle}
              </span>
              <span className="col-span-2 flex items-center gap-2 sm:col-span-1 sm:justify-end">
                <PlatformChips platforms={post.platforms} compact />
                <span className="font-mono text-[11px] text-steel tabular-nums">
                  {formatCalendarDay(post.targetDate)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <EstimatePanel graph={graph} live={proposed} />

      {proposed ? (
        <PlanActions graph={graph} approve={approve} requestChanges={requestChanges} />
      ) : null}
      {graph.status === "APPROVED" && graph.approvedBy ? (
        <p className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
          Approved by {graph.approvedBy.name}
          {graph.approvedAt ? ` · ${formatDateTime(graph.approvedAt)}` : ""}
        </p>
      ) : null}
    </section>
  );
}

function EstimatePanel({ graph, live }: { graph: TaskGraphDto; live: boolean }) {
  const budget = useBudget();
  const { estimate } = graph;
  const tokens = estimate.inputTokens + estimate.outputTokens;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-void/50 px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h4 className="font-mono text-[11px] tracking-[0.16em] text-steel uppercase">Estimate</h4>
        <p className="font-mono text-xs text-paper tabular-nums">
          {estimate.calls} calls · {formatTokens(estimate.inputTokens)} in ·{" "}
          {formatTokens(estimate.outputTokens)} out · {USD.format(estimate.usd)}
        </p>
      </div>
      {live && budget.data ? <BudgetComparison tokens={tokens} budget={budget.data} /> : null}
      {live && budget.isPending ? <Skeleton className="h-1.5 w-full" /> : null}
    </div>
  );
}

function BudgetComparison({ tokens, budget }: { tokens: number; budget: BudgetDto }) {
  const over = tokens > budget.remaining;
  const used = budgetUse(budget);
  const planShare = budget.cap > 0 ? Math.min(1 - used.fraction, tokens / budget.cap) : 0;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="meter"
        aria-label="Today's token budget with this plan"
        aria-valuemin={0}
        aria-valuemax={budget.cap}
        aria-valuenow={Math.min(budget.cap, budget.used + tokens)}
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-paper/[0.06]"
      >
        <span className="h-full bg-steel/60" style={{ width: `${used.fraction * 100}%` }} />
        <span
          className={cx("h-full", over ? "bg-amber-300/80" : "bg-paper/70")}
          style={{ width: `${planShare * 100}%` }}
        />
      </div>
      <p className={cx("text-xs leading-relaxed", over ? "text-amber-100" : "text-steel")}>
        {over ? (
          <>
            <strong className="font-medium">Over today&apos;s remaining budget.</strong> This plan
            needs about {formatTokens(tokens)} tokens and {formatTokens(budget.remaining)} are left
            of {formatTokens(budget.cap)}. Work past the cap waits for the reset at{" "}
            {RESET_TIME.format(new Date(budget.resetsAt))} UTC.
          </>
        ) : (
          <>
            About {formatTokens(tokens)} of the {formatTokens(budget.remaining)} tokens left today (
            {formatTokens(budget.cap)} daily cap).
          </>
        )}
      </p>
    </div>
  );
}

function PlanActions({
  graph,
  approve,
  requestChanges,
}: {
  graph: TaskGraphDto;
  approve: ReturnType<typeof useApprovePlan>;
  requestChanges: ReturnType<typeof useRequestPlanChanges>;
}) {
  const toast = useToast();
  const canApprove = useCan("plan.approve");
  const canRequest = useCan("plan.requestChanges");
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  function approvePlan() {
    approve.mutate(graph.id, {
      onSuccess: () =>
        toast.success("Plan approved", "The Arsenal is on it. Progress shows here live."),
    });
  }

  function sendChanges() {
    // Validated as sent: the feedback is never trimmed on its way to the Manager.
    if (!VerbatimText.safeParse(feedback).success) {
      setFeedbackError("Say what should change");
      return;
    }
    setFeedbackError(null);
    requestChanges.mutate(
      { graphId: graph.id, feedback },
      {
        onSuccess: () => {
          setEditing(false);
          setFeedback("");
          toast.success("Sent to the Manager", "A new version of the plan is on its way.");
        },
      },
    );
  }

  const error = approve.error ?? requestChanges.error;
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      {editing ? (
        <div className="flex flex-col gap-3">
          <Textarea
            label="What should change in the plan?"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={4}
            maxLength={FEEDBACK_MAX}
            showCount
            autoFocus
            placeholder="Swap two carousels for reels and keep everything inside the first two weeks."
            hint="Sent to the Manager exactly as you write it."
            error={feedbackError}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={sendChanges} loading={requestChanges.isPending}>
              Send to the Manager
            </Button>
            <Button
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={requestChanges.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {canApprove ? (
            <Button variant="primary" onClick={approvePlan} loading={approve.isPending}>
              Approve plan
            </Button>
          ) : null}
          {canRequest ? (
            <Button onClick={() => setEditing(true)} disabled={approve.isPending}>
              Request changes
            </Button>
          ) : null}
        </div>
      )}
      {canApprove ? (
        <p className="text-xs text-steel">
          Nothing is generated until the plan is approved. Approving starts the spend.
        </p>
      ) : (
        <p className="text-xs text-steel">
          A Manager or Admin approves plans, because approval starts the generation spend.
        </p>
      )}
      {error ? <FormAlert>{errorMessage(error)}</FormAlert> : null}
    </div>
  );
}
