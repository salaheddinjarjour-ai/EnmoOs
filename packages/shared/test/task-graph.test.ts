import { describe, expect, it } from "vitest";
import {
  ACTION_AGENT,
  ACTION_COST_PROFILE,
  ManagerPlanOutput,
  PIPELINE_ACTION_ORDER,
  type PipelineAction,
  SONNET_5_PRICING,
  canonicalGraph,
  costUsdMicros,
  estimatePlan,
  maxGraphNodes,
  orderPipelineActions,
  validateTaskGraph,
  type Brief,
  type PlannedPost,
  type TaskNode,
} from "../src";

const brief: Brief = {
  clientId: "c1",
  title: "Ramadan iced line",
  objective: "Push the iced line during Ramadan",
  productFocus: "Iced coffee",
  audience: null,
  keyMessages: ["Cold brew after iftar"],
  platforms: ["INSTAGRAM", "TIKTOK"],
  postCount: 4,
  postMix: [
    { type: "REEL", count: 2 },
    { type: "STATIC", count: 1 },
    { type: "CAROUSEL", count: 1 },
  ],
  window: { start: "2026-03-01", end: "2026-03-30" },
  cadenceNotes: null,
  constraints: [],
  assumptions: [],
};

const posts: PlannedPost[] = [
  {
    ref: "p1",
    type: "REEL",
    platforms: ["INSTAGRAM", "TIKTOK"],
    targetDate: "2026-03-01",
    angle: "Iftar ritual",
    pillarHint: null,
  },
  {
    ref: "p2",
    type: "REEL",
    platforms: ["TIKTOK"],
    targetDate: "2026-03-08",
    angle: "Cold brew",
    pillarHint: "Craft",
  },
  {
    ref: "p3",
    type: "STATIC",
    platforms: ["INSTAGRAM"],
    targetDate: "2026-03-15",
    angle: "The pour",
    pillarHint: null,
  },
  {
    ref: "p4",
    type: "CAROUSEL",
    platforms: ["INSTAGRAM"],
    targetDate: "2026-03-30",
    angle: "Menu",
    pillarHint: null,
  },
];

const PHASE2: PipelineAction[] = ["write", "qa"];
const ALL: PipelineAction[] = [...PIPELINE_ACTION_ORDER];

function plan(actions: PipelineAction[] = PHASE2, overrides: Partial<ManagerPlanOutput> = {}) {
  return ManagerPlanOutput.parse({
    summary: "Four posts across Instagram and TikTok.",
    posts,
    nodes: canonicalGraph(posts, actions),
    ...overrides,
  });
}

function withNodes(edit: (nodes: TaskNode[]) => TaskNode[], actions = PHASE2) {
  const graph = plan(actions);
  return { ...graph, nodes: edit(graph.nodes.map((node) => ({ ...node, deps: [...node.deps] }))) };
}

const messages = (graph: ManagerPlanOutput, actions = PHASE2) =>
  validateTaskGraph(graph, brief, actions).map((issue) => `${issue.path}: ${issue.message}`);

describe("pipeline actions", () => {
  it("maps every action to its one agent", () => {
    expect(ACTION_AGENT).toEqual({
      strategy: "STRATEGIST",
      write: "COPYWRITER",
      direct: "VISUAL_DIRECTOR",
      adapt: "ADAPTER",
      qa: "MANAGER",
    });
  });

  it("orders and de-duplicates PIPELINE_ACTIONS", () => {
    expect(orderPipelineActions(["qa", "write", "qa", "strategy"])).toEqual([
      "strategy",
      "write",
      "qa",
    ]);
  });
});

