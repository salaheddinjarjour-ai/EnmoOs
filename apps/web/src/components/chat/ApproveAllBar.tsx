"use client";

import type { ApprovalRequestDto } from "@enmo/shared";
import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useApproveAll } from "@/hooks/useApprovals";
import { errorMessage } from "@/lib/api";
import { useCan, useSession } from "@/lib/auth";

/*
 * The one shortcut past per-post review (MASTER_PLAN §01): a logged one-click "approve all" of the
 * current step of every post waiting on the viewer. The click is the decision, so there is no
 * confirmation dialog; the bar says up front that it is logged. It never skips a chain step; the
 * API writes one approval.approve_all audit row and marks each decision as made through it.
 * MANAGER+ only.
 */

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function ApproveAllBar({ requests }: { requests: readonly ApprovalRequestDto[] }) {
  const toast = useToast();
  const { user } = useSession();
  const canApproveAll = useCan("approvals.approveAll");
  const approveAll = useApproveAll();
  const noteId = useId();

  const eligible = requests.filter((request) => request.status === "PENDING" && request.canDecide);
  if (!canApproveAll || (eligible.length === 0 && !approveAll.isPending)) return null;
  const count = eligible.length;

  function approve() {
    approveAll.mutate(
      eligible.map((request) => request.id),
      {
        onSuccess: (result) => {
          const moved =
            result.pendingCount > 0
              ? ` ${plural(result.pendingCount, "post")} moved on to the next step of the chain.`
              : "";
          const skipped =
            result.skippedCount > 0 ? ` ${plural(result.skippedCount, "post")} skipped.` : "";
          toast.success(
            `${plural(result.approvedCount, "post")} approved`,
            `Logged to the audit trail as one approve-all by ${user.name}.${moved}${skipped}`,
          );
        },
        onError: (error) => toast.error("Approve all failed", errorMessage(error)),
      },
    );
  }

  return (
    <div
      role="region"
      aria-label="Approve all"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel/95 px-4 py-3 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.9)] backdrop-blur"
    >
      <p id={noteId} className="text-sm text-paper/90">
        <span className="font-mono text-paper">{count}</span>{" "}
        {count === 1 ? "post is" : "posts are"} waiting for your approval.
        <span className="ml-2 text-xs text-steel">
          One click approves your step on each, logged as one approve-all.
        </span>
      </p>
      <Button
        variant="primary"
        size="sm"
        onClick={approve}
        loading={approveAll.isPending}
        disabled={count === 0}
        aria-describedby={noteId}
      >
        Approve all {count}
      </Button>
    </div>
  );
}
