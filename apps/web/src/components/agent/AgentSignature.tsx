import { AGENT_LABEL, type AgentName } from "@enmo/shared";
import { cx } from "@/components/ui/cx";

/** Agents sign their chat messages: name and time, in mono ("The machines speak mono"). */

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export interface AgentSignatureProps {
  agent: AgentName;
  /** ISO timestamp of the message. */
  at?: string | null;
  /** What the agent just did, e.g. "draft v2". */
  detail?: string;
  className?: string;
}

export function AgentSignature({ agent, at, detail, className }: AgentSignatureProps) {
  return (
    <p
      className={cx(
        "flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] text-steel uppercase",
        className,
      )}
    >
      <span aria-hidden className="h-px w-4 bg-steel/50" />
      <span className="text-paper/80">{AGENT_LABEL[agent]}</span>
      {detail ? <span>· {detail}</span> : null}
      {at ? (
        <>
          <span aria-hidden>·</span>
          <time dateTime={at} suppressHydrationWarning>
            {TIME.format(new Date(at))}
          </time>
        </>
      ) : null}
    </p>
  );
}
