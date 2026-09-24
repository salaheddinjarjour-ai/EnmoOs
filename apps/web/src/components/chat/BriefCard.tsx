import type { ChatMessagePayload, PostMixItem } from "@enmo/shared";
import type { ReactNode } from "react";
import { formatCalendarRange } from "@/components/post/format";
import { PlatformChips } from "@/components/post/PlatformChips";

/*
 * The locked brief, read back (manager.intake's brief branch). Assumptions are the gaps the
 * Manager filled itself rather than asking a second question, so they are called out.
 */

const TYPE_PLURAL = {
  REEL: ["reel", "reels"],
  TIKTOK: ["TikTok", "TikToks"],
  CAROUSEL: ["carousel", "carousels"],
  STATIC: ["static", "statics"],
  STORY: ["story", "stories"],
} as const;

export function formatPostMix(mix: readonly PostMixItem[]): string {
  return mix
    .map((item) => `${item.count} ${TYPE_PLURAL[item.type][item.count === 1 ? 0 : 1]}`)
    .join(" · ");
}

export function BriefCard({ payload }: { payload: ChatMessagePayload<"BRIEF"> }) {
  const { brief } = payload;
  return (
    <section
      aria-label="Brief"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel px-5 py-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-display text-lg font-medium tracking-tight text-paper">
          {brief.title}
        </h3>
        <span className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
          {formatCalendarRange(brief.window.start, brief.window.end)}
        </span>
      </header>
      <p className="text-sm leading-relaxed text-paper/85">{brief.objective}</p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-xs text-paper">
          {brief.postCount} {brief.postCount === 1 ? "post" : "posts"}
        </span>
        <span className="font-mono text-xs text-steel">{formatPostMix(brief.postMix)}</span>
        <PlatformChips platforms={brief.platforms} />
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {brief.productFocus ? <Row term="Focus">{brief.productFocus}</Row> : null}
        {brief.audience ? <Row term="Audience">{brief.audience}</Row> : null}
        {brief.cadenceNotes ? <Row term="Cadence">{brief.cadenceNotes}</Row> : null}
        {brief.keyMessages.length > 0 ? (
          <Row term="Key messages">
            <ul className="flex flex-col gap-1">
              {brief.keyMessages.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Row>
        ) : null}
        {brief.constraints.length > 0 ? (
          <Row term="Constraints">
            <ul className="flex flex-col gap-1">
              {brief.constraints.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Row>
        ) : null}
      </dl>
      {brief.assumptions.length > 0 ? (
        <div className="rounded-md border border-line bg-paper/[0.02] px-3.5 py-3">
          <p className="mb-2 font-mono text-[10px] tracking-[0.16em] text-steel uppercase">
            Assumed, not asked
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-paper/80 marker:text-steel">
            {brief.assumptions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">{term}</dt>
      <dd className="text-paper/85">{children}</dd>
    </div>
  );
}
