import type { CampaignStatus } from "@enmo/shared";
import { cx } from "@/components/ui/cx";

/*
 * Campaign status as a mono pill. Green is for the Arsenal at work (MASTER_PLAN §04: a soft pulse
 * on agent activity), so the pulse shows only when the caller knows agents are working now
 * (`working`); a PRODUCING campaign whose tasks have all settled stays neutral.
 */

const LABEL: Readonly<Record<CampaignStatus, string>> = {
  BRIEFING: "BRIEFING",
  PLANNING: "PLANNING",
  PRODUCING: "PRODUCING",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  ARCHIVED: "ARCHIVED",
};

export function CampaignStatusBadge({
  status,
  working = false,
  className,
}: {
  status: CampaignStatus;
  /** Agents are working on the campaign right now (its live progress says so). */
  working?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] leading-none tracking-[0.08em] whitespace-nowrap",
        working ? "border-paper/20 text-paper" : "border-line text-steel",
        status === "ARCHIVED" && "opacity-60",
        className,
      )}
    >
      {working ? (
        <span aria-hidden className="size-1.5 animate-agent-pulse rounded-full bg-enmo" />
      ) : null}
      {LABEL[status]}
    </span>
  );
}
