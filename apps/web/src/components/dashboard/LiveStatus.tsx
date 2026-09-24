"use client";

import { cx } from "@/components/ui/cx";
import { useRealtimeStatus } from "@/lib/realtime";

/*
 * Whether live updates are flowing (the one SSE stream). A green dot while open (live is one of
 * Enmo Green's jobs); amber while the stream reconnects, when what's on screen may be behind.
 */
export function LiveStatus() {
  const status = useRealtimeStatus();
  const label =
    status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span
      role="status"
      aria-label={`Live updates: ${label.toLowerCase()}`}
      title={
        status === "reconnecting"
          ? "Live updates dropped; reconnecting. What you see may be a little behind."
          : undefined
      }
      className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.16em] text-steel uppercase"
    >
      <span
        aria-hidden
        className={cx(
          "size-1.5 rounded-full",
          status === "open" ? "bg-enmo" : status === "connecting" ? "bg-steel/60" : "bg-amber-300",
        )}
      />
      <span className="hidden md:inline">{label}</span>
    </span>
  );
}