describe("canonicalGraph", () => {
  it("chains write → qa per post for Phase 2", () => {
    expect(canonicalGraph(posts.slice(0, 2), PHASE2)).toEqual([
      {
        id: "n1",
        agent: "COPYWRITER",
        action: "write",
        postRef: "p1",
        deps: [],
        instructions: null,
      },
      { id: "n2", agent: "MANAGER", action: "qa", postRef: "p1", deps: ["n1"], instructions: null },
      {
        id: "n3",
        agent: "COPYWRITER",
        action: "write",
        postRef: "p2",
        deps: [],
        instructions: null,
      },
      { id: "n4", agent: "MANAGER", action: "qa", postRef: "p2", deps: ["n3"], instructions: null },
    ]);
  });

  it("puts one strategy node first and hangs every write off it", () => {
    const nodes = canonicalGraph(posts, ALL);
    expect(nodes).toHaveLength(maxGraphNodes(posts.length));
    expect(nodes[0]).toMatchObject({ id: "n1", action: "strategy", postRef: null, deps: [] });
    for (const write of nodes.filter((n) => n.action === "write"))
      expect(write.deps).toEqual(["n1"]);
    expect(nodes.slice(1, 5).map((n) => [n.action, n.deps])).toEqual([
      ["write", ["n1"]],
      ["direct", ["n2"]],
      ["adapt", ["n3"]],
      ["qa", ["n4"]],
    ]);
  });

  it("ignores the order PIPELINE_ACTIONS was written in", () => {
    expect(canonicalGraph(posts, ["qa", "direct", "write"])).toEqual(
      canonicalGraph(posts, ["write", "direct", "qa"]),
    );
  });

  it("passes validation for every phase's actions", () => {
    for (const actions of [
      PHASE2,
      ["write", "direct", "qa"],
      ["write", "direct", "adapt", "qa"],
      ALL,
    ] as PipelineAction[][]) {
      expect(validateTaskGraph(plan(actions), brief, actions)).toEqual([]);
    }
  });
});

describe("validateTaskGraph: posts", () => {
  it("requires the brief's post count and mix", () => {
    const graph = plan(PHASE2, {
      posts: posts.slice(0, 3),
      nodes: canonicalGraph(posts.slice(0, 3), PHASE2),
    });
    expect(messages(graph)).toEqual([
      "posts: The plan has 3 posts; the brief asks for exactly 4.",
      "posts: The plan has 0 CAROUSEL posts; the brief's post mix asks for 1.",
    ]);
  });

  it("sums repeated post-mix entries", () => {
    const split = {
      ...brief,
      postMix: [
        { type: "REEL" as const, count: 1 },
        ...brief.postMix.map((m) => (m.type === "REEL" ? { ...m, count: 1 } : m)),
      ],
    };
    expect(validateTaskGraph(plan(), split, PHASE2)).toEqual([]);
  });

  it("flags a type swap", () => {
    const swapped = posts.map((p) => (p.ref === "p3" ? { ...p, type: "STORY" as const } : p));
    expect(messages(plan(PHASE2, { posts: swapped }))).toEqual([
      "posts: The plan has 0 STATIC posts; the brief's post mix asks for 1.",
      "posts: The plan has 1 STORY posts; the brief's post mix asks for 0.",
    ]);
  });

  it("keeps platforms inside the brief's and unique", () => {
    const bad = posts.map((p) =>
      p.ref === "p2"
        ? { ...p, platforms: ["FACEBOOK" as const, "TIKTOK" as const, "TIKTOK" as const] }
        : p,
    );
    expect(messages(plan(PHASE2, { posts: bad }))).toEqual([
      "posts[1].platforms[0]: FACEBOOK is not one of the brief's platforms (INSTAGRAM, TIKTOK).",
      "posts[1].platforms[2]: TIKTOK is listed twice.",
    ]);
  });

  it("keeps dates inside the window, both ends inclusive", () => {
    const bad = posts.map((p) =>
      p.ref === "p1"
        ? { ...p, targetDate: "2026-02-28" }
        : p.ref === "p4"
          ? { ...p, targetDate: "2026-03-31" }
          : p,
    );
    expect(messages(plan(PHASE2, { posts: bad }))).toEqual([
      "posts[0].targetDate: 2026-02-28 is outside the campaign window 2026-03-01 to 2026-03-30.",
      "posts[3].targetDate: 2026-03-31 is outside the campaign window 2026-03-01 to 2026-03-30.",
    ]);
  });

  it("rejects duplicate refs", () => {
    const dup = posts.map((p) => (p.ref === "p2" ? { ...p, ref: "p1" } : p));
    const issues = messages(plan(PHASE2, { posts: dup, nodes: canonicalGraph(dup, PHASE2) }));
    expect(issues).toContain('posts[1].ref: Post ref "p1" is used twice.');
  });
});

