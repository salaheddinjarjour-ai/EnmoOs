import type { Role } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { isAppError } from "../lib/errors";
import {
  hashPassword,
  planUserUpdate,
  verifyAgainstDummy,
  verifyPassword,
  type UserChanges,
} from "./users";

describe("passwords", () => {
  it("hashes with argon2id and verifies only the right password", async () => {
    const stored = await hashPassword("correct-horse-battery-staple");
    expect(stored).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(stored, "correct-horse-battery-staple")).resolves.toBe(true);
    await expect(verifyPassword(stored, "Correct-horse-battery-staple")).resolves.toBe(false);
  });

  it("treats a malformed stored hash as a mismatch instead of throwing", async () => {
    await expect(verifyPassword("not-a-phc-string", "anything")).resolves.toBe(false);
  });

  it("runs a dummy verification that never succeeds", async () => {
    await expect(verifyAgainstDummy("whatever-the-attacker-sends")).resolves.toBe(false);
  });
});

describe("planUserUpdate", () => {
  const admin = (id: string, isActive = true) => ({ id, role: "ADMIN" as Role, isActive });
  const editor = { id: "editor", role: "EDITOR" as Role, isActive: true };

  function plan(
    target: { id: string; role: Role; isActive: boolean },
    request: { role?: Role; isActive?: boolean },
    activeAdminCount = 2,
  ): UserChanges {
    return planUserUpdate({ actorId: "me", target, request, activeAdminCount });
  }

  function rejection(run: () => unknown): { code: string; message: string } {
    try {
      run();
    } catch (error) {
      if (isAppError(error)) return { code: error.code, message: error.message };
      throw error;
    }
    throw new Error("expected a rejection");
  }

  it("returns only the fields that change", () => {
    expect(plan(editor, { role: "MANAGER" })).toEqual({
      role: { from: "EDITOR", to: "MANAGER" },
    });
    expect(plan(editor, { role: "EDITOR", isActive: false })).toEqual({
      isActive: { from: true, to: false },
    });
    expect(plan(editor, { role: "EDITOR", isActive: true })).toEqual({});
  });

  it("refuses to demote or deactivate yourself, but allows a no-op on yourself", () => {
    expect(rejection(() => plan(admin("me"), { role: "MANAGER" }))).toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/your own role/) as string,
    });
    expect(rejection(() => plan(admin("me"), { isActive: false })).code).toBe("CONFLICT");
    expect(plan(admin("me"), { role: "ADMIN", isActive: true })).toEqual({});
  });

  it("never demotes or deactivates the last active admin", () => {
    expect(rejection(() => plan(admin("other"), { role: "EDITOR" }, 1))).toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/at least one active admin/) as string,
    });
    expect(rejection(() => plan(admin("other"), { isActive: false }, 1)).code).toBe("CONFLICT");
    expect(plan(admin("other"), { role: "MANAGER" }, 2)).toEqual({
      role: { from: "ADMIN", to: "MANAGER" },
    });
  });

  it("lets an inactive admin be changed freely (they are not counted)", () => {
    expect(plan(admin("other", false), { role: "EDITOR" }, 1)).toEqual({
      role: { from: "ADMIN", to: "EDITOR" },
    });
    expect(plan(admin("other", false), { isActive: true }, 1)).toEqual({
      isActive: { from: false, to: true },
    });
  });
});
