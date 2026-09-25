import type { Capability } from "@enmo/shared";

export type NavIconName =
  "command" | "brief" | "calendar" | "vault" | "approvals" | "clients" | "admin";

export type NavSectionId = "workspace" | "library" | "system";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
  section: NavSectionId;
  /** The second key of the "G then …" chord that jumps here (lowercase). */
  shortcut: string;
  /** Hidden unless the session holds this capability. */
  requires?: Capability;
  /** Also active on these path prefixes (e.g. /admin/* for Admin). */
  matches?: readonly string[];
}

export interface NavSection {
  id: NavSectionId;
  label: string;
  items: NavItem[];
}

const SECTION_LABELS: Record<NavSectionId, string> = {
  workspace: "Workspace",
  library: "Library",
  system: "System",
};

/**
 * The six screens plus Admin (MASTER_PLAN §03), grouped by what they are for: the daily loop
 * (brief, schedule, sign off), what the Arsenal has made and who for, and team administration.
 * Order is the sidebar order.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/command",
    label: "Command Center",
    icon: "command",
    section: "workspace",
    shortcut: "h",
  },
  { href: "/brief", label: "The Brief", icon: "brief", section: "workspace", shortcut: "b" },
  { href: "/calendar", label: "Calendar", icon: "calendar", section: "workspace", shortcut: "l" },
  {
    href: "/approvals",
    label: "Approvals",
    icon: "approvals",
    section: "workspace",
    shortcut: "a",
  },
  { href: "/vault", label: "The Vault", icon: "vault", section: "library", shortcut: "v" },
  { href: "/clients", label: "Clients", icon: "clients", section: "library", shortcut: "c" },
  {
    href: "/admin/users",
    label: "Admin",
    icon: "admin",
    section: "system",
    shortcut: "u",
    requires: "users.manage",
    matches: ["/admin"],
  },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return [item.href, ...(item.matches ?? [])].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** The screen the pathname belongs to, if it is one of the sidebar's. */
export function activeNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => isNavItemActive(item, pathname));
}

/** Items visible to a session; gated items stay hidden until capabilities are known. */
export function visibleNavItems(capabilities: readonly Capability[] | undefined): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => !item.requires || (capabilities?.includes(item.requires) ?? false),
  );
}

/** Visible items grouped into their sections, in order; a section with nothing visible is left out. */
export function navSections(capabilities: readonly Capability[] | undefined): NavSection[] {
  const items = visibleNavItems(capabilities);
  return (Object.keys(SECTION_LABELS) as NavSectionId[])
    .map((id) => ({
      id,
      label: SECTION_LABELS[id],
      items: items.filter((item) => item.section === id),
    }))
    .filter((section) => section.items.length > 0);
}

/*
 * Keyboard navigation: press G, then a screen's letter within NAV_CHORD_TIMEOUT_MS ("G then A"
 * opens Approvals); "[" folds the sidebar to its icon rail and back. Never while typing.
 */
export const NAV_CHORD_LEADER = "g";
export const NAV_CHORD_TIMEOUT_MS = 1500;
export const RAIL_TOGGLE_KEY = "[";

/** The item a chord's second key opens, among the items the session can see. */
export function navItemForShortcut(key: string, items: readonly NavItem[]): NavItem | undefined {
  const lower = key.toLowerCase();
  return items.find((item) => item.shortcut === lower);
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether a key event's target takes typing, so single-key shortcuts must stay out of its way. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown; type?: unknown };
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = typeof element.type === "string" ? element.type.toLowerCase() : "text";
  return !NON_TEXT_INPUT_TYPES.has(type);
}

/** The badge text for a count: nothing at zero, "99+" past 99. */
export function formatNavCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}