describe("validateTaskGraph: nodes", () => {
  it("rejects duplicate ids and unknown or self dependencies", () => {
    const graph = withNodes((nodes) => {
      nodes[1]!.id = "n1";
      nodes[3]!.deps = ["n4", "n99"];
      return nodes;
    });
    expect(messages(graph)).toEqual(
      expect.arrayContaining([
        'nodes[1].id: Node id "n1" is used twice.',
        "nodes[3].deps[0]: A node cannot depend on itself.",
        'nodes[3].deps[1]: Unknown node "n99".',
      ]),
    );
  });

  it("rejects repeated deps", () => {
    const graph = withNodes((nodes) => {
      nodes[1]!.deps = ["n1", "n1"];
      return nodes;
    });
    expect(messages(graph)).toEqual(['nodes[1].deps[1]: "n1" is listed twice.']);
  });

  it("enforces the fixed agent for each action", () => {
    const graph = withNodes((nodes) => {
      nodes[0]!.agent = "MANAGER";
      return nodes;
    });
    expect(messages(graph)).toEqual([
      'nodes[0].agent: Action "write" is performed by COPYWRITER, not MANAGER.',
    ]);
  });

  it("only allows enabled actions", () => {
    const graph = plan(["write", "direct", "qa"]);
    expect(messages(graph)).toContain(
      'nodes[1].action: "direct" is not an enabled action (enabled: write, qa).',
    );
  });

  it("requires per-post nodes to name a known post", () => {
    const graph = withNodes((nodes) => {
      nodes[0]!.postRef = null;
      nodes[2]!.postRef = "p9";
      return nodes;
    });
    expect(messages(graph)).toEqual(
      expect.arrayContaining([
        'nodes[0].postRef: A "write" node must name the post it works on.',
        'nodes[2].postRef: Unknown post "p9".',
        'nodes: Post p1 has no "write" node.',
        'nodes: Post p2 has no "write" node.',
      ]),
    );
  });

  it("requires exactly one node per enabled action per post", () => {
    const graph = withNodes((nodes) => [
      ...nodes.filter((n) => !(n.postRef === "p2" && n.action === "qa")),
      {
        id: "n20",
        agent: "COPYWRITER",
        action: "write",
        postRef: "p1",
        deps: [],
        instructions: null,
      },
    ]);
    expect(messages(graph)).toEqual([
      'nodes: Post p1 has 2 "write" nodes (n1, n20); it needs exactly one.',
      'nodes: Post p2 has no "qa" node.',
    ]);
  });

  it("requires each step to depend on exactly the previous one", () => {
    const graph = withNodes((nodes) => {
      nodes[1]!.deps = [];
      nodes[2]!.deps = ["n1"];
      return nodes;
    });
    expect(messages(graph)).toEqual([
      'nodes[1].deps: The "qa" node for p1 must depend on exactly [n1] (the "write" node for p1).',
      'nodes[2].deps: The "write" node for p2 must depend on nothing.',
    ]);
  });

  it("detects cycles (Kahn)", () => {
    const graph = withNodes((nodes) => {
      nodes[0]!.deps = ["n2"];
      return nodes;
    });
    const issues = messages(graph);
    expect(issues).toContain("nodes: The dependencies form a cycle (involving n1, n2).");
  });

  it("caps the node count at 4 × posts + 1", () => {
    const extra: TaskNode[] = Array.from({ length: 10 }, (_, i) => ({
      id: `n${100 + i}`,
      agent: "COPYWRITER",
      action: "write",
      postRef: "p1",
      deps: [],
      instructions: null,
    }));
    const graph = withNodes((nodes) => [...nodes, ...extra]);
    expect(messages(graph)[0]).toBe("nodes: The graph has 18 nodes; 4 posts allow at most 17.");
  });
});

