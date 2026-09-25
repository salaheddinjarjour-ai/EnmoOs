import { describe, expect, it } from "vitest";
import {
  activeNavItem,
  formatNavCount,
  isTypingTarget,
  NAV_ITEMS,
  navItemForShortcut,
  navSections,
  visibleNavItems,
} from "./nav";

describe("navSections", () => {
  it("groups the screens in sidebar order and hides Admin without users.manage", () => {
    const sections = navSections(["clients.read"]);
    expect(sections.map((section) => section.id)).toEqual(["workspace", "library"]);
    expect(sections.flatMap((section) => section.items.map((item) => item.label))).toEqual([
      "Command Center",
      "The Brief",
      "Calendar",
      "Approvals",
      "The Vault",
      "Clients",
    ]);
  });

  it("shows the System section to admins", () => {
    const sections = navSections(["users.manage"]);
    expect(sections.at(-1)).toMatchObject({ id: "system", label: "System" });
    expect(sections.at(-1)?.items.map((item) => item.href)).toEqual(["/admin/users"]);
  });

  it("keeps gated items hidden while capabilities load", () => {
    expect(visibleNavItems(undefined).some((item) => item.requires)).toBe(false);
  });
});

describe("activeNavItem", () => {
  it("matches nested routes and extra prefixes", () => {
    expect(activeNavItem("/brief/cm123")?.label).toBe("The Brief");
    expect(activeNavItem("/admin/anything")?.label).toBe("Admin");
    expect(activeNavItem("/clients")?.label).toBe("Clients");
  });

  it("does not match lookalike prefixes", () => {
    expect(activeNavItem("/briefing")).toBeUndefined();
    expect(activeNavItem("/")).toBeUndefined();
  });
});

describe("shortcuts", () => {
  it("gives every screen its own letter", () => {
    const keys = NAV_ITEMS.map((item) => item.shortcut);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]$/);
    expect(keys).not.toContain("g");
  });

  it("resolves a chord key case-insensitively among visible items only", () => {
    const visible = visibleNavItems([]);
    expect(navItemForShortcut("A", visible)?.href).toBe("/approvals");
    expect(navItemForShortcut("u", visible)).toBeUndefined();
    expect(navItemForShortcut("u", visibleNavItems(["users.manage"]))?.href).toBe("/admin/users");
    expect(navItemForShortcut("z", visible)).toBeUndefined();
  });
});

describe("isTypingTarget", () => {
  it("treats text fields and editable content as typing", () => {
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "select" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("lets shortcuts through from buttons, checkboxes and the page", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("formatNavCount", () => {
  it("hides zero and caps large counts", () => {
    expect(formatNavCount(0)).toBeNull();
    expect(formatNavCount(-2)).toBeNull();
    expect(formatNavCount(7)).toBe("7");
    expect(formatNavCount(140)).toBe("99+");
  });
});
