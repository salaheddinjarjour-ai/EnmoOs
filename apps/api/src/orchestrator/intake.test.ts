import { describe, expect, it } from "vitest";
import { isOpenTurn } from "./intake";

const user = (id: string) =>
  ({ id, role: "USER", kind: "TEXT", agent: null, content: id }) as const;
const manager = (id: string, kind: "TEXT" | "CLARIFY" | "BRIEF") =>
  ({ id, role: "AGENT", kind, agent: "MANAGER", content: id }) as const;

describe("isOpenTurn", () => {
  it("is the newest team message the Manager hasn't answered yet", () => {
    expect(isOpenTurn([user("a")], "a")).toBe(true);
    expect(isOpenTurn([user("a"), manager("q", "CLARIFY"), user("b")], "b")).toBe(true);
  });

  it("leaves an older turn to the newer one's job", () => {
    expect(isOpenTurn([user("a"), user("b")], "a")).toBe(false);
  });

  it("is closed once the Manager asked its question or locked the brief after it", () => {
    expect(isOpenTurn([user("a"), manager("q", "CLARIFY")], "a")).toBe(false);
    expect(isOpenTurn([user("a"), manager("b", "BRIEF")], "a")).toBe(false);
  });

  it("stays open after a notice that answers nothing (budget, failure)", () => {
    expect(isOpenTurn([user("a"), manager("n", "TEXT")], "a")).toBe(true);
  });

  it("is never a message that isn't in the thread or isn't the team's", () => {
    expect(isOpenTurn([user("a")], "gone")).toBe(false);
    expect(isOpenTurn([user("a"), manager("q", "CLARIFY")], "q")).toBe(false);
  });
});
