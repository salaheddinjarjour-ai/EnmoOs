import { AgentName } from "@enmo/shared";
import type { ReactNode } from "react";
import { AgentAvatar } from "@/components/agent/AgentAvatar";
import { Logo } from "@/components/brand/Logo";

/*
 * The cinematic frame shared by /login and /invite/[token]: void black, a slow horizon glow, the
 * wordmark and the idle Arsenal on the left, the form panel on the right.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative isolate grid min-h-dvh overflow-hidden bg-void lg:grid-cols-[1.15fr_1fr]">
      <Backdrop />

      <section className="relative flex flex-col justify-between gap-16 px-8 pt-10 pb-8 sm:px-14 lg:py-14">
        <Logo className="self-start text-[26px] text-paper" />

        <div className="flex max-w-xl translate-y-0 flex-col gap-6 opacity-100 transition-[opacity,translate] duration-300 ease-enmo starting:translate-y-3 starting:opacity-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-steel">
            ENMO OS · The autonomous marketing department
          </p>
          <p className="font-display text-4xl leading-[1.05] font-medium tracking-tight text-balance text-paper sm:text-5xl">
            Every pixel has intent.
            <span className="block text-steel">Every post has a memory.</span>
          </p>
        </div>

        <div className="hidden flex-col gap-4 lg:flex">
          <ul aria-label="The Arsenal" className="flex items-center gap-2.5">
            {AgentName.options.map((agent) => (
              <li key={agent}>
                <AgentAvatar agent={agent} size="sm" />
              </li>
            ))}
          </ul>
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-steel/70">
            Grow with Enmo · app.enmo.marketing
          </p>
        </div>
      </section>

      <section className="relative flex items-center justify-center px-6 pb-16 lg:py-14 lg:pr-14">
        <div className="w-full max-w-sm translate-y-0 opacity-100 transition-[opacity,translate] delay-75 duration-300 ease-enmo starting:translate-y-3 starting:opacity-0">
          {children}
        </div>
      </section>
    </main>
  );
}

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute -top-1/3 left-1/2 h-[70vh] w-[90vw] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(245_245_244/0.07),transparent)]" />
      <div className="absolute right-0 bottom-0 h-[60vh] w-[50vw] bg-[radial-gradient(closest-side,rgb(245_245_244/0.035),transparent)]" />
      <div className="absolute inset-x-0 top-[62%] h-px bg-linear-to-r from-transparent via-paper/10 to-transparent" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgb(245_245_244/0.025)_1px,transparent_1px)] [background-size:88px_100%] [mask-image:linear-gradient(to_bottom,transparent,black_30%,black_70%,transparent)]" />
    </div>
  );
}

/** The form card on the right-hand side. */
export function AuthPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-panel/80 p-8 shadow-[0_40px_120px_-48px_rgb(0_0_0/0.9)] backdrop-blur">
      <div className="mb-7 flex flex-col gap-2">
        <h1 className="font-display text-2xl font-medium tracking-tight text-paper">{title}</h1>
        {description ? (
          <div className="text-sm leading-relaxed text-steel">{description}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
