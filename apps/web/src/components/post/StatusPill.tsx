import {
  postPlacement,
  type ActivePostStatus,
  type PostStatus,
  type StatusPill as StatusPillValue,
} from "@enmo/shared";
import { cx } from "@/components/ui/cx";

/*
 * Status pills (MASTER_PLAN §04): mono 11px, rounded, one of PLANNING · PENDING_APPROVAL ·
 * SCHEDULED · LIVE · LEARNED. Anything past human approval gets the green border; LIVE carries the
 * pulsing live dot. The pill shows the machine token verbatim ("the machines speak mono").
 */

export interface StatusPillProps {
  pill: StatusPillValue;
  /** Past human approval: green border. */
  approved?: boolean;
  /** The post failed at this stage. */
  failed?: boolean;
  className?: string;
}

export function StatusPill({ pill, approved = false, failed = false, className }: StatusPillProps) {
  return (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] leading-none tracking-[0.08em] whitespace-nowrap",
        failed
          ? "border-red-400/40 text-red-300"
          : approved
            ? "border-enmo/70 text-paper"
            : "border-line text-steel",
        className,
      )}
    >
      {pill === "LIVE" && !failed ? (
        <span aria-hidden className="size-1.5 animate-agent-pulse rounded-full bg-enmo" />
      ) : null}
      {pill}
      {failed ? <span className="text-red-300/80"> · FAILED</span> : null}
    </span>
  );
}

/** Pill for a post, placed by the shared board mapping (FAILED keeps its stage's pill). */
export function PostStatusPill({
  status,
  failedFrom,
  className,
}: {
  status: PostStatus;
  failedFrom?: ActivePostStatus | null;
  className?: string;
}) {
  const placement = postPlacement(status, failedFrom);
  return (
    <StatusPill
      pill={placement.pill}
      approved={placement.approved}
      failed={placement.failed}
      className={className}
    />
  );
}
