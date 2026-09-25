import { cx } from "@/components/ui/cx";

/*
 * The ENMO wordmark, redrawn as inline SVG from docs/enmo-logo.png: rounded geometric E, N and M
 * as stroked centrelines (round caps and joins), and an O that is a solid disc with a C-shaped
 * cut-out whose open top-right quadrant holds the green notch. The letters take currentColor, so
 * the mark follows the surrounding text colour; the cut-out is a real hole (evenodd), so it works
 * on any background. Sized by font-size: the cap height is 1em.
 *
 * Geometry (viewBox units, cap height 100, stroke 22): E 0–85, N 105–205, M 225–335,
 * O centred at (403, 50) with r = 51; the cut-out spans radii 22–34 from −92° round to 4°.
 */

const LETTERS =
  "M74 11H23a12 12 0 0 0-12 12v54a12 12 0 0 0 12 12h51M11 50h63" + // E
  "M116 89V11l78 78V11" + // N
  "M236 89V11l31 16h26l31-16v78"; // M

const O_DISC = "M352 50a51 51 0 1 0 102 0a51 51 0 1 0-102 0Z";
const O_CUTOUT = "M401.81 16.02A34 34 0 1 0 436.92 52.37L424.95 51.54A22 22 0 1 1 402.23 28.01Z";
const O_NOTCH = "M409 19H434V47H426V27H409Z";

export function Logo({ className = "", title = "ENMO" }: { className?: string; title?: string }) {
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox="0 -2 456 104"
      className={cx("inline-block h-[1em] w-auto shrink-0 overflow-visible", className)}
    >
      <path
        d={LETTERS}
        fill="none"
        stroke="currentColor"
        strokeWidth={22}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={`${O_DISC}${O_CUTOUT}`} fill="currentColor" fillRule="evenodd" />
      <path d={O_NOTCH} className="fill-enmo stroke-enmo" strokeWidth={4} strokeLinejoin="round" />
    </svg>
  );
}

/** The O on its own (with its notch): the mark for tight spaces such as the folded sidebar. */
export function LogoMark({
  className = "",
  title = "ENMO",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox="350 -3 106 106"
      className={cx("inline-block size-[1em] shrink-0 overflow-visible", className)}
    >
      <path d={`${O_DISC}${O_CUTOUT}`} fill="currentColor" fillRule="evenodd" />
      <path d={O_NOTCH} className="fill-enmo stroke-enmo" strokeWidth={4} strokeLinejoin="round" />
    </svg>
  );
}
