import { describe, expect, it } from "vitest";
import { nodeKeyOrder } from "./agent-tasks";

describe("nodeKeyOrder", () => {
  it("orders planned nodes numerically, each followed by its revisions", () => {
    const keys = ["n10", "n2.r1", "n2", "n1", "n2.r2", "n1-direct.r3"];
    const sorted = [...keys].sort((a, b) => {
      const [an, ar] = nodeKeyOrder(a);
      const [bn, br] = nodeKeyOrder(b);
      return an - bn || ar - br;
    });
    expect(sorted).toEqual(["n1", "n1-direct.r3", "n2", "n2.r1", "n2.r2", "n10"]);
  });
});
