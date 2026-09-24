import type { Capability } from "@enmo/shared";

export type NavIconName =
  "command" | "brief" | "calendar" | "vault" | "approvals" | "clients" | "admin";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconName;
  /** Hidden unless the session holds this capability. */
  requires?: Capability;
  /** Also active on these path prefixes (e.g. /admin/* for Admin). */
  matches?: readonly string[];
}

/** The six screens plus Admin (MASTER_PLAN §03). Order is the sidebar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/command", label: "Command Center", icon: "command" },
  { href: "/brief", label: "The Brief", icon: "brief" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/vault", label: "The Vault", icon: "vault" },
  { href: "/approvals", label: "Approvals", icon: "approvals" },
  { href: "/clients", label: "Clients", icon: "clients" },
  {
    href: "/admin/users",
    label: "Admin",
    icon: "admin",
    requires: "users.manage",
    matches: ["/admin"],
  },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  return [item.href, ...(item.matches ?? [])].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Items visible to a session; gated items stay hidden until capabilities are known. */
export function visibleNavItems(capabilities: readonly Capability[] | undefined): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => !item.requires || (capabilities?.includes(item.requires) ?? false),
  );
}
