import { AGENT_LABEL, type AgentName } from "@enmo/shared";
import { cx } from "@/components/ui/cx";

/*
 * Each Arsenal member has a monogram and an activity dot (MASTER_PLAN §04). The dot is green and
 * pulses only while the agent works; idle agents keep a dim steel dot.
 */

export const AGENT_MONOGRAM: Readonly<Record<AgentName, string>> = {
  MANAGER: "MG",
  STRATEGIST: "ST",
  COPYWRITER: "CW",
  VISUAL_DIRECTOR: "VD",
  ADAPTER: "AD",
  ANALYST: "AN",
  PUBLISHER: "PB",
};

const SIZES = {
  sm: { box: "size-7 text-[10px]", dot: "size-2 border-[1.5px]" },
  md: { box: "size-9 text-[11px]", dot: "size-2.5 border-2" },
  lg: { box: "size-12 text-[13px]", dot: "size-3 border-2" },
} as const;

export interface AgentAvatarProps {
  agent: AgentName;
  active?: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}

export function AgentAvatar({ agent, active = false, size = "md", className }: AgentAvatarProps) {
  const name = AGENT_LABEL[agent];
  return (
    <span
      role="img"
      aria-label={active ? `${name}, working` : name}
      title={name}
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center rounded-full border bg-panel font-mono font-medium tracking-[0.06em] transition-colors duration-300 ease-enmo",
        active ? "border-paper/25 text-paper" : "border-line text-steel",
        SIZES[size].box,
        className,
      )}
    >
      <span aria-hidden>{AGENT_MONOGRAM[agent]}</span>
      <span
        aria-hidden
        className={cx(
          "absolute -right-0.5 -bottom-0.5 rounded-full border-void",
          SIZES[size].dot,
          active ? "animate-agent-pulse bg-enmo" : "bg-steel/35",
        )}
      />
    </span>
  );
}
