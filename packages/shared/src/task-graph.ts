import { z } from "zod";
import type { AgentName, PipelineAction } from "./enums";
import type { Brief } from "./contracts/common";
import type { Issue } from "./contracts/issues";
import type { ManagerPlanOutput, PlannedPost, TaskNode } from "./contracts/manager";
import { SONNET_5_PRICING, costUsd, type ModelPricing } from "./pricing";

/** Every pipeline action, in the order a post moves through them. */
export const PIPELINE_ACTION_ORDER = [
  "strategy",
  "write",
  "direct",
  "adapt",
  "qa",
] as const satisfies readonly PipelineAction[];

/** Actions that run once per post, chained in this order. `strategy` runs once per campaign. */
export const PER_POST_ACTIONS = [
  "write",
  "direct",
  "adapt",
  "qa",
] as const satisfies readonly PipelineAction[];
export type PerPostAction = (typeof PER_POST_ACTIONS)[number];

/** Each action has exactly one agent that performs it. */
export const ACTION_AGENT: Readonly<Record<PipelineAction, AgentName>> = {
  strategy: "STRATEGIST",
  write: "COPYWRITER",
  direct: "VISUAL_DIRECTOR",
  adapt: "ADAPTER",
  qa: "MANAGER",
};

/** De-duplicated, in pipeline order (PIPELINE_ACTIONS may be listed in any order). */
export function orderPipelineActions(actions: Iterable<PipelineAction>): PipelineAction[] {
  const enabled = new Set(actions);
  return PIPELINE_ACTION_ORDER.filter((action) => enabled.has(action));
}

export function isPerPostAction(action: PipelineAction): action is PerPostAction {
  return action !== "strategy";
}

/** One node per per-post action per post, plus one strategy node. */
export function maxGraphNodes(postCount: number): number {
  return PER_POST_ACTIONS.length * postCount + 1;
}

/**
 * The graph the Manager is asked to produce: an optional strategy node, then per post a chain of
 * the enabled per-post actions (write → direct → adapt → qa), the first depending on strategy.
 * Ids are n1, n2, … in that order. MockLlm plans with this; validateTaskGraph accepts it.
 */
export function canonicalGraph(
  posts: readonly Pick<PlannedPost, "ref">[],
  enabledActions: readonly PipelineAction[],
): TaskNode[] {
  const actions = orderPipelineActions(enabledActions);
  const nodes: TaskNode[] = [];
  const nextId = () => `n${nodes.length + 1}`;

  let strategyId: string | null = null;
  if (actions.includes("strategy")) {
    strategyId = nextId();
    nodes.push({
      id: strategyId,
      agent: ACTION_AGENT.strategy,
      action: "strategy",
      postRef: null,
      deps: [],
      instructions: null,
    });
  }

  for (const post of posts) {
    let previous = strategyId;
    for (const action of actions.filter(isPerPostAction)) {
      const id = nextId();
      nodes.push({
        id,
        agent: ACTION_AGENT[action],
        action,
        postRef: post.ref,
        deps: previous ? [previous] : [],
        instructions: null,
      });
      previous = id;
    }
  }
  return nodes;
}

/**
 * Business rules for a manager.plan output (DESIGN §C). Pure; [] means the graph can be shown to
 * the user. Messages are written for the model, which gets them back on a retry.
 *
 * When `strategy` is enabled the graph must contain exactly one strategy node: "at most one" is
 * the structural limit, and an enabled action that never runs would silently skip the learning
 * loop.
 */
export function validateTaskGraph(
  graph: ManagerPlanOutput,
  brief: Brief,
  enabledActions: readonly PipelineAction[],
): Issue[] {
  return [...postIssues(graph.posts, brief), ...nodeIssues(graph, enabledActions)];
}

function postIssues(posts: readonly PlannedPost[], brief: Brief): Issue[] {
  const issues: Issue[] = [];

  if (posts.length !== brief.postCount) {
    issues.push({
      path: "posts",
      message: `The plan has ${posts.length} posts; the brief asks for exactly ${brief.postCount}.`,
    });
  }

  const wanted = new Map<string, number>();
  for (const { type, count } of brief.postMix) wanted.set(type, (wanted.get(type) ?? 0) + count);
  const planned = new Map<string, number>();
  for (const { type } of posts) planned.set(type, (planned.get(type) ?? 0) + 1);
  for (const type of new Set([...wanted.keys(), ...planned.keys()])) {
    const want = wanted.get(type) ?? 0;
    const have = planned.get(type) ?? 0;
    if (want !== have) {
      issues.push({
        path: "posts",
        message: `The plan has ${have} ${type} posts; the brief's post mix asks for ${want}.`,
      });
    }
  }

  const briefPlatforms = new Set<string>(brief.platforms);
  const seenRefs = new Set<string>();
  posts.forEach((post, i) => {
    if (seenRefs.has(post.ref)) {
      issues.push({ path: `posts[${i}].ref`, message: `Post ref "${post.ref}" is used twice.` });
    }
    seenRefs.add(post.ref);

    const seenPlatforms = new Set<string>();
    post.platforms.forEach((platform, j) => {
      if (!briefPlatforms.has(platform)) {
        issues.push({
          path: `posts[${i}].platforms[${j}]`,
          message: `${platform} is not one of the brief's platforms (${brief.platforms.join(", ")}).`,
        });
      }
      if (seenPlatforms.has(platform)) {
        issues.push({
          path: `posts[${i}].platforms[${j}]`,
          message: `${platform} is listed twice.`,
        });
      }
      seenPlatforms.add(platform);
    });

    if (post.targetDate < brief.window.start || post.targetDate > brief.window.end) {
      issues.push({
        path: `posts[${i}].targetDate`,
        message: `${post.targetDate} is outside the campaign window ${brief.window.start} to ${brief.window.end}.`,
      });
    }
  });

  return issues;
}

