import {
  MockLlm,
  type LlmClient,
  type LlmContentBlock,
  type LlmImageBlock,
  type LlmRequest,
  type LlmResponse,
} from "@enmo/agents";
import { MockProvider, toReviewImage } from "@enmo/providers";
import {
  AssetParams,
  AssetReview,
  COPY_SHAPE_BY_POST_TYPE,
  CopywriterOutput,
  MAX_VISUAL_REGENERATIONS,
  VISUAL_LIMITS,
  VisualDirectInput,
  VisualReviewInput,
  type VisualReviewOutput,
  type AgentStatusPayload,
  type AgentTaskDto,
  type AlertPayload,
  type ApprovalRequestDto,
  type AssetDetailDto,
  type AssetDto,
  type AssetListResponse,
  type AssetUpdatedPayload,
  type CampaignDto,
  type ChatMessageDto,
  type PlanProposedPayload,
  type PostDto,
  type PostListResponse,
  type TaskGraphDto,
} from "@enmo/shared";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/lib/clock";
import { currentContentHash } from "../../src/orchestrator/approval-round";
import { browserHeaders } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";
import {
  seedProposedPlan,
  startHarness,
  type Harness,
  type HarnessOptions,
} from "../helpers/harness";

/*
 * Phase 3 exit test "brief → approvable post card with a placeholder visual" (DESIGN "Phase 3",
 * exit test phase3.brief-to-visual), on the harness with MockLlm, MockProvider and LocalStorage in
 * a temporary directory, over HTTP on the real port:
 *   (a) a chat brief runs write → direct → qa: every post lands in approval with one READY current
 *       take per shot, each reviewed by the Visual Director (the image reached the LLM) and served
 *       from /files as a 1080×1920 PNG, whatever the post type (the 9:16 master Phase 5 crops);
 *   (b) a Vault regenerate creates v2 of the lineage, gives the Visual Director the take's original
 *       context (its shot, the post's copy, the brand) with the instruction verbatim, and sends the
 *       post through QA into a new approval round (an approved post's approval reopens);
 *   (c) MOCK_LLM_FAULTS="VISUAL_DIRECTOR.review:weak*3" → two regenerations as new versions, then
 *       an escalation that accept_best (or retry) resolves;
 *   (d) the Vault lists every take, versioned and searchable by prompt, campaign and shot.
 */

const BRIEF = "Ramadan campaign for the coffee client — 12 posts, push the iced line";
const ANSWER = "Instagram and Facebook, March 1–30";
const NOW = "2027-01-11T09:00:00.000Z";
const INSTRUCTION = "  Closer on the glass, condensation catching the light.\n";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** JSON requests as the signed-in browser would send them; anything but 2xx throws. */
function apiFor(h: Harness, cookie: string) {
  const headers = browserHeaders(cookie);
  return async <T>(method: "GET" | "POST", url: string, payload?: object) => {
    const response = await h.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300) {
      throw new Error(`${method} ${url} → ${response.statusCode}: ${response.body}`);
    }
    return { status: response.statusCode, body: response.json<T>() };
  };
}

/** How many shots a post's copy calls for: one per scene, per slide, or one. */
function shotCount(post: PostDto): number {
  const copy = CopywriterOutput.parse(post.copy);
  switch (COPY_SHAPE_BY_POST_TYPE[post.type]) {
    case "script":
      return copy.script!.scenes.length;
    case "slides":
      return copy.slides!.length;
    case "onScreenText":
      return 1;
  }
}

/** DESIGN "Phase 3" exit test: every current take is served as a 1080×1920 PNG. */
const MASTER_SIZE = { width: 1080, height: 1920 } as const;

/** Downloads a take from /files over the real port and checks it is a 1080×1920 PNG. */
async function expectServedPng(h: Harness, post: PostDto, url: string | null) {
  expect(url, post.ref).not.toBeNull();
  expect(url!.startsWith(`${h.deps.config.PUBLIC_ASSET_BASE_URL}/`)).toBe(true);
  const path = new URL(url!).pathname;
  const response = await fetch(`${h.url}${path}`);
  expect(response.status, `${post.ref} ${path}`).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  expect({ format: meta.format, width: meta.width, height: meta.height }, post.ref).toEqual({
    format: "png",
    ...MASTER_SIZE,
  });
}

/** A 1080×1920 master as the review sees it: scaled to VISUAL_LIMITS.reviewImageMaxEdge (1568). */
const REVIEW_SIZE = { width: 882, height: 1568 } as const;

/** The content blocks of every message of a request, strings as text blocks. */
function blocksOf(request: LlmRequest): LlmContentBlock[] {
  return request.messages.flatMap((message) =>
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content,
  );
}

