/** Cinematic stand-in for screens that later phases build. Never apologetic. */
export function ScreenPlaceholder({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <section className="flex min-h-[60vh] flex-col justify-center gap-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-steel">{eyebrow}</p>
      <h1 className="font-display text-5xl font-medium tracking-tight text-paper">{title}</h1>
      <p className="max-w-xl text-base leading-relaxed text-steel">{description}</p>
      <div aria-hidden className="mt-6 h-px w-40 bg-linear-to-r from-paper/30 to-transparent" />
    </section>
  );
}
