import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApprovalDecisionRequest,
  ApprovalRequestDto,
  ApproveAllRequest,
  ApproveAllResponse,
  AgentTaskDto,
  BudgetDto,
  COPY_SHAPE_BY_POST_TYPE,
  CampaignDto,
  ChatMessageDto,
  CopywriterInput,
  CopywriterOutput,
  CreateCampaignRequest,
  DEFAULT_APPROVAL_CHAIN,
  GLOBAL_CHANNEL,
  ManagerIntakeInput,
  ManagerIntakeNoClarifyOutput,
  ManagerIntakeOutput,
  ManagerPlanOutput,
  ManagerQaOutput,
  PostDto,
  PostType,
  REALTIME_EVENT_SCOPE,
  REALTIME_PAYLOADS,
  RealtimeEvent,
  RealtimeEventType,
  RequestPlanChangesRequest,
  TaskGraphDto,
  UpdatePostCopyRequest,
  VisualDirectOutput,
  VisualReviewOutput,
  defaultVisualStyle,
  formatSseFrame,
  isRealtimeChannel,
  issuesFromZodError,
  nestIssues,
  parseRealtimeEvent,
  threadChannel,
  threadIdOfChannel,
  type Brief,
  type CopywriterOutput as CopywriterOutputT,
} from "../src";

const now = "2026-09-24T10:00:00.000Z";

const brief: Brief = {
  clientId: "c1",
  title: "Ramadan iced line",
  objective: "Push the iced line during Ramadan",
  productFocus: "Iced coffee",
  audience: "Young professionals in Riyadh",
  keyMessages: ["Cold brew after iftar"],
  platforms: ["INSTAGRAM", "TIKTOK"],
  postCount: 12,
  postMix: [
    { type: "REEL", count: 6 },
    { type: "CAROUSEL", count: 3 },
    { type: "STATIC", count: 3 },
  ],
  window: { start: "2027-02-08", end: "2027-03-09" },
  cadenceNotes: "Evenings after iftar",
  constraints: [],
  assumptions: ["Arabic and English captions"],
};

const reelCopy: CopywriterOutputT = {
  caption: "Cold brew, after iftar.",
  hashtags: ["#Ramadan", "#IcedCoffee"],
  cta: "Order on the app",
  altText: "A glass of iced coffee on a table at dusk",
  platformCaptions: [
    { platform: "INSTAGRAM", caption: "Cold brew, after iftar." },
    { platform: "TIKTOK", caption: "POV: iftar's done, the cold brew isn't" },
  ],
  script: {
    totalDurationSec: 8,
    hookTimestampSec: 0.8,
    hookText: "Iftar's done.",
    scenes: [
      {
        index: 0,
        startSec: 0,
        durationSec: 3,
        voiceover: "Iftar's done.",
        overlayText: "Iftar's done",
        visualNote: "Table at dusk",
      },
      {
        index: 1,
        startSec: 3,
        durationSec: 5,
        voiceover: "Now the cold brew.",
        overlayText: "",
        visualNote: "Pour",
      },
    ],
  },
  slides: null,
  onScreenText: null,
};

/*
 * DESIGN §C structured-output rules, checked on the JSON Schema the SDK's zodOutputFormat builds
 * from (z.toJSONSchema). Unrepresentable parts (transforms, dates, bigints) make it throw.
 */
function structuredOutputProblems(schema: z.ZodType): string[] {
  const problems: string[] = [];
  const json = z.toJSONSchema(schema, { reused: "ref" }) as Record<string, unknown>;
  if (json.type !== "object") problems.push("root is not an object");

  const visit = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const s = node as Record<string, unknown>;
    if (typeof s.$ref === "string" && s.$ref === "#") problems.push(`${path}: recursive $ref`);
    if (
      !("type" in s) &&
      !("anyOf" in s) &&
      !("oneOf" in s) &&
      !("allOf" in s) &&
      !("$ref" in s) &&
      !("const" in s) &&
      !("enum" in s)
    ) {
      problems.push(`${path}: unconstrained schema (z.any/z.unknown)`);
    }
    if ("default" in s) problems.push(`${path}: default value`);
    if (s.type === "object") {
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required ?? []) as string[]);
      for (const key of Object.keys(properties)) {
        if (!required.has(key)) problems.push(`${path}.${key}: optional field`);
      }
      if (s.additionalProperties !== undefined && s.additionalProperties !== false) {
        problems.push(`${path}: record/open object`);
      }
      if ("propertyNames" in s || "patternProperties" in s) problems.push(`${path}: record`);
      for (const [key, child] of Object.entries(properties)) visit(child, `${path}.${key}`);
    }
    if (s.items) visit(s.items, `${path}[]`);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const variants = s[key];
      if (Array.isArray(variants)) variants.forEach((v, i) => visit(v, `${path}<${key}${i}>`));
    }
    if (s.$defs && typeof s.$defs === "object") {
      for (const [name, def] of Object.entries(s.$defs)) visit(def, `$defs.${name}`);
    }
  };
  visit(json, "$");
  return problems;
}

