"use client";

import type { Capability } from "@enmo/shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { useNavShortcuts } from "@/components/shell/useNavShortcuts";
import {
  formatNavCount,
  isNavItemActive,
  NAV_CHORD_LEADER,
  navSections,
  RAIL_TOGGLE_KEY,
  type NavIconName,
  type NavItem,
} from "@/lib/nav";
import { useSidebarRail } from "@/lib/sidebar-rail";
import { cx } from "./cx";

export const SIDEBAR_ID = "primary-sidebar";

export interface SidebarProps {
  /** The session's capabilities (from GET /auth/me); undefined while loading hides gated items. */
  capabilities?: readonly Capability[];
  /** Counts shown on items, keyed by href (e.g. approvals waiting on the viewer). */
  counts?: Readonly<Record<string, number>>;
  /** Below the lg breakpoint the sidebar is a drawer, opened from the top bar. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

/*
 * Primary navigation. On large screens a sticky column that folds to a 72px icon rail ("[" or the
 * footer button; remembered per browser), with tooltips standing in for the labels; below that, a
 * drawer. One highlight glides to the current screen and a fainter one follows the pointer. Rows
 * sit on a 27px icon axis in both widths, so folding never moves an icon.
 *
 * The rail/drawer states are data attributes on the <aside> (group "sb"), so the layout is plain
 * CSS: `lg:group-data-[rail=true]/sb:*` only ever applies to the folded desktop rail.
 */
export function Sidebar({ capabilities, counts, mobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const [rail, setRail] = useSidebarRail();
  const sections = navSections(capabilities);
  const items = sections.flatMap((section) => section.items);
  const activeHref = items.find((item) => isNavItemActive(item, pathname))?.href ?? null;
  const [hoverHref, setHoverHref] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const chordPending = useNavShortcuts({
    items,
    onToggleRail: () => setRail(!rail),
    onNavigate: onMobileClose,
  });

  useEffect(() => {
    if (!mobileOpen) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMobileClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen, onMobileClose]);

  const onRowPointerEnter = (href: string) => (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") setHoverHref(href);
  };

  const rowIndex = new Map(items.map((item, index) => [item.href, index]));

  return (
    <>
      <div
        aria-hidden
        onClick={onMobileClose}
        className={cx(
          "fixed inset-0 z-40 bg-void/70 backdrop-blur-[2px] transition-opacity duration-300 lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <aside
        id={SIDEBAR_ID}
        data-rail={rail ? "true" : "false"}
        data-chord={chordPending ? "true" : "false"}
        className={cx(
          "group/sb fixed inset-y-0 left-0 z-50 flex h-dvh w-72 shrink-0 flex-col border-r border-line bg-panel",
          "transition-[translate,visibility,width] duration-300 ease-enmo",
          "lg:sticky lg:top-0 lg:z-30 lg:visible lg:translate-x-0",
          rail ? "lg:w-[72px]" : "lg:w-64",
          mobileOpen
            ? "translate-x-0 shadow-[24px_0_80px_-24px_rgb(0_0_0/0.9)]"
            : "invisible -translate-x-full",
        )}
      >
        {/* A faint top-left light, so the column reads as a surface rather than a flat fill. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_45%_at_0%_0%,rgb(245_245_244/0.05),transparent_70%)]"
        />

        <div className="relative flex h-16 shrink-0 items-center border-b border-line pr-3 pl-[27px]">
          <Link
            href="/command"
            aria-label="ENMO OS home"
            onClick={onMobileClose}
            className="relative flex h-8 items-center overflow-hidden text-paper lg:group-data-[rail=true]/sb:w-[18px]"
          >
            <span className="flex items-center gap-2.5 transition-[opacity,translate] duration-300 ease-enmo lg:group-data-[rail=true]/sb:-translate-x-2 lg:group-data-[rail=true]/sb:opacity-0">
              <Logo className="text-[17px]" />
              <span className="rounded-[4px] border border-paper/15 px-1.5 py-[3px] font-mono text-[9px] leading-none tracking-[0.22em] text-steel">
                OS
              </span>
            </span>
            <LogoMark className="absolute top-1/2 left-0 -translate-y-1/2 text-[18px] opacity-0 transition-opacity duration-300 lg:group-data-[rail=true]/sb:opacity-100" />
          </Link>
          <button
            ref={closeRef}
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            className="ml-auto flex size-9 items-center justify-center rounded-lg text-paper/60 transition-colors hover:bg-paper/[0.05] hover:text-paper lg:hidden"
          >
            <Glyph d="M4 4l8 8M12 4l-8 8" />
          </button>
        </div>

        <div className="relative px-3 pt-4">
          <div className="group/item relative">
            <Link
              href="/brief"
              onClick={onMobileClose}
              className="group/cta flex h-10 items-center gap-3 overflow-hidden rounded-lg border border-line bg-paper/[0.03] pr-2.5 pl-[14px] text-[14px] font-medium tracking-[-0.006em] text-paper transition-[background-color,border-color,scale] duration-200 hover:border-paper/20 hover:bg-paper/[0.06] active:scale-[0.985]"
            >
              <Glyph
                d="M8 3.5v9M3.5 8h9"
                className="text-enmo transition-transform duration-300 ease-enmo group-hover/cta:rotate-90"
                strokeWidth={1.75}
              />
              <RailFade>New brief</RailFade>
            </Link>
            <Tooltip>New brief</Tooltip>
          </div>
        </div>

        <nav
          aria-label="Primary"
          onPointerLeave={() => setHoverHref(null)}
          className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-4 lg:group-data-[rail=true]/sb:overflow-visible"
        >
          <div className="relative">
            <Glide
              href={activeHref}
              className="rounded-lg bg-linear-to-r from-paper/[0.085] to-paper/[0.035] ring-1 ring-paper/[0.06] ring-inset"
            >
              <span className="absolute top-2.5 bottom-2.5 left-0 w-[2px] rounded-full bg-paper shadow-[0_0_12px_rgb(245_245_244/0.45)]" />
            </Glide>
            <Glide
              href={hoverHref === activeHref ? null : hoverHref}
              className="rounded-lg bg-paper/[0.035]"
            />

            {sections.map((section, sectionIndex) => (
              <NavGroup key={section.id} label={section.label} first={sectionIndex === 0}>
                {section.items.map((item) => (
                  <NavRow
                    key={item.href}
                    item={item}
                    index={rowIndex.get(item.href) ?? 0}
                    active={item.href === activeHref}
                    count={counts?.[item.href] ?? 0}
                    onPointerEnter={onRowPointerEnter(item.href)}
                    onNavigate={onMobileClose}
                  />
                ))}
              </NavGroup>
            ))}
          </div>
        </nav>

        <div className="relative border-t border-line px-3 pt-2.5 pb-3">
          <div className="group/item relative max-lg:hidden">
            <button
              type="button"
              onClick={() => setRail(!rail)}
              aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
              aria-controls={SIDEBAR_ID}
              className="flex h-9 w-full items-center gap-3 overflow-hidden rounded-lg pr-2 pl-[15px] text-[13px] text-paper/50 transition-colors hover:bg-paper/[0.04] hover:text-paper/90"
            >
              <Glyph
                d="M10 4 6 8l4 4"
                className="transition-transform duration-300 ease-enmo lg:group-data-[rail=true]/sb:rotate-180"
              />
              <RailFade className="text-left">Collapse</RailFade>
              <RailFade className="flex-none">
                <Keys keys={[RAIL_TOGGLE_KEY]} />
              </RailFade>
            </button>
            <Tooltip keys={[RAIL_TOGGLE_KEY]}>Expand sidebar</Tooltip>
          </div>
          <p className="overflow-hidden px-[15px] pt-2 font-mono text-[9.5px] leading-none tracking-[0.26em] whitespace-nowrap text-steel/50 uppercase transition-opacity duration-300 lg:pt-2.5 lg:group-data-[rail=true]/sb:opacity-0">
            Grow with Enmo
          </p>
        </div>
      </aside>
    </>
  );
}

function NavGroup({
  label,
  first,
  children,
}: {
  label: string;
  first: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={first ? "pt-4" : "pt-5"}>
      <div className="relative flex h-6 items-center px-[15px]">
        <span
          id={id}
          className="font-mono text-[10px] tracking-[0.24em] whitespace-nowrap text-steel/70 uppercase transition-opacity duration-300 lg:group-data-[rail=true]/sb:opacity-0"
        >
          {label}
        </span>
        <span
          aria-hidden
          className="absolute top-1/2 left-1/2 h-px w-5 -translate-x-1/2 bg-paper/15 opacity-0 transition-opacity duration-300 lg:group-data-[rail=true]/sb:opacity-100"
        />
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function NavRow({
  item,
  index,
  active,
  count,
  onPointerEnter,
  onNavigate,
}: {
  item: NavItem;
  index: number;
  active: boolean;
  count: number;
  onPointerEnter: (event: ReactPointerEvent) => void;
  onNavigate?: () => void;
}) {
  const badge = formatNavCount(count);
  const keys = [NAV_CHORD_LEADER, item.shortcut];
  return (
    <li
      onPointerEnter={onPointerEnter}
      style={{ animationDelay: `${80 + index * 40}ms` }}
      className="group/item relative animate-nav-in"
    >
      <Link
        href={item.href}
        data-nav-href={item.href}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
        className={cx(
          "group/link relative flex h-10 items-center gap-3 overflow-hidden rounded-lg pr-2 pl-[15px] text-[14.5px] font-medium tracking-[-0.006em]",
          "transition-[color,scale] duration-200 ease-enmo active:scale-[0.985]",
          active ? "text-paper" : "text-paper/55 hover:text-paper/90",
        )}
      >
        <NavIcon name={item.icon} />
        <RailFade className="min-w-0 flex-1 truncate">{item.label}</RailFade>
        {badge ? (
          <>
            <span
              key={badge}
              aria-hidden
              className={cx(
                "inline-flex h-5 min-w-5 flex-none animate-badge-in items-center justify-center rounded-full bg-paper px-1.5 font-mono text-[10.5px] font-semibold text-void tabular-nums transition-opacity duration-200",
                "lg:group-hover/link:opacity-0 lg:group-hover/link:delay-500 lg:group-data-[chord=true]/sb:opacity-0 lg:group-data-[chord=true]/sb:delay-0 lg:group-data-[rail=true]/sb:opacity-0",
              )}
            >
              {badge}
            </span>
            <span
              aria-hidden
              className="absolute top-[5px] left-[27px] inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-paper px-1 font-mono text-[9px] font-semibold text-void tabular-nums opacity-0 ring-2 ring-panel transition-opacity duration-300 lg:group-data-[rail=true]/sb:opacity-100"
            >
              {badge}
            </span>
            <span className="sr-only">{`, ${count} waiting on you`}</span>
          </>
        ) : null}
        <span
          aria-hidden
          className={cx(
            "absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-200 max-lg:hidden lg:group-data-[rail=true]/sb:hidden",
            "group-hover/link:opacity-100 group-hover/link:delay-500 group-data-[chord=true]/sb:opacity-100 group-data-[chord=true]/sb:delay-0",
          )}
        >
          <Keys keys={keys} />
        </span>
      </Link>
      <Tooltip keys={keys}>
        {item.label}
        {badge ? <span className="text-steel">· {badge}</span> : null}
      </Tooltip>
    </li>
  );
}

/**
 * A highlight that glides to the row whose `data-nav-href` is `href` (and fades out for null),
 * among its parent's descendants. Positioned imperatively, so hovering never re-renders the rows;
 * the first placement after being hidden jumps into place and only fades, rather than sliding in
 * from the top. (The parent is read off the DOM rather than a ref: on mount a child's layout
 * effect runs before its parent's ref is attached.)
 */
function Glide({
  href,
  className,
  children,
}: {
  href: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const pillRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const pill = pillRef.current;
    const track = pill?.parentElement;
    if (!pill || !track) return;
    const place = () => {
      const target = href
        ? track.querySelector<HTMLElement>(`[data-nav-href="${CSS.escape(href)}"]`)
        : null;
      if (!target) {
        pill.style.opacity = "0";
        pill.dataset.shown = "false";
        return;
      }
      const jump = pill.dataset.shown !== "true";
      if (jump) pill.style.transition = "none";
      pill.style.transform = `translateY(${offsetTopWithin(target, track)}px)`;
      pill.style.height = `${target.offsetHeight}px`;
      if (jump) {
        void pill.offsetHeight;
        pill.style.transition = "";
      }
      pill.style.opacity = "1";
      pill.dataset.shown = "true";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(track);
    return () => observer.disconnect();
  }, [href]);

  return (
    <div
      ref={pillRef}
      aria-hidden
      className={cx(
        "pointer-events-none absolute top-0 right-0 left-0 opacity-0 transition-[transform,height,opacity] duration-300 ease-enmo",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The element's layout offset from the top of `container`, summed over positioned ancestors in
 * between (each row's <li> is one, for its tooltip). Layout offsets ignore transforms, so the
 * rows' entrance slide and press scale never nudge the highlight.
 */
function offsetTopWithin(element: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = element;
  while (current && current !== container) {
    top += current.offsetTop;
    current = current.offsetParent instanceof HTMLElement ? current.offsetParent : null;
  }
  return top;
}

/** Label-side content that folds away with the rail. */
function RailFade({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        "whitespace-nowrap transition-[opacity,translate] duration-300 ease-enmo lg:group-data-[rail=true]/sb:-translate-x-1 lg:group-data-[rail=true]/sb:opacity-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** What stands in for a label on the folded rail: shown on hover and on keyboard focus. */
function Tooltip({ keys, children }: { keys?: readonly string[]; children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cx(
        "pointer-events-none absolute top-1/2 left-full z-50 ml-4 hidden -translate-x-1 -translate-y-1/2 items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12.5px] font-medium whitespace-nowrap text-paper opacity-0 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.95)]",
        "transition-[opacity,translate] duration-200 ease-enmo lg:group-data-[rail=true]/sb:flex",
        "group-hover/item:translate-x-0 group-hover/item:opacity-100 group-has-[:focus-visible]/item:translate-x-0 group-has-[:focus-visible]/item:opacity-100",
      )}
    >
      {children}
      {keys ? <Keys keys={keys} /> : null}
    </span>
  );
}

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="flex items-center gap-0.5">
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className={cx(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-paper/10 bg-void/50 px-1 font-mono text-[10px] leading-none font-medium text-steel uppercase transition-colors duration-200",
            index === 0 &&
              keys.length > 1 &&
              "group-data-[chord=true]/sb:border-paper/30 group-data-[chord=true]/sb:text-paper",
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function Glyph({
  d,
  className,
  strokeWidth = 1.5,
}: {
  d: string;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cx("size-[18px] shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const ICON_PATHS: Record<NavIconName, string> = {
  command: "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z",
  brief: "M3 4h10v7H7l-3 2.5V11H3z",
  calendar: "M3 4.5h10V13H3zM3 7h10M6 3v3M10 3v3",
  vault: "M3 5.5 8 3l5 2.5v5L8 13l-5-2.5zM3 5.5l5 2.5 5-2.5M8 8v5",
  approvals: "M3 8.5 6.5 12 13 4.5",
  clients:
    "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.75 1.75 0 1 0 0-3.5M11.5 9.5c1.4.3 2.5 1.6 2.5 3.5",
  admin: "M8 2.5 13 4.5v3.5c0 3-2.2 5-5 5.5-2.8-.5-5-2.5-5-5.5V4.5z",
};

function NavIcon({ name }: { name: NavIconName }) {
  return (
    <Glyph
      d={ICON_PATHS[name]}
      strokeWidth={1.35}
      className="transition-transform duration-300 ease-enmo group-hover/link:scale-[1.08]"
    />
  );
}