/** What one VISUAL_DIRECTOR.review call showed the model. */
interface ShownRender {
  /** VisualReviewInput.render.assetId: the take the call was about. */
  assetId: string;
  attempt: number;
  maxAttempts: number;
  images: LlmImageBlock[];
  text: string;
}

/**
 * Records every VISUAL_DIRECTOR.review request as the model receives it (the image blocks and the
 * user turn), then answers as `inner` (MockLlm unless given).
 */
class ReviewRecorder implements LlmClient {
  readonly provider: LlmClient["provider"];
  readonly model: string;
  readonly shown: ShownRender[] = [];

  constructor(private readonly inner: LlmClient = new MockLlm()) {
    this.provider = inner.provider;
    this.model = inner.model;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.meta.agent === "VISUAL_DIRECTOR" && request.meta.action === "review") {
      const input = request.meta.input as VisualReviewInput;
      const blocks = blocksOf(request);
      this.shown.push({
        assetId: input.render.assetId,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        images: blocks.filter((block): block is LlmImageBlock => block.type === "image"),
        text: blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
      });
    }
    return this.inner.complete(request);
  }
}

/**
 * Every review showed the model the take under review, and only it: that take's own stored still,
 * downscaled for review (never the full-size file, a parent's or a sibling's). Returns each take's
 * image (base64) by asset id.
 */
async function expectEachReviewSawItsTake(
  h: Harness,
  shown: readonly ShownRender[],
): Promise<Map<string, string>> {
  expect(VISUAL_LIMITS.reviewImageMaxEdge).toBe(REVIEW_SIZE.height);
  expect(shown.length).toBeGreaterThan(0);
  const seen = new Map<string, string>();
  for (const review of shown) {
    expect(review.images, review.assetId).toHaveLength(1);
    const [image] = review.images;
    const take = await testDb().asset.findUniqueOrThrow({ where: { id: review.assetId } });
    // MockProvider stores a VIDEO shot as its poster PNG, so every take's still is its file.
    const stored = await h.deps.storage.get(take.storageKey!);
    const expected = await toReviewImage(stored!.body);
    expect(image!.mediaType, review.assetId).toBe(expected.mediaType);
    // Compared as a flag: a mismatch would otherwise print two megabytes of base64.
    expect(image!.data === expected.data, `${review.assetId} was shown another image`).toBe(true);
    const meta = await sharp(Buffer.from(image!.data, "base64")).metadata();
    expect({ width: meta.width, height: meta.height }, review.assetId).toEqual(REVIEW_SIZE);
    // A contract retry shows the same take again; no two takes are ever shown the same image.
    expect((seen.get(review.assetId) ?? image!.data) === image!.data, review.assetId).toBe(true);
    seen.set(review.assetId, image!.data);
  }
  expect(new Set(seen.values()).size).toBe(seen.size);
  return seen;
}

async function startOnePostPlan(options: HarnessOptions, type: "STATIC" | "CAROUSEL" | "REEL") {
  const h = (harness = await startHarness({ clock: new FakeClock(), ...options }));
  const seeded = await seedProposedPlan(h, { postCount: 1, type });
  const cookie = await sessionCookieFor(seeded.admin, { now: h.clock.now() });
  const api = apiFor(h, cookie);
  await api<TaskGraphDto>("POST", `/v1/task-graphs/${seeded.graphId}/approve`, {});
  const post = await testDb().post.findFirstOrThrow({ where: { campaignId: seeded.campaignId } });
  return { h, seeded, api, cookie, postId: post.id };
}

/**
 * A reviewer that holds each take to the whole rubric of the review prompt, as a real model would
 * (render.yaml pairs LLM_PROVIDER=anthropic with VISUAL_PROVIDER=mock): a MockProvider placeholder,
 * the shot's words, its prompt and a "MOCK" footer printed on a gradient, shows stray text and not
 * the subject its prompt asks for, so it asks for another take, unless the request says the take
 * is a placeholder and how to judge one. Everything else is MockLlm.
 */
class RubricReviewerLlm implements LlmClient {
  readonly provider = "anthropic" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;
  readonly reviews: { toldPlaceholder: boolean; images: number }[] = [];

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.meta.agent !== "VISUAL_DIRECTOR" || request.meta.action !== "review") {
      return this.#mock.complete(request);
    }
    const blocks = blocksOf(request);
    const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    const images = blocks.filter((block) => block.type === "image").length;
    const toldPlaceholder =
      request.system.some((block) => block.text.includes("## Placeholder takes")) &&
      text.includes("It is a placeholder");
    this.reviews.push({ toldPlaceholder, images });
    const { shot } = request.meta.input as VisualReviewInput;
    const output: VisualReviewOutput = toldPlaceholder
      ? { verdict: "accept", score: 7, issues: [], revisedPrompt: null }
      : {
          verdict: "regenerate",
          score: 3,
          issues: [
            "Stray text and a MOCK footer are printed across the frame.",
            "The subject the prompt asks for isn't in the frame at all.",
          ],
          revisedPrompt: `${shot.prompt} No text or lettering anywhere in the frame.`,
        };
    return Promise.resolve({
      text: JSON.stringify(output),
      stopReason: "end_turn",
      refusal: null,
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: request.model,
      latencyMs: 1,
    });
  }
}