describe("validateTaskGraph: strategy", () => {
  it("allows at most one strategy node, without a post", () => {
    const graph = withNodes((nodes) => [...nodes, { ...nodes[0]!, id: "n50", postRef: "p1" }], ALL);
    expect(messages(graph, ALL)).toEqual(
      expect.arrayContaining([
        "nodes[17].postRef: The strategy node covers the whole campaign; its postRef must be null.",
        "nodes: Only one strategy node is allowed.",
      ]),
    );
  });

  it("requires the strategy node when strategy is enabled", () => {
    const graph = withNodes(
      (nodes) =>
        nodes
          .filter((n) => n.action !== "strategy")
          .map((n) => ({ ...n, deps: n.action === "write" ? [] : n.deps })),
      ALL,
    );
    expect(messages(graph, ALL)).toEqual([
      "nodes: Strategy is enabled: add one strategy node (postRef null) that every first per-post node depends on.",
    ]);
  });

  it("requires every write to depend on the strategy node", () => {
    const graph = withNodes((nodes) => {
      nodes[1]!.deps = [];
      return nodes;
    }, ALL);
    expect(messages(graph, ALL)).toEqual([
      'nodes[1].deps: The "write" node for p1 must depend on exactly [n1] (the strategy node).',
    ]);
  });

  it("rejects a strategy node when strategy is not enabled", () => {
    const graph = plan(["strategy", "write", "qa"]);
    expect(messages(graph)).toEqual(
      expect.arrayContaining([
        'nodes[0].action: "strategy" is not an enabled action (enabled: write, qa).',
        'nodes[1].deps: The "write" node for p1 must depend on nothing.',
      ]),
    );
  });
});

describe("estimatePlan", () => {
  it("prices a 12-post Phase 2 plan from the per-action table", () => {
    const twelve: PlannedPost[] = Array.from({ length: 12 }, (_, i) => ({
      ...posts[0]!,
      ref: `p${i + 1}`,
    }));
    const estimate = estimatePlan({ posts: twelve, nodes: canonicalGraph(twelve, PHASE2) });
    const inputTokens =
      12 * (ACTION_COST_PROFILE.write.inputTokens + ACTION_COST_PROFILE.qa.inputTokens);
    const outputTokens =
      12 * (ACTION_COST_PROFILE.write.outputTokens + ACTION_COST_PROFILE.qa.outputTokens);
    expect(estimate).toEqual({
      calls: 24,
      inputTokens,
      outputTokens,
      usd: (inputTokens * SONNET_5_PRICING.input + outputTokens * SONNET_5_PRICING.output) / 1e6,
    });
    expect(estimate.usd).toBeCloseTo(0.564, 6);
  });

  it("scales the strategy node with the number of posts", () => {
    const one = estimatePlan({
      posts: posts.slice(0, 1),
      nodes: canonicalGraph(posts.slice(0, 1), ["strategy"]),
    });
    const four = estimatePlan({ posts, nodes: canonicalGraph(posts, ["strategy"]) });
    expect(four.inputTokens - one.inputTokens).toBe(
      3 * ACTION_COST_PROFILE.strategy.inputTokensPerPost,
    );
    expect(four.calls).toBe(1);
  });
});

describe("pricing", () => {
  it("prices tokens in micro-dollars at Sonnet 5 rates", () => {
    expect(
      costUsdMicros({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe((2 + 10 + 0.2 + 2.5) * 1_000_000);
  });
});