function nodeIssues(graph: ManagerPlanOutput, enabledActions: readonly PipelineAction[]): Issue[] {
  const issues: Issue[] = [];
  const { nodes, posts } = graph;
  const enabled = orderPipelineActions(enabledActions);
  const enabledSet = new Set<PipelineAction>(enabled);
  const postRefs = new Set(posts.map((post) => post.ref));

  const limit = maxGraphNodes(posts.length);
  if (nodes.length > limit) {
    issues.push({
      path: "nodes",
      message: `The graph has ${nodes.length} nodes; ${posts.length} posts allow at most ${limit}.`,
    });
  }

  const byId = new Map<string, TaskNode>();
  nodes.forEach((node, i) => {
    if (byId.has(node.id)) {
      issues.push({ path: `nodes[${i}].id`, message: `Node id "${node.id}" is used twice.` });
    } else {
      byId.set(node.id, node);
    }
  });

  nodes.forEach((node, i) => {
    const expectedAgent = ACTION_AGENT[node.action];
    if (node.agent !== expectedAgent) {
      issues.push({
        path: `nodes[${i}].agent`,
        message: `Action "${node.action}" is performed by ${expectedAgent}, not ${node.agent}.`,
      });
    }
    if (!enabledSet.has(node.action)) {
      issues.push({
        path: `nodes[${i}].action`,
        message: `"${node.action}" is not an enabled action (enabled: ${enabled.join(", ")}).`,
      });
    }
    if (node.action === "strategy") {
      if (node.postRef !== null) {
        issues.push({
          path: `nodes[${i}].postRef`,
          message: "The strategy node covers the whole campaign; its postRef must be null.",
        });
      }
    } else if (node.postRef === null) {
      issues.push({
        path: `nodes[${i}].postRef`,
        message: `A "${node.action}" node must name the post it works on.`,
      });
    } else if (!postRefs.has(node.postRef)) {
      issues.push({ path: `nodes[${i}].postRef`, message: `Unknown post "${node.postRef}".` });
    }

    const seenDeps = new Set<string>();
    node.deps.forEach((dep, j) => {
      if (dep === node.id) {
        issues.push({ path: `nodes[${i}].deps[${j}]`, message: "A node cannot depend on itself." });
      } else if (!byId.has(dep)) {
        issues.push({ path: `nodes[${i}].deps[${j}]`, message: `Unknown node "${dep}".` });
      } else if (seenDeps.has(dep)) {
        issues.push({ path: `nodes[${i}].deps[${j}]`, message: `"${dep}" is listed twice.` });
      }
      seenDeps.add(dep);
    });
  });

  const strategyNodes = nodes.filter((node) => node.action === "strategy");
  if (strategyNodes.length > 1) {
    issues.push({ path: "nodes", message: "Only one strategy node is allowed." });
  } else if (strategyNodes.length === 0 && enabledSet.has("strategy")) {
    issues.push({
      path: "nodes",
      message:
        "Strategy is enabled: add one strategy node (postRef null) that every first per-post node depends on.",
    });
  }
  // What each post's first node depends on; undefined while the strategy node itself is wrong,
  // so the model isn't told two contradictory things about the same deps.
  const firstUpstream = !enabledSet.has("strategy")
    ? null
    : strategyNodes.length === 1
      ? strategyNodes[0]!.id
      : undefined;

  issues.push(...chainIssues(graph, enabled.filter(isPerPostAction), firstUpstream));
  issues.push(...cycleIssues(nodes, byId));
  return issues;
}

