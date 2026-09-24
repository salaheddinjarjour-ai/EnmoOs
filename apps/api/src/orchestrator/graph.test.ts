import { canonicalGraph, type TaskNode } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { topologicalOrder } from "./graph";

const node = (id: string, deps: string[]): TaskNode => ({
  id,
  agent: "COPYWRITER",
  action: "write",
  postRef: "p1",
  deps,
  instructions: null,
});

describe("topologicalOrder", () => {
  it("puts every node after its dependencies, keeping plan order among ready nodes", () => {
    const ordered = topologicalOrder([
      node("n3", ["n2"]),
      node("n1", []),
      node("n2", ["n1"]),
      node("n4", []),
    ]);
    expect(ordered.map((n) => n.id)).toEqual(["n1", "n4", "n2", "n3"]);
  });

  it("keeps the canonical graph's order", () => {
    const nodes = canonicalGraph([{ ref: "p1" }, { ref: "p2" }], ["strategy", "write", "qa"]);
    expect(topologicalOrder(nodes).map((n) => n.id)).toEqual(["n1", "n2", "n4", "n3", "n5"]);
  });

  it("rejects cycles and unknown dependencies", () => {
    expect(() => topologicalOrder([node("n1", ["n2"]), node("n2", ["n1"])])).toThrow(/cycle/);
    expect(() => topologicalOrder([node("n1", ["n9"])])).toThrow(/cycle|unknown/);
  });
});
