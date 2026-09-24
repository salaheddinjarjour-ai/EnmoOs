import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/Button";

/** Full-screen states shown by the AuthGate before the shell can render. */

export function SessionLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-void"
    >
      <Logo className="text-[26px] text-paper opacity-90" />
      <div aria-hidden className="shimmer h-px w-40 bg-paper/10" />
      <span className="sr-only">Opening ENMO OS…</span>
    </div>
  );
}

export function SessionUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-void px-8 text-center">
      <Logo className="text-[26px] text-paper" />
      <div className="flex max-w-md flex-col gap-2">
        <h1 className="font-display text-2xl font-medium tracking-tight">
          The API is out of reach.
        </h1>
        <p className="text-sm leading-relaxed text-steel">
          ENMO OS couldn&apos;t confirm your session. The API may be waking up; give it a moment and
          try again.
        </p>
      </div>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