describe("agent output schemas are structured-output safe", () => {
  it.each([
    ["ManagerIntakeOutput", ManagerIntakeOutput],
    ["ManagerIntakeNoClarifyOutput", ManagerIntakeNoClarifyOutput],
    ["ManagerPlanOutput", ManagerPlanOutput],
    ["ManagerQaOutput", ManagerQaOutput],
    ["CopywriterOutput", CopywriterOutput],
    ["VisualDirectOutput", VisualDirectOutput],
    ["VisualReviewOutput", VisualReviewOutput],
  ] as const)("%s", (_name, schema) => {
    expect(structuredOutputProblems(schema)).toEqual([]);
  });

  it("the checker catches rule violations", () => {
    expect(structuredOutputProblems(z.object({ a: z.string().optional() }))).toEqual([
      "$.a: optional field",
    ]);
    expect(structuredOutputProblems(z.object({ a: z.record(z.string(), z.string()) }))).toContain(
      "$.a: record/open object",
    );
    expect(structuredOutputProblems(z.object({ a: z.any() }))).toEqual([
      "$.a: unconstrained schema (z.any/z.unknown)",
    ]);
    expect(structuredOutputProblems(z.object({ a: z.string().default("x") }))).toEqual([
      "$.a: default value",
    ]);
    expect(() =>
      structuredOutputProblems(z.object({ a: z.string().transform((s) => s.length) })),
    ).toThrow();
  });
});

