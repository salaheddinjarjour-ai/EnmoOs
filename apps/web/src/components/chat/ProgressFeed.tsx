import {
  AGENT_LABEL,
  AGENT_PROGRESS_VERB,
  type ChatMessagePayload,
  type ProgressEntry,
} from "@enmo/shared";
import { AgentAvatar } from "@/components/agent/AgentAvatar";
import { cx } from "@/components/ui/cx";

/*
 * Live progress for one plan (the graph's single PROGRESS message, upserted on every task
 * transition): the shared formatProgress line ("Copywriter ✓ 12/12 — Manager reviewing 3/12…")
 * and a row per agent. Agents with work in flight pulse green and their bar shimmers; nothing
 * else moves.
 */

export function isBusy(entry: ProgressEntry): boolean {
  return entry.running + entry.waiting > 0;
}

function entryState(entry: ProgressEntry): string {
  if (entry.total > 0 && entry.done >= entry.total) return "done";
  if (isBusy(entry)) return AGENT_PROGRESS_VERB[entry.agent];
  const stopped = entry.escalated + entry.blocked;
  if (stopped > 0 && entry.done + stopped >= entry.total) return "needs a human";
  return "queued";
}

export function ProgressFeed({ payload }: { payload: ChatMessagePayload<"PROGRESS"> }) {
  const entries = payload.aggregate.filter((entry) => entry.total > 0);
  return (
    <section
      aria-label="Live progress"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel px-5 py-4"
    >
      <p aria-live="polite" className="font-mono text-[13px] leading-relaxed text-paper">
        {payload.line || "Queued…"}
      </p>
      <ul className="flex flex-col gap-3">
        {entries.map((entry) => {
          const busy = isBusy(entry);
          const done = entry.total > 0 ? entry.done / entry.total : 0;
          const inFlight = entry.total > 0 ? (entry.running + entry.waiting) / entry.total : 0;
          const escalated = entry.total > 0 ? entry.escalated / entry.total : 0;
          return (
            <li
              key={entry.agent}
              aria-label={`${AGENT_LABEL[entry.agent]}: ${entry.done} of ${entry.total} done, ${entryState(entry)}`}
              className="grid grid-cols-[auto_8rem_1fr_auto] items-center gap-3"
            >
              <AgentAvatar agent={entry.agent} size="sm" active={busy} />
              <span className="truncate font-mono text-[11px] tracking-[0.12em] text-paper/85 uppercase">
                {AGENT_LABEL[entry.agent]}
              </span>
              <span aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-paper/[0.06]">
                <span
                  className="h-full bg-paper/70 transition-[width] duration-300 ease-enmo"
                  style={{ width: `${done * 100}%` }}
                />
                <span
                  className={cx(
                    "h-full transition-[width] duration-300 ease-enmo",
                    busy && "shimmer",
                  )}
                  style={{ width: `${inFlight * 100}%` }}
                />
                <span className="h-full bg-amber-300/70" style={{ width: `${escalated * 100}%` }} />
              </span>
              <span
                className={cx(
                  "font-mono text-[11px] tabular-nums",
                  entry.escalated > 0 ? "text-amber-200" : "text-steel",
                )}
              >
                {entry.done}/{entry.total}
                {entry.escalated > 0 ? ` · ${entry.escalated}!` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
