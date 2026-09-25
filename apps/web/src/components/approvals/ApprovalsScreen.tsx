"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormAlert } from "@/components/ui/Field";
import { LoadingRegion, Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useApprovals, useApproveAll } from "@/hooks/useApprovals";
import { useCampaigns } from "@/hooks/useCampaigns";
import { useClients } from "@/hooks/useClients";
import { errorMessage } from "@/lib/api";
import { useCan, useSession } from "@/lib/auth";
import { ApprovalFilters } from "./ApprovalFilters";
import { ApprovalTile } from "./ApprovalTile";
import {
  approvalsSearch,
  filtersFromSearchParams,
  hasFilters,
  keepSelectable,
  NO_FILTERS,
  selectableIds,
  toApprovalListQuery,
  type ApprovalFilters as Filters,
} from "./approvals-model";

/*
 * The Approvals Queue (MASTER_PLAN §03): everything waiting on a human, across all clients, newest
 * first, filtered by client, platform and campaign (kept in the address). Each thumbnail approves
 * or requests changes on its own; rounds the viewer decides can also be selected and approved
 * together, after a confirmation, as one logged approve-all (MANAGER+, never skipping a chain
 * step). Nothing publishes without passing the chain.
 */

const GRID_CLASS = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function ApprovalsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const { user } = useSession();
  const filters = useMemo(() => filtersFromSearchParams(params), [params]);
  const approvals = useApprovals(toApprovalListQuery(filters));
  const clients = useClients();
  const campaigns = useCampaigns();
  const canBatch = useCan("approvals.approveAll");
  const canBrief = useCan("campaigns.create");
  const approveAll = useApproveAll();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const requests = useMemo(() => approvals.data ?? [], [approvals.data]);
  const mine = useMemo(() => (canBatch ? selectableIds(requests) : []), [canBatch, requests]);
  // Rounds that left the queue (or stopped waiting on the viewer) drop out of the selection.
  const selected = keepSelectable(chosen, requests);
  const allMineSelected = mine.length > 0 && mine.every((id) => selected.has(id));
  const waitingOnMe = requests.filter((request) => request.canDecide).length;

  const setFilters = (next: Filters) => {
    setChosen(new Set());
    router.replace(`${pathname}${approvalsSearch(next)}`, { scroll: false });
  };

  function toggle(id: string, on: boolean) {
    setChosen((current) => {
      const next = new Set(keepSelectable(current, requests));
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function approveSelected() {
    approveAll.mutate([...selected], {
      onSuccess: (result) => {
        setConfirming(false);
        setChosen(new Set());
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
    });
  }

  return (
    <>
      <PageHeader
        eyebrow="Approvals"
        title="Nothing speaks for a brand unapproved."
        description="Everything waiting on a human, across all clients, newest first. Approve from the thumbnails one by one, or select the posts waiting on you and approve them in one logged batch."
      />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <ApprovalFilters
          filters={filters}
          onChange={setFilters}
          clients={clients.data ?? []}
          campaigns={campaigns.data ?? []}
        />
        {mine.length > 0 ? (
          <Checkbox
            label={`Select all ${mine.length} waiting on you`}
            checked={allMineSelected}
            onChange={(event) => setChosen(new Set(event.target.checked ? mine : []))}
            className="mb-2.5"
          />
        ) : null}
      </div>

      {approvals.isPending ? (
        <LoadingRegion label="Loading approvals">
          <div className={GRID_CLASS}>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-52 w-full rounded-xl" />
            ))}
          </div>
        </LoadingRegion>
      ) : approvals.isError ? (
        <div className="flex flex-col items-start gap-4">
          <FormAlert>{errorMessage(approvals.error)}</FormAlert>
          <Button onClick={() => void approvals.refetch()}>Try again</Button>
        </div>
      ) : requests.length === 0 && !hasFilters(filters) ? (
        <EmptyState
          eyebrow="Approvals"
          title={
            <>
              Nothing is waiting on a human.{" "}
              <span className="text-steel">Every post has had its say.</span>
            </>
          }
          description="Posts that pass Manager QA land here with their preview, caption and platforms, from every client, newest first."
          action={
            canBrief ? (
              <ButtonLink href="/brief" variant="primary" size="lg">
                Give the Arsenal a brief
              </ButtonLink>
            ) : null
          }
        />
      ) : requests.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-sm text-steel">Nothing waiting for approval matches these filters.</p>
          <Button size="sm" onClick={() => setFilters(NO_FILTERS)}>
            Clear filters
          </Button>
        </div>
      ) : (
        <>
          <p className="mb-4 font-mono text-[11px] tracking-[0.16em] text-steel/80 uppercase">
            {requests.length} waiting · {waitingOnMe} on you
          </p>
          <ul aria-label="Waiting for approval" className={GRID_CLASS}>
            {requests.map((request) => (
              <ApprovalTile
                key={request.id}
                request={request}
                selectable={canBatch && mine.includes(request.id)}
                selected={selected.has(request.id)}
                onSelectedChange={(on) => toggle(request.id, on)}
              />
            ))}
          </ul>
        </>
      )}

      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Batch approve"
          className="sticky bottom-6 z-20 mt-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel/95 px-4 py-3 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.9)] backdrop-blur"
        >
          <p className="flex items-center gap-3 text-sm text-paper/90">
            <span>
              <span className="font-mono text-paper">{selected.size}</span> selected
            </span>
            <Button size="sm" variant="ghost" onClick={() => setChosen(new Set())}>
              Clear
            </Button>
          </p>
          <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
            Approve selected ({selected.size})
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        tone="primary"
        title={`Approve ${plural(selected.size, "post")}?`}
        description={
          <>
            Your step of the approval chain is approved on each selected post. It&apos;s logged to
            the audit trail as one approve-all by {user.name}. Posts with later steps move on to
            them; the rest go to the Publisher to be scheduled.
          </>
        }
        confirmLabel={`Approve ${selected.size}`}
        pending={approveAll.isPending}
        error={approveAll.isError ? errorMessage(approveAll.error) : null}
        onConfirm={approveSelected}
      />
    </>
  );
}