describe("manager contracts", () => {
  const clarify = {
    result: {
      kind: "clarify",
      question: "Which platforms, and which dates should the campaign run?",
      missing: ["platforms", "window"],
      draft: {
        clientId: "c1",
        title: null,
        objective: "Push the iced line",
        productFocus: "Iced coffee",
        audience: null,
        keyMessages: null,
        platforms: null,
        postCount: 12,
        postMix: null,
        window: { start: null, end: null },
        cadenceNotes: null,
        constraints: null,
        assumptions: null,
      },
    },
  };
  const briefResult = { result: { kind: "brief", brief, confirmation: "12 posts for Qahwa Co." } };

  it("intake accepts either branch", () => {
    expect(ManagerIntakeOutput.parse(clarify).result.kind).toBe("clarify");
    expect(ManagerIntakeOutput.parse(briefResult).result.kind).toBe("brief");
  });

  it("the no-clarify contract only has the brief branch", () => {
    expect(ManagerIntakeNoClarifyOutput.safeParse(clarify).success).toBe(false);
    expect(ManagerIntakeNoClarifyOutput.parse(briefResult)).toEqual(briefResult);
  });

  it("a clarify must name at least one gap", () => {
    const none = { result: { ...clarify.result, missing: [] } };
    expect(ManagerIntakeOutput.safeParse(none).success).toBe(false);
  });

  it("business rules are not refinements: a mix that doesn't sum still parses", () => {
    const off = {
      ...briefResult,
      result: { ...briefResult.result, brief: { ...brief, postCount: 5 } },
    };
    expect(ManagerIntakeOutput.safeParse(off).success).toBe(true);
  });

  it("intake input takes the thread and client list", () => {
    expect(
      ManagerIntakeInput.parse({
        thread: [
          { role: "USER", kind: "TEXT", agent: null, content: "Ramadan campaign, 12 posts" },
        ],
        clients: [{ id: "c1", name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM", "TIKTOK"] }],
        selectedClientId: null,
        today: "2026-09-24",
        allowClarify: true,
        brand: null,
      }).thread,
    ).toHaveLength(1);
  });

  it("plan output enforces id and ref formats", () => {
    const graph = {
      summary: "One reel.",
      posts: [
        {
          ref: "p1",
          type: "REEL",
          platforms: ["TIKTOK"],
          targetDate: "2027-02-10",
          angle: "x",
          pillarHint: null,
        },
      ],
      nodes: [
        {
          id: "n1",
          agent: "COPYWRITER",
          action: "write",
          postRef: "p1",
          deps: [],
          instructions: null,
        },
      ],
    };
    expect(ManagerPlanOutput.safeParse(graph).success).toBe(true);
    expect(
      ManagerPlanOutput.safeParse({ ...graph, nodes: [{ ...graph.nodes[0], id: "node-1" }] })
        .success,
    ).toBe(false);
    expect(
      ManagerPlanOutput.safeParse({ ...graph, posts: [{ ...graph.posts[0], ref: "post1" }] })
        .success,
    ).toBe(false);
  });

  it("QA returns a verdict with routed issues", () => {
    expect(
      ManagerQaOutput.parse({
        verdict: "revise",
        issues: [
          {
            target: "COPYWRITER",
            field: "caption",
            problem: "Too long",
            instruction: "Cut it to one line",
          },
        ],
        summaryForReviewer: "Caption shortened on request.",
      }).verdict,
    ).toBe("revise");
  });
});

describe("copywriter contract", () => {
  it("parses a reel's copy", () => {
    expect(CopywriterOutput.parse(reelCopy)).toEqual(reelCopy);
  });

  it("maps every post type to one body shape", () => {
    expect(Object.keys(COPY_SHAPE_BY_POST_TYPE).sort()).toEqual([...PostType.options].sort());
  });

  it("carries revision feedback verbatim", () => {
    const verbatim = "  Less 'cheap' vibes — more *craft*.\n";
    const input = CopywriterInput.parse({
      brief,
      brand: {
        clientId: "c1",
        name: "Qahwa Co",
        timezone: "Asia/Riyadh",
        brandVoice: "Warm",
        bannedWords: ["cheap"],
        visualStyle: defaultVisualStyle(),
        platforms: ["INSTAGRAM", "TIKTOK"],
      },
      post: {
        ref: "p3",
        type: "REEL",
        platforms: ["INSTAGRAM"],
        targetDate: "2027-02-10",
        angle: "Iftar",
        hook: null,
        pillar: null,
        targetHookSec: null,
        instructions: null,
      },
      revision: { feedback: { verbatim, source: "HUMAN", decisionId: "d1" }, previous: reelCopy },
    });
    expect(input.revision?.feedback.verbatim).toBe(verbatim);
  });
});

describe("issues", () => {
  it("formats zod paths like the validators do", () => {
    const result = CopywriterOutput.safeParse({
      ...reelCopy,
      script: { ...reelCopy.script, scenes: [{ index: 0 }] },
    });
    expect(result.success).toBe(false);
    const paths = issuesFromZodError(result.error!).map((issue) => issue.path);
    expect(paths).toContain("script.scenes[0].startSec");
  });

  it("nests issue paths", () => {
    expect(
      nestIssues("brief", [
        { path: "window.start", message: "m" },
        { path: "", message: "n" },
      ]),
    ).toEqual([
      { path: "brief.window.start", message: "m" },
      { path: "brief", message: "n" },
    ]);
    expect(nestIssues("posts", [{ path: "[2].ref", message: "m" }])).toEqual([
      { path: "posts[2].ref", message: "m" },
    ]);
  });
});

describe("request DTOs", () => {
  it("keeps review feedback byte-for-byte", () => {
    const feedback = "  Make p3 warmer.\n\nKeep the hook. ";
    expect(
      ApprovalDecisionRequest.parse({ decision: "REQUEST_CHANGES", feedback, target: "COPY" })
        .feedback,
    ).toBe(feedback);
    expect(RequestPlanChangesRequest.parse({ feedback }).feedback).toBe(feedback);
  });

  it("requires feedback and a target to request changes", () => {
    expect(
      ApprovalDecisionRequest.safeParse({ decision: "REQUEST_CHANGES", target: "COPY" }).success,
    ).toBe(false);
    expect(
      ApprovalDecisionRequest.safeParse({ decision: "REQUEST_CHANGES", feedback: "x" }).success,
    ).toBe(false);
    expect(
      ApprovalDecisionRequest.safeParse({
        decision: "REQUEST_CHANGES",
        feedback: "   ",
        target: "COPY",
      }).success,
    ).toBe(false);
    expect(ApprovalDecisionRequest.parse({ decision: "APPROVE" })).toEqual({ decision: "APPROVE" });
  });

  it("rejects duplicate approve-all ids", () => {
    expect(ApproveAllRequest.safeParse({ requestIds: ["a", "a"] }).success).toBe(false);
    expect(ApproveAllRequest.safeParse({ requestIds: [] }).success).toBe(false);
  });

  it("trims the opening brief message", () => {
    expect(CreateCampaignRequest.parse({ message: "  Ramadan campaign  " })).toEqual({
      message: "Ramadan campaign",
    });
  });

  it("validates edited copy", () => {
    expect(UpdatePostCopyRequest.safeParse({ copy: reelCopy }).success).toBe(true);
    expect(UpdatePostCopyRequest.safeParse({ copy: { caption: "x" } }).success).toBe(false);
  });
});

const post = {
  id: "post1",
  campaignId: "camp1",
  clientId: "c1",
  ref: "p1",
  type: "REEL" as const,
  platforms: ["INSTAGRAM" as const],
  status: "PENDING_APPROVAL" as const,
  column: "APPROVAL" as const,
  pill: "PENDING_APPROVAL" as const,
  approved: false,
  failed: false,
  targetDate: "2027-02-10",
  pillar: null,
  angle: "Iftar",
  hook: null,
  copy: reelCopy,
  currentAssets: [
    {
      id: "a1",
      kind: "IMAGE" as const,
      status: "READY" as const,
      version: 2,
      shotId: "s1",
      sceneIndex: 0,
      slideIndex: null,
      url: "http://localhost:4000/v1/files/c1/a1.png",
      posterUrl: null,
      mimeType: "image/png",
      width: 1080,
      height: 1920,
      durationSec: null,
    },
  ],
  humanEditCount: 0,
  editable: true,
  revision: 0,
  needsAttention: false,
  attentionReason: null,
  qaNotes: null,
  approvedAt: null,
  liveAt: null,
  currentApproval: {
    id: "ar1",
    round: 1,
    status: "PENDING" as const,
    currentStep: 0,
    stepCount: 1,
    stepName: "Manager review",
    canDecide: true,
  },
  createdAt: now,
  updatedAt: now,
};

const clarifyMessage = {
  id: "m2",
  threadId: "t1",
  role: "AGENT" as const,
  kind: "CLARIFY" as const,
  agent: "MANAGER" as const,
  author: null,
  content: "One question before I plan:",
  payload: {
    question: "Which dates?",
    missing: ["window" as const],
    draft: {
      clientId: "c1",
      title: null,
      objective: null,
      productFocus: null,
      audience: null,
      keyMessages: null,
      platforms: null,
      postCount: null,
      postMix: null,
      window: null,
      cadenceNotes: null,
      constraints: null,
      assumptions: null,
    },
  },
  createdAt: now,
  updatedAt: now,
};

const budget = {
  day: "2026-09-24",
  used: 1200,
  cap: 2_000_000,
  remaining: 1_998_800,
  blockedTasks: 0,
  resetsAt: "2026-09-25T00:00:00.000Z",
};

// Responses are serialised with zod's encode direction, which throws on transforms.
describe("response DTOs round-trip through z.encode", () => {
  it.each([
    [
      "CampaignDto",
      CampaignDto,
      {
        id: "camp1",
        client: { id: "c1", name: "Qahwa Co" },
        name: "Ramadan iced line",
        status: "PLANNING",
        brief,
        clarifyCount: 1,
        threadId: "t1",
        briefAt: now,
        briefLockedAt: null,
        createdById: "u1",
        latestGraph: { id: "g1", version: 1, status: "PROPOSED" },
        createdAt: now,
        updatedAt: now,
      },
    ],
    ["ChatMessageDto (CLARIFY)", ChatMessageDto, clarifyMessage],
    [
      "ChatMessageDto (TEXT)",
      ChatMessageDto,
      {
        ...clarifyMessage,
        kind: "TEXT",
        role: "USER",
        agent: null,
        author: { id: "u1", name: "Admin" },
        payload: null,
      },
    ],
    [
      "TaskGraphDto",
      TaskGraphDto,
      {
        id: "g1",
        campaignId: "camp1",
        version: 1,
        status: "PROPOSED",
        summary: "12 posts",
        posts: [
          {
            ref: "p1",
            type: "REEL",
            platforms: ["TIKTOK"],
            targetDate: "2027-02-10",
            angle: "x",
            pillarHint: null,
          },
        ],
        nodes: [
          {
            id: "n1",
            agent: "COPYWRITER",
            action: "write",
            postRef: "p1",
            deps: [],
            instructions: null,
          },
        ],
        estimate: { calls: 2, inputTokens: 7000, outputTokens: 3300, usd: 0.047 },
        changeRequest: null,
        approvedBy: null,
        approvedAt: null,
        createdAt: now,
      },
    ],
    ["PostDto", PostDto, post],
    [
      "ApprovalRequestDto",
      ApprovalRequestDto,
      {
        id: "ar1",
        postId: "post1",
        round: 2,
        status: "PENDING",
        chain: DEFAULT_APPROVAL_CHAIN,
        currentStep: 0,
        canDecide: true,
        decisions: [
          {
            id: "d1",
            step: 0,
            user: { id: "u1", name: "Admin" },
            decision: "REQUEST_CHANGES",
            feedback: "Warmer",
            target: "COPY",
            viaApproveAll: false,
            createdAt: now,
          },
        ],
        post,
        client: { id: "c1", name: "Qahwa Co" },
        campaign: { id: "camp1", name: "Ramadan" },
        createdAt: now,
        resolvedAt: null,
      },
    ],
    [
      "ApproveAllResponse",
      ApproveAllResponse,
      {
        results: [
          {
            requestId: "ar1",
            postId: "post1",
            outcome: "approved",
            status: "APPROVED",
            currentStep: 0,
            reason: null,
          },
          {
            requestId: "ar9",
            postId: null,
            outcome: "skipped",
            status: null,
            currentStep: null,
            reason: "NOT_FOUND",
          },
        ],
        approvedCount: 1,
        pendingCount: 0,
        skippedCount: 1,
        auditLogId: "al1",
      },
    ],
    ["BudgetDto", BudgetDto, budget],
    [
      "AgentTaskDto",
      AgentTaskDto,
      {
        id: "task1",
        graphId: "g1",
        nodeKey: "n1.r1",
        agent: "COPYWRITER",
        action: "write",
        postId: "post1",
        postRef: "p1",
        dependsOn: [],
        status: "ESCALATED",
        revision: 1,
        contractAttempts: 3,
        feedback: { verbatim: "Warmer", source: "HUMAN", decisionId: "d1" },
        error: "Output failed validation 3 times",
        queuedAt: now,
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
  ] as const)("%s", (_name, schema, sample) => {
    expect(z.encode(schema as z.ZodType, sample)).toEqual(sample);
  });

  it("rejects a payload that doesn't match its message kind", () => {
    expect(ChatMessageDto.safeParse({ ...clarifyMessage, kind: "PLAN" }).success).toBe(false);
  });
});

describe("realtime events", () => {
  it("covers every event type in the union, the payload map and the scope map", () => {
    const types = [...RealtimeEventType.options].sort();
    expect(types).toEqual(Object.keys(REALTIME_PAYLOADS).sort());
    expect(types).toEqual(Object.keys(REALTIME_EVENT_SCOPE).sort());
    expect(types).toEqual([
      "agent.status",
      "alert",
      "approval.created",
      "approval.resolved",
      "asset.updated",
      "budget.updated",
      "learning.created",
      "message.created",
      "message.updated",
      "plan.proposed",
      "post.updated",
      "publish.updated",
      "resync",
    ]);
  });

  it("parses typed events and rejects unknown ones", () => {
    const status = parseRealtimeEvent("agent.status", {
      campaignId: "camp1",
      taskId: "task1",
      agent: "COPYWRITER",
      postRef: "p1",
      state: "done",
      line: "Copywriter ✓ 12/12",
    });
    expect(status.success).toBe(true);
    expect(
      parseRealtimeEvent("message.created", { threadId: "t1", message: clarifyMessage }).success,
    ).toBe(true);
    expect(parseRealtimeEvent("budget.updated", budget).success).toBe(true);
    expect(parseRealtimeEvent("nope", {}).success).toBe(false);
    expect(parseRealtimeEvent("alert", { kind: "stuck" }).success).toBe(false);
    expect(RealtimeEvent.parse({ type: "resync", payload: { reason: "replay limit" } }).type).toBe(
      "resync",
    );
  });

  it("names channels", () => {
    expect(threadChannel("t1")).toBe("thread:t1");
    expect(threadIdOfChannel("thread:t1")).toBe("t1");
    expect(threadIdOfChannel("thread:")).toBeNull();
    expect(threadIdOfChannel(GLOBAL_CHANNEL)).toBeNull();
    expect(isRealtimeChannel("global")).toBe(true);
    expect(isRealtimeChannel("thread:t1")).toBe(true);
    expect(isRealtimeChannel("user:1")).toBe(false);
  });

  it("formats one SSE frame per event with a single data line", () => {
    expect(formatSseFrame({ id: "42", type: "resync", payload: { reason: "a\nb" } })).toBe(
      'id: 42\nevent: resync\ndata: {"reason":"a\\nb"}\n\n',
    );
  });
});