/** Each post: exactly one node per enabled per-post action, each depending on exactly the previous. */
function chainIssues(
  graph: ManagerPlanOutput,
  actions: readonly PerPostAction[],
  firstUpstream: string | null | undefined,
): Issue[] {
  const issues: Issue[] = [];
  const indexOf = new Map(graph.nodes.map((node, i) => [node, i]));

  for (const post of graph.posts) {
    const chain: (TaskNode | null)[] = actions.map((action) => {
      const matches = graph.nodes.filter((n) => n.postRef === post.ref && n.action === action);
      if (matches.length === 0) {
        issues.push({ path: "nodes", message: `Post ${post.ref} has no "${action}" node.` });
      } else if (matches.length > 1) {
        const ids = matches.map((n) => n.id).join(", ");
        issues.push({
          path: "nodes",
          message: `Post ${post.ref} has ${matches.length} "${action}" nodes (${ids}); it needs exactly one.`,
        });
      }
      return matches.length === 1 ? matches[0]! : null;
    });

    chain.forEach((node, k) => {
      if (!node) return;
      const upstream = k === 0 ? firstUpstream : chain[k - 1]?.id;
      // An ambiguous or missing predecessor is already reported above.
      if (upstream === undefined) return;
      const expected = upstream === null ? [] : [upstream];
      const actual = new Set(node.deps);
      if (actual.size !== expected.length || !expected.every((id) => actual.has(id))) {
        const what =
          upstream === null
            ? "nothing"
            : k === 0
              ? `exactly [${upstream}] (the strategy node)`
              : `exactly [${upstream}] (the "${actions[k - 1]}" node for ${post.ref})`;
        issues.push({
          path: `nodes[${indexOf.get(node)}].deps`,
          message: `The "${node.action}" node for ${post.ref} must depend on ${what}.`,
        });
      }
    });
  }
  return issues;
}

/** Kahn's algorithm over the known (deduplicated) edges. */
function cycleIssues(nodes: readonly TaskNode[], byId: ReadonlyMap<string, TaskNode>): Issue[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of byId.keys()) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const [id, node] of byId) {
    for (const dep of new Set(node.deps)) {
      if (dep === id || !byId.has(dep)) continue;
      inDegree.set(id, inDegree.get(id)! + 1);
      dependents.get(dep)!.push(id);
    }
  }

  const ready = [...inDegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    visited += 1;
    for (const next of dependents.get(id)!) {
      const degree = inDegree.get(next)! - 1;
      inDegree.set(next, degree);
      if (degree === 0) ready.push(next);
    }
  }
  if (visited === byId.size) return [];

  const stuck = nodes
    .map((node) => node.id)
    .filter((id, i, ids) => ids.indexOf(id) === i && inDegree.get(id)! > 0);
  return [
    { path: "nodes", message: `The dependencies form a cycle (involving ${stuck.join(", ")}).` },
  ];
}

/* ─── cost estimate ──────────────────────────────────────────────────────────────────────────── */

/** Expected LLM spend for one graph node on the happy path. */
export interface ActionCostProfile {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Added per planned post (the strategy node reasons over every post at once). */
  inputTokensPerPost: number;
  outputTokensPerPost: number;
}

/**
 * Per-node token profile for plan estimates. Figures are Sonnet 5 happy-path calls without
 * prompt-cache discounts or contract retries, so the estimate errs high:
 *   - input  = frozen system prompt + brand block + brief + the post/upstream outputs;
 *   - output = adaptive thinking at the action's default effort + the JSON itself.
 * `direct` includes the Visual Director's render reviews (~3 shots per post, each review an image
 * of ~1.6k tokens plus context). Revisit these when AgentRun data shows real medians.
 */
export const ACTION_COST_PROFILE: Readonly<Record<PipelineAction, Readonly<ActionCostProfile>>> = {
  strategy: {
    calls: 1,
    inputTokens: 6_000,
    outputTokens: 4_000,
    inputTokensPerPost: 300,
    outputTokensPerPost: 250,
  },
  write: {
    calls: 1,
    inputTokens: 3_000,
    outputTokens: 2_500,
    inputTokensPerPost: 0,
    outputTokensPerPost: 0,
  },
  direct: {
    calls: 4,
    inputTokens: 12_400,
    outputTokens: 4_200,
    inputTokensPerPost: 0,
    outputTokensPerPost: 0,
  },
  adapt: {
    calls: 1,
    inputTokens: 3_500,
    outputTokens: 1_200,
    inputTokensPerPost: 0,
    outputTokensPerPost: 0,
  },
  qa: {
    calls: 1,
    inputTokens: 4_000,
    outputTokens: 800,
    inputTokensPerPost: 0,
    outputTokensPerPost: 0,
  },
};

export const PlanEstimate = z.object({
  calls: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type PlanEstimate = z.infer<typeof PlanEstimate>;

/** Code-computed spend for approving `graph` (shown on the PlanCard against the daily budget). */
export function estimatePlan(
  graph: Pick<ManagerPlanOutput, "posts" | "nodes">,
  pricing: Readonly<ModelPricing> = SONNET_5_PRICING,
): PlanEstimate {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const postCount = graph.posts.length;
  for (const node of graph.nodes) {
    const profile = ACTION_COST_PROFILE[node.action];
    calls += profile.calls;
    inputTokens += profile.inputTokens + profile.inputTokensPerPost * postCount;
    outputTokens += profile.outputTokens + profile.outputTokensPerPost * postCount;
  }
  const usd = costUsd(
    { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    pricing,
  );
  return { calls, inputTokens, outputTokens, usd: Math.round(usd * 10_000) / 10_000 };
}
