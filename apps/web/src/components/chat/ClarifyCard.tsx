"use client";

import { PLATFORM_LABEL, type ChatMessagePayload } from "@enmo/shared";
import { formatCalendarDay } from "@/components/post/format";
import { useClients } from "@/hooks/useClients";
import { errorMessage } from "@/lib/api";
import { GAP_LABEL } from "./thread-model";
import { MessageField } from "./MessageField";

/*
 * The Manager's ONE consolidated question (DESIGN "One consolidated question"): the question, the
 * missing pieces as chips, what it has understood so far, and the reply inline. The answer is an
 * ordinary thread message; after it the Manager must lock the brief, writing any remaining gaps
 * down as assumptions.
 */

export interface ClarifyReply {
  send: (text: string) => Promise<boolean>;
  pending: boolean;
  error: unknown;
}

export function ClarifyCard({
  payload,
  reply,
  answered,
}: {
  payload: ChatMessagePayload<"CLARIFY">;
  /** Set while this question is open and the viewer may answer it. */
  reply: ClarifyReply | null;
  answered: boolean;
}) {
  const { draft } = payload;
  const clients = useClients();
  const clientName = draft.clientId
    ? clients.data?.find((client) => client.id === draft.clientId)?.name
    : undefined;

  const known: Array<[string, string]> = [];
  if (clientName) known.push(["Client", clientName]);
  if (draft.title) known.push(["Campaign", draft.title]);
  if (draft.postCount !== null) known.push(["Posts", String(draft.postCount)]);
  if (draft.platforms?.length)
    known.push(["Platforms", draft.platforms.map((p) => PLATFORM_LABEL[p]).join(", ")]);
  if (draft.productFocus) known.push(["Focus", draft.productFocus]);
  if (draft.window?.start && draft.window.end)
    known.push([
      "Dates",
      `${formatCalendarDay(draft.window.start)} – ${formatCalendarDay(draft.window.end)}`,
    ]);
  if (draft.objective) known.push(["Objective", draft.objective]);

  return (
    <section
      aria-label="Clarifying question"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel px-5 py-4"
    >
      <p className="font-display text-lg leading-snug font-medium tracking-tight text-paper">
        {payload.question}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.16em] text-steel uppercase">
          Missing
        </span>
        <ul aria-label="Missing from the brief" className="flex flex-wrap gap-1.5">
          {payload.missing.map((gap) => (
            <li
              key={gap}
              className="inline-flex h-6 items-center rounded-full border border-amber-300/30 px-2.5 font-mono text-[11px] tracking-[0.06em] text-amber-100"
            >
              {GAP_LABEL[gap]}
            </li>
          ))}
        </ul>
      </div>
      {known.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-1.5 border-t border-line pt-3 text-sm sm:grid-cols-[auto_1fr]">
          {known.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="font-mono text-[11px] tracking-[0.12em] text-steel uppercase">
                {term}
              </dt>
              <dd className="text-paper/85">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {reply ? (
        <MessageField
          label="Your answer"
          placeholder="Everything the Manager asked, in one reply…"
          submitLabel="Send answer"
          pending={reply.pending}
          error={reply.error ? errorMessage(reply.error) : null}
          onSubmit={reply.send}
          autoFocus
        />
      ) : answered ? (
        <p className="font-mono text-[11px] tracking-[0.14em] text-steel uppercase">Answered</p>
      ) : null}
    </section>
  );
}
