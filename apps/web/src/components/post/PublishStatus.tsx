import { PLATFORM_LABEL, type PostPlatformPublishDto } from "@enmo/shared";
import { PLATFORM_DOT } from "@/components/clients/platforms";
import { cx } from "@/components/ui/cx";
import { hasPublishing, publishLine, type PublishMarkStatus } from "./publishing";

/*
 * Where a post stands on each platform once the Publisher has it (PostDto.publishing): the job's
 * state as a mono mark, when it goes (or went) out in the client's time, the live link, and a DRY
 * RUN tag for simulated publishes. Green only for the live indicator and the Publisher at work.
 */

export function PublishMark({
  status,
  className,
}: {
  status: PublishMarkStatus;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 font-mono text-[10px] leading-none tracking-[0.06em] whitespace-nowrap",
        status.tone === "failed" && "text-red-300",
        status.tone === "live" && "text-paper",
        status.tone === "working" && "text-paper/85",
        (status.tone === "waiting" || status.tone === "planned" || status.tone === "cancelled") &&
          "text-steel",
        className,
      )}
    >
      {status.tone === "live" || status.tone === "working" ? (
        <span aria-hidden className="size-1.5 shrink-0 animate-agent-pulse rounded-full bg-enmo" />
      ) : status.tone === "failed" ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-red-400" />
      ) : null}
      {status.label}
    </span>
  );
}

/** Simulated publishing: validated like the real thing, nothing posted. */
export function DryRunTag({ long = false, className }: { long?: boolean; className?: string }) {
  return (
    <span
      title="Dry run: validated like a real publish, with a dryrun.enmo.marketing link; nothing was posted"
      className={cx(
        "inline-flex shrink-0 items-center rounded-sm border border-line px-1 font-mono text-[9px] leading-[14px] tracking-[0.08em] whitespace-nowrap text-steel",
        className,
      )}
    >
      {long ? "DRY RUN" : "DRY"}
    </span>
  );
}

export function PublishStatusList({
  publishing,
  timeZone,
  detailed = false,
  className,
}: {
  publishing: readonly PostPlatformPublishDto[];
  /** The client's zone (the times are the client's); the viewer's until the client loads. */
  timeZone: string;
  /** The drawer: aligned columns, every time, and last errors in full. */
  detailed?: boolean;
  className?: string;
}) {
  if (!hasPublishing(publishing)) return null;
  return (
    <ul aria-label="Publishing" className={cx("flex flex-col gap-1.5", className)}>
      {publishing.map((entry) => {
        const line = publishLine(entry, timeZone);
        // On a card, a live post's link says more than the minute it went out (kept on hover).
        const showWhen = line.when !== null && (detailed || line.liveUrl === null);
        return (
          <li
            key={entry.platform}
            aria-label={`${PLATFORM_LABEL[entry.platform]}: ${line.mark.label}`}
            title={line.when ?? undefined}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1"
          >
            <span
              className={cx(
                "inline-flex shrink-0 items-center gap-1.5 text-[11px] text-steel",
                detailed && "w-20",
              )}
            >
              <span
                aria-hidden
                className={cx("size-1.5 rounded-full", PLATFORM_DOT[entry.platform])}
              />
              {PLATFORM_LABEL[entry.platform]}
            </span>
            <PublishMark status={line.mark} />
            {showWhen ? (
              <span className="font-mono text-[11px] text-steel tabular-nums">{line.when}</span>
            ) : null}
            {line.dryRun ? <DryRunTag long /> : null}
            {line.liveUrl ? (
              <a
                href={line.liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-paper underline decoration-paper/30 underline-offset-4 transition-colors duration-200 hover:decoration-paper"
              >
                View live post<span aria-hidden> ↗</span>
              </a>
            ) : null}
            {detailed && line.error ? (
              <p className="w-full rounded-md border border-red-400/25 bg-red-500/[0.06] px-2.5 py-1.5 text-xs text-red-200">
                {line.error}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
