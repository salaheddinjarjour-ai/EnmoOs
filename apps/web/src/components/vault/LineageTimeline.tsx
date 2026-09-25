import type { AspectRatio } from "@enmo/shared";
import { cx } from "@/components/ui/cx";
import { frameSizeOf } from "./media";
import { TakeFrame } from "./TakeFrame";
import type { LineageStep } from "./vault-model";

/*
 * v1 → v2 → v3: every version of one shot, oldest first. Takes the Visual Director rejected (or
 * that failed to render) stay in the line, dimmed; the version posts use now is marked current;
 * the one on the stage is outlined. A regenerate in flight is the shimmering last step.
 */

export function LineageTimeline({
  steps,
  selectedId,
  fallbackRatio,
  onSelect,
}: {
  steps: readonly LineageStep[];
  selectedId: string;
  fallbackRatio: AspectRatio;
  onSelect: (id: string) => void;
}) {
  return (
    <ol aria-label="Versions" className="flex items-start gap-2 overflow-x-auto pb-1">
      {steps.map((step, index) => {
        const { take } = step;
        const selected = take.id === selectedId;
        const state = [take.status.toLowerCase(), step.current ? "current" : null]
          .filter(Boolean)
          .join(", ");
        return (
          <li key={take.id} className="flex shrink-0 items-start gap-2">
            {index > 0 ? (
              <span aria-hidden className="mt-9 font-mono text-xs text-steel/50">
                →
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onSelect(take.id)}
              aria-pressed={selected}
              aria-label={`v${take.version}, ${state}`}
              className={cx(
                "flex flex-col items-center gap-1.5 rounded-lg border p-1.5 transition duration-200 ease-enmo",
                selected ? "border-paper/50 bg-paper/[0.05]" : "border-line hover:border-paper/25",
              )}
            >
              <TakeFrame
                take={take}
                size={frameSizeOf(take, fallbackRatio)}
                alt={`Version ${take.version}`}
                dimmed={step.dimmed}
                className="h-20 w-14"
                frameClassName="rounded-sm"
              />
              <span
                className={cx(
                  "font-mono text-[11px] leading-none",
                  step.dimmed ? "text-steel/70" : "text-paper",
                )}
              >
                v{take.version}
              </span>
              <span
                aria-hidden
                className={cx(
                  "h-4 font-mono text-[9px] leading-4 tracking-[0.14em] uppercase",
                  step.current ? "rounded-sm bg-paper/90 px-1 text-void" : "text-steel/70",
                )}
              >
                {step.current
                  ? "Current"
                  : step.pending || take.status !== "READY"
                    ? take.status
                    : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
