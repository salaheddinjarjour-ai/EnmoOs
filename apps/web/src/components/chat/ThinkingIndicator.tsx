import { AgentAvatar } from "@/components/agent/AgentAvatar";
import { Skeleton } from "@/components/ui/Skeleton";

/** The Manager at work on an answer: its pulse, a mono line and a shimmering draft. */
export function ThinkingIndicator({ label = "Manager is thinking…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex gap-3.5">
      <AgentAvatar agent="MANAGER" size="sm" active className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="font-mono text-[11px] tracking-[0.14em] text-steel uppercase">{label}</p>
        <div aria-hidden className="flex max-w-md flex-col gap-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}