function waitForPostStatus(h: Harness, postId: string, status: string, timeoutMs = 30_000) {
  return h.waitFor(async () => {
    const post = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    return post.status === status ? post : null;
  }, timeoutMs);
}

describe("phase3.brief-to-visual", () => {
  it("(a) takes a chat brief to 12 approvable posts, each with reviewed placeholder visuals", async () => {
    const llm = new ReviewRecorder();
    const h = (harness = await startHarness({ clock: new FakeClock(NOW), llm }));
    expect(h.deps.config.PIPELINE_ACTIONS).toEqual(["write", "direct", "qa"]);
    expect(h.deps.visual).toBeInstanceOf(MockProvider);
    const db = testDb();
    const admin = await createUser({ role: "ADMIN", name: "Salah" });
    const client = await createClient({
      name: "Qahwa Co",
      bannedWords: ["cheap"],
      enabledPlatforms: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    });
    const cookie = await sessionCookieFor(admin, { now: h.clock.now() });
    const api = apiFor(h, cookie);

    const campaign = (await api<CampaignDto>("POST", "/v1/campaigns", { message: BRIEF })).body;
    const stream = await h.events({ cookie, threadId: campaign.threadId, lastEventId: "0" });
    await stream.waitFor(
      (event) =>
        event.type === "message.created" &&
        (event.payload as { message: ChatMessageDto }).message.kind === "CLARIFY",
    );
    await api<ChatMessageDto>("POST", `/v1/threads/${campaign.threadId}/messages`, {
      content: ANSWER,
    });
    const proposed = await stream.waitFor((event) => event.type === "plan.proposed");
    const { graphId } = proposed.payload as PlanProposedPayload;
    const plan = (await api<TaskGraphDto>("GET", `/v1/task-graphs/${graphId}`)).body;
    expect(plan.nodes.filter((node) => node.action === "direct")).toHaveLength(12);
    await api<TaskGraphDto>("POST", `/v1/task-graphs/${graphId}/approve`, {});

    const posts = await h.waitFor(async () => {
      const list = await api<PostListResponse>("GET", `/v1/posts?campaignId=${campaign.id}`);
      const items = list.body.items;
      return items.length === 12 && items.every((post) => post.status === "PENDING_APPROVAL")
        ? items
        : null;
    }, 90_000);
    expect(new Set(posts.map((post) => post.type))).toEqual(
      new Set(["REEL", "CAROUSEL", "STATIC"]),
    );

    let takes = 0;
    for (const post of posts) {
      // The card's visual: one READY current take per shot, in post order, served as a PNG.
      expect(post.currentAssets, post.ref).toHaveLength(shotCount(post));
      for (const thumb of post.currentAssets) {
        expect(thumb, post.ref).toMatchObject({
          status: "READY",
          version: 1,
          mimeType: "image/png",
          ...MASTER_SIZE,
        });
        await expectServedPng(h, post, thumb.url);
        takes += 1;
      }
      if (post.type === "REEL") {
        // MockProvider renders VIDEO shots as their poster frame.
        expect(post.currentAssets.every((thumb) => thumb.kind === "VIDEO")).toBe(true);
        expect(post.currentAssets.every((thumb) => thumb.posterUrl === thumb.url)).toBe(true);
      }
      expect(post.currentAssets.map((thumb) => thumb.shotId)).toEqual(
        post.currentAssets.map((_, i) => `s${i + 1}`),
      );
      // The approval round hashes the takes the reviewers see.
      const round = await db.approvalRequest.findFirstOrThrow({ where: { postId: post.id } });
      expect(round.contentHash).toBe(await currentContentHash(db, post.id));
    }

    // Every take was looked at: one review per take, each with the render attached.
    const assets = await db.asset.findMany({ where: { campaignId: campaign.id } });
    expect(assets).toHaveLength(takes);
    for (const asset of assets) {
      // The file lives in Storage under the take's key, and /files serves those very bytes.
      expect(asset.storageKey).not.toBeNull();
      const stored = await h.deps.storage.get(asset.storageKey!);
      expect(stored?.contentType).toBe("image/png");
      expect(stored?.body.length).toBe(asset.bytes);
      expect(h.deps.storage.publicUrl(asset.storageKey!)).toBe(asset.url);
      expect(AssetReview.parse(asset.review)).toMatchObject({ verdict: "accept", attempt: 1 });
      const params = AssetParams.parse(asset.params);
      expect(params).toMatchObject({ origin: "direct", instruction: null });
      expect(params.mockVideo).toBe(asset.kind === "VIDEO");
      expect(asset.rootAssetId).toBe(asset.id);
    }
    const reviewRuns = await db.agentRun.findMany({
      where: { campaignId: campaign.id, agent: "VISUAL_DIRECTOR", action: "review" },
    });
    expect(reviewRuns).toHaveLength(takes);
    // The Visual Director is told each MockProvider take is a placeholder, judged as one, and
    // which take is the shot's last as the loop is configured.
    expect(h.deps.config.MAX_VISUAL_REGENERATIONS).toBe(MAX_VISUAL_REGENERATIONS);
    for (const run of reviewRuns) {
      expect(VisualReviewInput.parse(run.inputSnapshot)).toMatchObject({
        render: { placeholder: true },
        attempt: 1,
        maxAttempts: 1 + h.deps.config.MAX_VISUAL_REGENERATIONS,
      });
    }
    // Each review was shown its own take (the stored render, downscaled), whatever the post type.
    await expectEachReviewSawItsTake(h, llm.shown);
    expect(new Set(llm.shown.map((review) => review.assetId))).toEqual(
      new Set(assets.map((asset) => asset.id)),
    );

    // The direct inputs: the post's copy, the provider's capabilities, no feedback.
    const directs = await db.agentTask.findMany({
      where: { graphId, action: "direct" },
      include: { post: true },
    });
    for (const task of directs) {
      expect(task.status).toBe("SUCCEEDED");
      const input = VisualDirectInput.parse(task.input);
      const copy = CopywriterOutput.parse(task.post!.copy);
      expect(input).toMatchObject({
        post: { ref: task.post!.ref, type: task.post!.type },
        copy: { script: copy.script, slides: copy.slides, onScreenText: copy.onScreenText },
        feedback: null,
        previousShots: null,
        capabilities: h.deps.visual.capabilities(),
      });
    }

    // The thread saw the Visual Director at work and sign off; the stream carried every take.
    const statuses = stream
      .ofType("agent.status")
      .map((event) => event.payload as AgentStatusPayload);
    expect(statuses.some((s) => s.agent === "VISUAL_DIRECTOR" && s.state === "waiting")).toBe(true);
    expect(statuses.some((s) => /Visual Director rendering \d+\/12/.test(s.line))).toBe(true);
    const signOff = await db.chatMessage.findFirstOrThrow({
      where: { threadId: campaign.threadId, agent: "VISUAL_DIRECTOR", kind: "TEXT" },
    });
    expect(signOff.content).toMatch(/^Visual Director ✓ 12\/12 — visuals rendered\./);
    const updates = stream.ofType("asset.updated").map((e) => e.payload as AssetUpdatedPayload);
    expect(new Set(updates.map((u) => u.assetId))).toEqual(new Set(assets.map((a) => a.id)));
    // QUEUED → RENDERING → READY, then READY again once reviewed.
    for (const asset of assets) {
      const mine = updates.filter((u) => u.assetId === asset.id).map((u) => u.status);
      expect(mine).toEqual(["QUEUED", "RENDERING", "READY", "READY"]);
    }

    // (d) The Vault finds them by campaign, by prompt and by shot id.
    const vault = (
      await api<AssetListResponse>("GET", `/v1/assets?campaignId=${campaign.id}&limit=100`)
    ).body;
    expect(vault.items).toHaveLength(takes);
    expect(vault.nextCursor).toBeNull();
    const byPrompt = (
      await api<AssetListResponse>("GET", `/v1/assets?q=${encodeURIComponent("CAROUSEL SLIDE")}`)
    ).body;
    expect(byPrompt.items.length).toBeGreaterThan(0);
    expect(byPrompt.items.every((item) => item.post?.type === "CAROUSEL")).toBe(true);
    const byShot = (
      await api<AssetListResponse>("GET", `/v1/assets?q=S2&campaignId=${campaign.id}&limit=100`)
    ).body;
    expect(byShot.items.length).toBe(posts.filter((post) => shotCount(post) >= 2).length);
    const byCampaign = (
      await api<AssetListResponse>("GET", `/v1/assets?q=${encodeURIComponent("ramadan")}&limit=5`)
    ).body;
    expect(byCampaign.items).toHaveLength(5);
    expect(byCampaign.nextCursor).toBe(byCampaign.items[4]!.id);
    const next = (
      await api<AssetListResponse>(
        "GET",
        `/v1/assets?q=ramadan&limit=100&cursor=${byCampaign.nextCursor}`,
      )
    ).body;
    expect(next.items).toHaveLength(takes - 5);
    expect(new Set([...byCampaign.items, ...next.items].map((a) => a.id)).size).toBe(takes);
    expect(client.id).toBe(vault.items[0]!.client.id);
  }, 150_000);

  it("(a) reaches approval with placeholder visuals under a reviewer that applies the whole rubric", async () => {
    const llm = new RubricReviewerLlm();
    const { h, postId } = await startOnePostPlan({ llm }, "CAROUSEL");
    const db = testDb();
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");

    // Each slide's first take passed: no regeneration, no escalation, one look per take.
    const takes = await db.asset.findMany({ where: { postId }, orderBy: { shotId: "asc" } });
    expect(takes.length).toBeGreaterThan(1);
    for (const take of takes) {
      expect(take).toMatchObject({
        status: "READY",
        isCurrent: true,
        version: 1,
        provider: "mock",
      });
      expect(AssetReview.parse(take.review)).toMatchObject({
        verdict: "accept",
        attempt: 1,
        issues: [],
      });
    }
    expect(llm.reviews).toEqual(takes.map(() => ({ toldPlaceholder: true, images: 1 })));
    const direct = await db.agentTask.findFirstOrThrow({ where: { postId, action: "direct" } });
    expect(direct.status).toBe("SUCCEEDED");
    expect(await db.chatMessage.count({ where: { kind: "ESCALATION" } })).toBe(0);
    const round = await db.approvalRequest.findFirstOrThrow({ where: { postId, round: 1 } });
    expect(round).toMatchObject({ status: "PENDING" });
    expect(round.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("(b) a Vault regenerate makes v2 from the take's original context and reopens approval", async () => {
    const { h, seeded, api, postId } = await startOnePostPlan({}, "CAROUSEL");
    const db = testDb();
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const post = (await api<PostDto>("GET", `/v1/posts/${postId}`)).body;
    const [first, target, ...others] = post.currentAssets;
    expect(target).toBeDefined();
    const before = await db.asset.findUniqueOrThrow({ where: { id: target!.id } });
    const shot = AssetParams.parse(before.params).shot!;
    const roundOne = await db.approvalRequest.findFirstOrThrow({ where: { postId, round: 1 } });

    const regenerated = await api<AssetDto>("POST", `/v1/assets/${target!.id}/regenerate`, {
      instruction: INSTRUCTION,
    });
    expect(regenerated.body).toMatchObject({
      version: 2,
      status: "QUEUED",
      isCurrent: false,
      parentAssetId: target!.id,
      rootAssetId: target!.id,
      shotId: target!.shotId,
      slideIndex: target!.slideIndex,
      createdBy: { id: seeded.admin.id },
      params: { origin: "vault", instruction: INSTRUCTION },
    });
    const v2 = regenerated.body;

    // The post goes back through the Visual Director and QA into round 2.
    const revisedPost = await h.waitFor(async () => {
      const round = await db.approvalRequest.findFirst({ where: { postId, round: 2 } });
      return round ? db.post.findUniqueOrThrow({ where: { id: postId } }) : null;
    });
    expect(revisedPost).toMatchObject({ status: "PENDING_APPROVAL", revision: 1 });
    expect(
      (await db.approvalRequest.findUniqueOrThrow({ where: { id: roundOne.id } })).status,
    ).toBe("CANCELLED");

    const detail = (await api<AssetDetailDto>("GET", `/v1/assets/${v2.id}`)).body;
    expect(detail).toMatchObject({ status: "READY", isCurrent: true, version: 2 });
    expect(detail.lineage.rootAssetId).toBe(target!.id);
    expect(detail.lineage.currentAssetId).toBe(v2.id);
    expect(detail.lineage.versions.map((v) => [v.version, v.isCurrent, v.status])).toEqual([
      [1, false, "READY"],
      [2, true, "READY"],
    ]);
    expect(detail.review).toMatchObject({ verdict: "accept" });
    expect(detail.prompt).not.toBe(before.prompt);

    // The Visual Director got its original context back, the instruction byte for byte.
    const direct = await db.agentTask.findFirstOrThrow({
      where: { postId, action: "direct", revision: 1 },
    });
    expect(direct).toMatchObject({
      status: "SUCCEEDED",
      nodeKey: expect.stringMatching(/\.r1$/) as unknown,
    });
    expect(direct.feedback).toEqual({ verbatim: INSTRUCTION, source: "HUMAN", decisionId: null });
    const run = await db.agentRun.findFirstOrThrow({
      where: { taskId: direct.id, agent: "VISUAL_DIRECTOR", action: "direct", outcome: "OK" },
    });
    const snapshot = VisualDirectInput.parse(run.inputSnapshot);
    expect(Buffer.from(snapshot.feedback!.verbatim)).toEqual(Buffer.from(INSTRUCTION));
    expect(snapshot.feedback).toEqual({ verbatim: INSTRUCTION, source: "HUMAN", decisionId: null });
    expect(snapshot.previousShots).toEqual([shot]);
    const copy = CopywriterOutput.parse(revisedPost.copy);
    expect(snapshot.copy).toEqual({
      script: copy.script,
      slides: copy.slides,
      onScreenText: copy.onScreenText,
    });
    expect(snapshot.brand.clientId).toBe(seeded.client.id);

    // Only that shot changed; the new round approves exactly what the post shows now.
    const after = (await api<PostDto>("GET", `/v1/posts/${postId}`)).body;
    expect(after.currentAssets.map((thumb) => thumb.id)).toEqual(
      [first!, target!, ...others].map((thumb) => (thumb.id === target!.id ? v2.id : thumb.id)),
    );
    const roundTwo = await db.approvalRequest.findFirstOrThrow({ where: { postId, round: 2 } });
    expect(roundTwo.contentHash).not.toBe(roundOne.contentHash);
    expect(roundTwo.contentHash).toBe(await currentContentHash(db, postId));
    await expectServedPng(h, after, detail.url);

    // Only current versions by default; every version on request.
    const listed = (await api<AssetListResponse>("GET", `/v1/assets?postId=${postId}`)).body;
    expect(listed.items.map((item) => item.id)).not.toContain(target!.id);
    const all = (
      await api<AssetListResponse>("GET", `/v1/assets?postId=${postId}&allVersions=true`)
    ).body;
    expect(all.items.map((item) => item.id)).toEqual(expect.arrayContaining([target!.id, v2.id]));
  }, 60_000);

  it("(b) a Vault regenerate on an approved post reopens its approval on the new take", async () => {
    const { h, api, postId } = await startOnePostPlan({}, "STATIC");
    const db = testDb();
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const roundOne = await db.approvalRequest.findFirstOrThrow({ where: { postId, round: 1 } });
    await api<ApprovalRequestDto>("POST", `/v1/approvals/${roundOne.id}/decision`, {
      decision: "APPROVE",
    });
    expect(await db.post.findUniqueOrThrow({ where: { id: postId } })).toMatchObject({
      status: "APPROVED",
    });
    const [v1] = (await api<PostDto>("GET", `/v1/posts/${postId}`)).body.currentAssets;
    const shot = AssetParams.parse(
      (await db.asset.findUniqueOrThrow({ where: { id: v1!.id } })).params,
    ).shot;

    const { body: v2 } = await api<AssetDto>("POST", `/v1/assets/${v1!.id}/regenerate`, {
      instruction: INSTRUCTION,
    });
    expect(v2).toMatchObject({ version: 2, parentAssetId: v1!.id, rootAssetId: v1!.id });
    // The approval no longer stands: the post is back in the loop at once (CHANGES_REQUESTED,
    // then on through the Visual Director and QA as fast as the mocks go).
    const reopened = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(reopened).toMatchObject({ approvedAt: null, revision: 1 });
    expect(reopened.status).not.toBe("APPROVED");
    expect(
      (await db.approvalRequest.findUniqueOrThrow({ where: { id: roundOne.id } })).status,
    ).toBe("CANCELLED");

    const roundTwo = await h.waitFor(() =>
      db.approvalRequest.findFirst({ where: { postId, round: 2 } }),
    );
    expect(roundTwo.status).toBe("PENDING");
    expect(await db.post.findUniqueOrThrow({ where: { id: postId } })).toMatchObject({
      status: "PENDING_APPROVAL",
    });
    const current = await db.asset.findMany({ where: { postId, isCurrent: true } });
    expect(current.map((take) => take.id)).toEqual([v2.id]);
    expect(roundTwo.contentHash).toBe(await currentContentHash(db, postId));
    expect(roundTwo.contentHash).not.toBe(roundOne.contentHash);

    const direct = await db.agentTask.findFirstOrThrow({
      where: { postId, action: "direct", revision: 1 },
    });
    const run = await db.agentRun.findFirstOrThrow({
      where: { taskId: direct.id, agent: "VISUAL_DIRECTOR", action: "direct", outcome: "OK" },
    });
    expect(VisualDirectInput.parse(run.inputSnapshot)).toMatchObject({
      feedback: { verbatim: INSTRUCTION, source: "HUMAN", decisionId: null },
      previousShots: [shot],
    });
  }, 60_000);

  it("(b) refuses a regenerate while the shot is still in the loop or the post is being worked on", async () => {
    const { h, api, postId } = await startOnePostPlan({}, "STATIC");
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const [take] = (await api<PostDto>("GET", `/v1/posts/${postId}`)).body.currentAssets;
    await api<AssetDto>("POST", `/v1/assets/${take!.id}/regenerate`, { instruction: null });

    // The revision is under way: a second regenerate of the same shot waits for it.
    const again = await h.app.inject({
      method: "POST",
      url: `/v1/assets/${take!.id}/regenerate`,
      headers: browserHeaders(await sessionCookieFor(await createUser({ role: "EDITOR" }))),
      payload: { instruction: "Warmer" },
    });
    expect(again.statusCode).toBe(409);

    const done = await h.waitFor(() =>
      testDb().approvalRequest.findFirst({ where: { postId, round: 2 } }),
    );
    expect(done.status).toBe("PENDING");
    // Without an instruction the Visual Director re-rolls the same shot: no feedback to apply.
    const direct = await testDb().agentTask.findFirstOrThrow({
      where: { postId, action: "direct", revision: 1 },
    });
    expect(direct.feedback).toBeNull();
    expect(VisualDirectInput.parse(direct.input).feedback).toBeNull();
    const missing = await h.app.inject({
      method: "POST",
      url: "/v1/assets/missing-asset/regenerate",
      headers: browserHeaders(await sessionCookieFor(await createUser({ role: "EDITOR" }))),
      payload: { instruction: null },
    });
    expect(missing.statusCode).toBe(404);
  }, 60_000);

  it("(c) weak*3 regenerates a shot twice as new versions, then escalates for accept_best", async () => {
    const faults = "VISUAL_DIRECTOR.review:weak*3";
    // The env's faults, in a MockLlm the recorder can watch.
    const llm = new ReviewRecorder(new MockLlm({ faults }));
    const { h, api, postId } = await startOnePostPlan(
      { env: { MOCK_LLM_FAULTS: faults }, llm },
      "STATIC",
    );
    const db = testDb();
    const direct = await h.waitFor(async () => {
      const task = await db.agentTask.findFirst({ where: { postId, action: "direct" } });
      return task?.status === "ESCALATED" ? task : null;
    });

    const takes = await db.asset.findMany({ where: { postId }, orderBy: { version: "asc" } });
    expect(takes.map((t) => [t.version, t.regenCount, t.status, t.isCurrent])).toEqual([
      [1, 0, "REJECTED", false],
      [2, 1, "REJECTED", false],
      [3, 2, "READY", true],
    ]);
    // The limit the loop ran with, not just the shared default.
    expect(h.deps.config.MAX_VISUAL_REGENERATIONS).toBe(2);
    expect(MAX_VISUAL_REGENERATIONS).toBe(2);
    const [v1, v2, v3] = takes;
    // Each take's review saw that take's own render, not its parent's: every version looks
    // different, and the reviewer was told which take was the last.
    const images = await expectEachReviewSawItsTake(h, llm.shown);
    expect([...images.keys()]).toEqual(takes.map((take) => take.id));
    expect(llm.shown.map((review) => [review.attempt, review.maxAttempts])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(llm.shown[0]!.text).toContain("Review take 1 of shot s1 (take 3 is the last");
    expect(llm.shown[2]!.text).toContain(
      "Review take 3 of shot s1 (the last take before the team decides)",
    );
    expect(v2!.parentAssetId).toBe(v1!.id);
    expect(v3!.parentAssetId).toBe(v2!.id);
    expect(takes.every((t) => t.rootAssetId === v1!.id)).toBe(true);
    const reviews = takes.map((t) => AssetReview.parse(t.review));
    expect(reviews.map((r) => [r.verdict, r.attempt])).toEqual([
      ["regenerate", 1],
      ["regenerate", 2],
      ["regenerate", 3],
    ]);
    // Each take renders the previous review's revised prompt.
    expect(v2!.prompt).toBe(reviews[0]!.revisedPrompt);
    expect(v3!.prompt).toBe(reviews[1]!.revisedPrompt);
    expect(takes.map((t) => AssetParams.parse(t.params).origin)).toEqual([
      "direct",
      "review",
      "review",
    ]);

    const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post).toMatchObject({ status: "VISUALIZING", needsAttention: true });
    const escalation = await h.waitFor(() =>
      db.chatMessage.findFirst({ where: { kind: "ESCALATION" } }),
    );
    // The Visual Director gave up on the shot itself, so it signs the hand-off.
    expect(escalation.agent).toBe("VISUAL_DIRECTOR");
    expect(escalation.content).toContain("take 3 of s1 is still weak after 2 regenerations");
    expect(escalation.content).toContain("accept the best take or retry it from the task list");
    expect(escalation.payload).toMatchObject({ taskId: direct.id, reason: "WEAK_TAKES" });
    const alert = await h.waitFor(() =>
      db.realtimeEvent.findFirst({
        where: { type: "alert", payload: { path: ["kind"], equals: "escalated" } },
      }),
    );
    expect(alert.payload as AlertPayload).toMatchObject({ entityId: direct.id });

    // accept_best keeps the best-scored take, finishes the task and lets QA open the round.
    const resolved = await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, {
      action: "accept_best",
    });
    expect(resolved.body.status).toBe("SUCCEEDED");
    const best = [...takes].sort(
      (a, b) =>
        AssetReview.parse(b.review).score - AssetReview.parse(a.review).score ||
        b.version - a.version,
    )[0]!;
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const current = await db.asset.findMany({ where: { postId, isCurrent: true } });
    expect(current.map((t) => [t.id, t.status])).toEqual([[best.id, "READY"]]);
    const settled = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(settled.needsAttention).toBe(false);
    const round = await db.approvalRequest.findFirstOrThrow({ where: { postId } });
    expect(round.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("(c) MAX_VISUAL_REGENERATIONS=1 regenerates a weak take once, then escalates; the review knows", async () => {
    const faults = "VISUAL_DIRECTOR.review:weak*2";
    const llm = new ReviewRecorder(new MockLlm({ faults }));
    const { h, api, postId } = await startOnePostPlan(
      { env: { MOCK_LLM_FAULTS: faults, MAX_VISUAL_REGENERATIONS: "1" }, llm },
      "STATIC",
    );
    expect(h.deps.config.MAX_VISUAL_REGENERATIONS).toBe(1);
    const db = testDb();
    const direct = await h.waitFor(async () => {
      const task = await db.agentTask.findFirst({ where: { postId, action: "direct" } });
      return task?.status === "ESCALATED" ? task : null;
    });

    // One regeneration, then the team decides: no third take.
    const takes = await db.asset.findMany({ where: { postId }, orderBy: { version: "asc" } });
    expect(takes.map((t) => [t.version, t.regenCount, t.status, t.isCurrent])).toEqual([
      [1, 0, "REJECTED", false],
      [2, 1, "READY", true],
    ]);
    expect(takes.map((t) => AssetReview.parse(t.review).verdict)).toEqual([
      "regenerate",
      "regenerate",
    ]);
    // The prompt and the loop agree: take 2 was reviewed as the last one.
    expect(llm.shown.map((review) => [review.attempt, review.maxAttempts])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(llm.shown[0]!.text).toContain("Review take 1 of shot s1 (take 2 is the last");
    expect(llm.shown[1]!.text).toContain(
      "Review take 2 of shot s1 (the last take before the team decides)",
    );
    await expectEachReviewSawItsTake(h, llm.shown);
    const escalation = await h.waitFor(() =>
      db.chatMessage.findFirst({ where: { kind: "ESCALATION" } }),
    );
    expect(escalation.content).toContain("take 2 of s1 is still weak after 1 regeneration");
    expect(escalation.payload).toMatchObject({ taskId: direct.id, reason: "WEAK_TAKES" });

    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, {
      action: "accept_best",
    });
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
  }, 60_000);

  it("(c) a retry after weak takes re-plans the shot as the next version and runs clean", async () => {
    const { h, api, postId } = await startOnePostPlan(
      { env: { MOCK_LLM_FAULTS: "VISUAL_DIRECTOR.review:weak*3" } },
      "STATIC",
    );
    const db = testDb();
    const direct = await h.waitFor(async () => {
      const task = await db.agentTask.findFirst({ where: { postId, action: "direct" } });
      return task?.status === "ESCALATED" ? task : null;
    });
    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, { action: "retry" });
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");

    const takes = await db.asset.findMany({ where: { postId }, orderBy: { version: "asc" } });
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "REJECTED", false],
      [2, "REJECTED", false],
      [3, "REJECTED", false],
      [4, "READY", true],
    ]);
    expect(AssetParams.parse(takes[3]!.params)).toMatchObject({
      origin: "direct",
      taskId: direct.id,
    });
    expect(takes[3]).toMatchObject({ regenCount: 0, parentAssetId: takes[2]!.id });
    expect(AssetReview.parse(takes[3]!.review).verdict).toBe("accept");
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).needsAttention).toBe(false);
  }, 60_000);
});
