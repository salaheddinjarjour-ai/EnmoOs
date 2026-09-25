import type { AssetStatus } from "@enmo/shared";
import { formatSeconds } from "@/components/post/format";
import { cx } from "@/components/ui/cx";

/*
 * The small mono marks a take wears (MASTER_PLAN §04: the machines speak mono). Only a take in
 * the render loop gets Enmo Green, as the pulsing activity dot; failures are red, rejected takes
 * muted. `onMedia` gives a mark a dark backing so it reads over an image; `md` matches the size of
 * the post StatusPill for headers.
 */

export type MarkSize = "sm" | "md";

interface MarkProps {
  onMedia?: boolean;
  size?: MarkSize;
  className?: string;
}

const SIZE: Readonly<Record<MarkSize, string>> = {
  sm: "h-5 px-2 text-[10px]",
  md: "h-6 px-2.5 text-[11px]",
};

function markClass({ onMedia = false, size = "sm", className }: MarkProps, tone: string): string {
  return cx(
    "inline-flex shrink-0 items-center gap-1 rounded-full border font-mono leading-none tracking-[0.08em] whitespace-nowrap",
    SIZE[size],
    tone,
    onMedia && "bg-void/75 backdrop-blur-sm",
    className,
  );
}

const STATUS_TONE: Readonly<Record<AssetStatus, string>> = {
  QUEUED: "border-line text-steel",
  RENDERING: "border-line text-paper",
  READY: "border-paper/25 text-paper/90",
  FAILED: "border-red-400/40 text-red-300",
  REJECTED: "border-line text-steel/80 line-through decoration-steel/60",
};

export function TakeStatusPill({ status, ...mark }: MarkProps & { status: AssetStatus }) {
  return (
    <span className={markClass(mark, STATUS_TONE[status])}>
      {status === "RENDERING" || status === "QUEUED" ? (
        <span
          aria-hidden
          className={cx(
            "size-1.5 rounded-full",
            status === "RENDERING" ? "animate-agent-pulse bg-enmo" : "bg-steel/70",
          )}
        />
      ) : null}
      {status}
    </span>
  );
}

export function VersionBadge({ version, ...mark }: MarkProps & { version: number }) {
  return (
    <span title={`Version ${version}`} className={markClass(mark, "border-line text-paper")}>
      v{version}
    </span>
  );
}

/** Which renderer made the take ("higgsfield · soul-v2", "mock", "sharp"). */
export function ProviderChip({ label, ...mark }: MarkProps & { label: string }) {
  return (
    <span title="Visual provider" className={markClass(mark, "border-line text-steel")}>
      {label}
    </span>
  );
}

/** A MockProvider placeholder, never mistaken for real output (like the Topbar's mode chips). */
export function MockChip(mark: MarkProps) {
  return (
    <span
      title="A branded placeholder from MockProvider, not provider output"
      className={markClass(mark, "border-dashed border-paper/30 text-paper/80")}
    >
      MOCK
    </span>
  );
}

/** A clip (or MockProvider's poster standing in for one), with its length when known. */
export function VideoBadge({ durationSec, ...mark }: MarkProps & { durationSec: number | null }) {
  return (
    <span className={markClass(mark, "border-line text-paper")}>
      <svg aria-hidden viewBox="0 0 8 8" className="size-2 fill-current">
        <path d="M1.5 1v6l5-3z" />
      </svg>
      <span className="sr-only">Video</span>
      {durationSec === null ? null : (
        <span className="tabular-nums">{formatSeconds(durationSec)}</span>
      )}
    </span>
  );
}
