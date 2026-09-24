import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  type Capability,
  Role,
  ROLE_CAPABILITIES,
  can,
  capabilitiesFor,
} from "../src";

type Grant = readonly [admin: boolean, manager: boolean, editor: boolean];
const ALL: Grant = [true, true, true];
const MANAGER_UP: Grant = [true, true, false];
const ADMIN: Grant = [true, false, false];

// Transcribed row by row from the DESIGN §E capability table.
const EXPECTED: Record<Capability, Grant> = {
  "users.manage": ADMIN,
  "invites.manage": ADMIN,
  "audit.read": ADMIN,
  "clients.read": ALL,
  "campaigns.read": ALL,
  "posts.read": ALL,
  "assets.read": ALL,
  "calendar.read": ALL,
  "dashboard.read": ALL,
  "budget.read": ALL,
  "clients.write": MANAGER_UP,
  "clients.archive": ADMIN,
  "socialAccounts.manage": ADMIN,
  "campaigns.create": ALL,
  "chat.post": ALL,
  "plan.requestChanges": ALL,
  "posts.editCopy": ALL,
  "assets.regenerate": ALL,
  "plan.approve": MANAGER_UP,
  "tasks.resolveEscalation": MANAGER_UP,
  "campaigns.archive": MANAGER_UP,
  "approvals.decide": ALL,
  "approvals.approveAll": MANAGER_UP,
  "publish.reschedule": MANAGER_UP,
  "publish.cancel": MANAGER_UP,
  "publish.retry": MANAGER_UP,
  "analyst.run": MANAGER_UP,
};

const ROLE_INDEX = { ADMIN: 0, MANAGER: 1, EDITOR: 2 } as const;

describe("RBAC capability matrix", () => {
  it("covers exactly the capabilities in the design table", () => {
    expect([...CAPABILITIES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const role of Role.options) {
    it(`grants ${role} exactly its column`, () => {
      for (const capability of CAPABILITIES) {
        expect({ capability, granted: can(role, capability) }).toEqual({
          capability,
          granted: EXPECTED[capability][ROLE_INDEX[role]],
        });
      }
    });
  }

  it("keeps roles strictly nested: EDITOR ⊂ MANAGER ⊂ ADMIN", () => {
    const editor = new Set(ROLE_CAPABILITIES.EDITOR);
    const manager = new Set(ROLE_CAPABILITIES.MANAGER);
    expect([...editor].every((c) => manager.has(c))).toBe(true);
    expect(ROLE_CAPABILITIES.MANAGER.every((c) => can("ADMIN", c))).toBe(true);
    expect(manager.size).toBeGreaterThan(editor.size);
    expect(ROLE_CAPABILITIES.ADMIN.length).toBe(CAPABILITIES.length);
  });

  it("has no duplicate grants", () => {
    for (const role of Role.options) {
      expect(new Set(ROLE_CAPABILITIES[role]).size).toBe(ROLE_CAPABILITIES[role].length);
    }
  });

  it("lists capabilities in canonical order", () => {
    expect(capabilitiesFor("ADMIN")).toEqual([...CAPABILITIES]);
    const editor = capabilitiesFor("EDITOR");
    expect(editor).toEqual(CAPABILITIES.filter((c) => editor.includes(c)));
    expect(editor).not.toContain("clients.write");
  });
});
