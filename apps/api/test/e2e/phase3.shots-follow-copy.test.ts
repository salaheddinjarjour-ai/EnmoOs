import { MockLlm, type LlmClient, type LlmRequest, type LlmResponse } from "@enmo/agents";
import {
  AssetParams,
  CopywriterOutput,
  type ApprovalListResponse,
  type ApprovalRequestDto,
  type AssetDto,
  type CopywriterInput,
  type PostDto,
  type Script,
  type TaskGraphDto,
} from "@enmo/shared";
import { afterEach, describe, expect, it } from "vitest";
import { currentContentHash } from "../../src/orchestrator/approval-round";
import { browserHeaders } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createAsset, createClient, createUser } from "../helpers/factories";
import { seedCampaign } from "../helpers/route-fixtures";
import { seedProposedPlan, startHarness, type Harness } from "../helpers/harness";

/*
 * A post's takes follow its copy: one per script scene or carousel slide (DESIGN §C "Visual
 * Director, direct"). On the Phase 3 pipeline (write → direct → qa):
 *   - a COPY revision whose rewrite adds or drops a slide or scene gets direct.rN spliced in after
 *     its write, so the Visual Director re-plans before QA and the next round sees one take per
 *     place; a rewrite of the same shape keeps the takes;
 *   - a human copy edit that adds a slide goes back through the Visual Director and QA instead of
 *     reopening approval on takes that no longer fit (and is refused outside any plan);
 *   - QA's own check ("shots") catches takes that don't fit the copy all the same (a copy changed
 *     behind the pipeline's back): the post goes to the Visual Director, and once QA is out of
 *     revisions it escalates instead of opening a round.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** How many places the copy has: its slides, or its script's scenes. */
function places(copy: CopywriterOutput): number {
  return copy.slides?.length ?? copy.script?.scenes.length ?? 1;
}

/** `copy` with `count` slides or scenes: new ones appended at the end, extra ones dropped. */
function reshape(copy: CopywriterOutput, count: number): CopywriterOutput {
  if (copy.slides) {
    const slides = Array.from({ length: count }, (_, index) => ({
      index,
      headline: copy.slides![index]?.headline ?? `One more reason ${index}`,
      body: copy.slides![index]?.body ?? "Slow evenings, a tall glass, nowhere to be.",
    }));
    return { ...copy, slides };
  }
  if (copy.script) {
    const scenes: Script["scenes"] = [];
    let start = 0;
    for (let index = 0; index < count; index++) {
      const scene = copy.script.scenes[index] ?? {
        index,
        startSec: 0,
        durationSec: 3,
        voiceover: "One more pour, slower this time.",
        overlayText: "Slower",
        visualNote: "The glass filling, backlit.",
      };
      scenes.push({ ...scene, index, startSec: start });
      start = Math.round((start + scene.durationSec) * 10) / 10;
    }
    return { ...copy, script: { ...copy.script, scenes, totalDurationSec: start } };
  }
  throw new Error("Only carousels and scripts have places to add or drop");
}

/** MockLlm, except that a Copywriter revision has `delta` more places than the copy it revises. */
class ReshapingCopyLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;

  constructor(private readonly delta: number) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.#mock.complete(request);
    const input = request.meta.input as CopywriterInput;
    if (request.meta.agent !== "COPYWRITER" || !input.revision) return response;
    const revised = CopywriterOutput.parse(JSON.parse(response.text));
    const count = places(input.revision.previous) + this.delta;
    return { ...response, text: JSON.stringify(reshape(revised, count)) };
  }
}

/** MockLlm, plus a hook the test runs once, as the first Visual Director review starts. */
class HookedReviewLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;
  onFirstReview: (() => Promise<void>) | null = null;

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.meta.agent === "VISUAL_DIRECTOR" && request.meta.action === "review") {
      const hook = this.onFirstReview;
      this.onFirstReview = null;
      await hook?.();
    }
    return this.#mock.complete(request);
  }
}

/** Adds a slide to the post's copy behind the pipeline's back (a hand edit in the database). */
async function addSlideBehindTheBack(postId: string): Promise<void> {
  const db = testDb();
  const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
  const copy = CopywriterOutput.parse(post.copy);
  await db.post.update({ where: { id: postId }, data: { copy: reshape(copy, places(copy) + 1) } });
}

function apiFor(h: Harness, cookie: string) {
  const headers = browserHeaders(cookie);
  return async <T>(method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
    const response = await h.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    if (response.statusCode >= 300) {
      throw new Error(`${method} ${url} → ${response.statusCode}: ${response.body}`);
    }
    return response.json<T>();
  };
}

async function startPost(llm: LlmClient | undefined, type: "CAROUSEL" | "REEL", env = {}) {
  const h = (harness = await startHarness({ ...(llm ? { llm } : {}), env }));
  const seeded = await seedProposedPlan(h, { postCount: 1, type });
  const api = apiFor(h, await sessionCookieFor(seeded.admin, { now: h.clock.now() }));
  await api<TaskGraphDto>("POST", `/v1/task-graphs/${seeded.graphId}/approve`, {});
  const post = await testDb().post.findFirstOrThrow({ where: { campaignId: seeded.campaignId } });
  return { h, api, seeded, postId: post.id };
}

function waitForRound(h: Harness, postId: string, round: number) {
  return h.waitFor(
    () => testDb().approvalRequest.findFirst({ where: { postId, round, status: "PENDING" } }),
    30_000,
  );
}

/** The places the post's current takes fill, and the places its copy has, both sorted. */
async function takesAndCopy(postId: string) {
  const db = testDb();
  const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
  const copy = CopywriterOutput.parse(post.copy);
  const current = await db.asset.findMany({ where: { postId, role: "SHOT", isCurrent: true } });
  const placeOf = (take: { sceneIndex: number | null; params: unknown }) =>
    take.sceneIndex ?? AssetParams.parse(take.params).shot!.slideIndex!;
  return {
    copy,
    current,
    filled: current.map(placeOf).sort((a, b) => a - b),
    wanted: (copy.slides?.map((s) => s.index) ?? copy.script!.scenes.map((s) => s.index)).sort(
      (a, b) => a - b,
    ),
  };
}

async function requestCopyChanges(api: ReturnType<typeof apiFor>, feedback: string) {
  const [request] = (await api<ApprovalListResponse>("GET", "/v1/approvals")).items;
  await api<ApprovalRequestDto>("POST", `/v1/approvals/${request!.id}/decision`, {
    decision: "REQUEST_CHANGES",
    feedback,
    target: "COPY",
  });
}

describe("phase3: the takes follow the copy", () => {
  it("re-plans the shots when a COPY revision adds a slide, before QA opens the next round", async () => {
    const { h, api, postId } = await startPost(new ReshapingCopyLlm(1), "CAROUSEL");
    const db = testDb();
    await waitForRound(h, postId, 1);
    const before = await takesAndCopy(postId);
    expect(before.filled).toEqual(before.wanted);

    await requestCopyChanges(api, "Add a slide about the late-night pour.");
    const roundTwo = await waitForRound(h, postId, 2);

    const after = await takesAndCopy(postId);
    expect(after.wanted).toHaveLength(before.wanted.length + 1);
    // One READY, accepted take per slide of the new copy; nothing left over.
    expect(after.filled).toEqual(after.wanted);
    expect(after.current.every((take) => take.status === "READY")).toBe(true);

    // write.r1 → direct.r1 (spliced in, no feedback: the note was the Copywriter's) → qa.r1.
    const planned = await db.agentTask.findMany({ where: { postId, revision: 0 } });
    const revision = await db.agentTask.findMany({
      where: { postId, revision: 1 },
      orderBy: { createdAt: "asc" },
    });
    expect(revision.map((task) => [task.action, task.status])).toEqual([
      ["write", "SUCCEEDED"],
      ["qa", "SUCCEEDED"],
      ["direct", "SUCCEEDED"],
    ]);
    const [write, qa, direct] = revision;
    expect(direct!.nodeKey).toBe(`${planned.find((t) => t.action === "direct")!.nodeKey}.r1`);
    expect(direct!.dependsOn).toEqual([write!.id]);
    expect(qa!.dependsOn).toEqual([direct!.id]);
    expect(direct!.feedback).toBeNull();

    // Slides still there continue their lineage as v2; the new slide starts one.
    for (const take of after.current) {
      const slide = AssetParams.parse(take.params).shot!.slideIndex!;
      const previous = before.current.find(
        (old) => AssetParams.parse(old.params).shot!.slideIndex === slide,
      );
      expect(take).toMatchObject({
        version: previous ? 2 : 1,
        parentAssetId: previous?.id ?? null,
      });
      expect(AssetParams.parse(take.params).taskId).toBe(direct!.id);
    }
    expect(roundTwo.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("re-plans the shots when a COPY revision drops a scene of a reel", async () => {
    const { h, api, postId } = await startPost(new ReshapingCopyLlm(-1), "REEL");
    const db = testDb();
    await waitForRound(h, postId, 1);
    const before = await takesAndCopy(postId);

    await requestCopyChanges(api, "Tighter: lose the last scene.");
    const roundTwo = await waitForRound(h, postId, 2);

    const after = await takesAndCopy(postId);
    expect(after.wanted).toHaveLength(before.wanted.length - 1);
    expect(after.filled).toEqual(after.wanted);
    // The dropped scene's take is in the Vault, no longer on the post.
    const dropped = before.current.find((take) => take.sceneIndex === before.wanted.at(-1));
    expect(await db.asset.findUniqueOrThrow({ where: { id: dropped!.id } })).toMatchObject({
      isCurrent: false,
      status: "READY",
    });
    const actions = await db.agentTask.findMany({ where: { postId, revision: 1 } });
    expect(actions.map((task) => task.action).sort()).toEqual(["direct", "qa", "write"]);
    const post = (await api<PostDto>("GET", `/v1/posts/${postId}`)).currentAssets;
    expect(post.map((thumb) => thumb.sceneIndex)).toEqual(after.wanted);
    expect(roundTwo.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("keeps the takes when a COPY revision keeps the slides", async () => {
    const { h, api, postId } = await startPost(new ReshapingCopyLlm(0), "CAROUSEL");
    const db = testDb();
    await waitForRound(h, postId, 1);
    const before = await takesAndCopy(postId);

    await requestCopyChanges(api, "Warmer words, same slides.");
    await waitForRound(h, postId, 2);

    const after = await takesAndCopy(postId);
    expect(after.current.map((take) => take.id).sort()).toEqual(
      before.current.map((take) => take.id).sort(),
    );
    const actions = await db.agentTask.findMany({ where: { postId, revision: 1 } });
    expect(actions.map((task) => task.action).sort()).toEqual(["qa", "write"]);
  }, 60_000);

  it("sends a copy edit that adds a slide back through the Visual Director", async () => {
    const { h, api, postId } = await startPost(undefined, "CAROUSEL");
    const db = testDb();
    await waitForRound(h, postId, 1);
    const before = await takesAndCopy(postId);

    // An edit that keeps the slides reopens approval on the same takes at once.
    const reworded = { ...before.copy, altText: "Iced coffee at dusk, condensation on the glass." };
    const kept = await api<PostDto>("PATCH", `/v1/posts/${postId}/copy`, { copy: reworded });
    expect(kept).toMatchObject({ status: "PENDING_APPROVAL", humanEditCount: 1 });
    expect(kept.currentApproval).toMatchObject({ round: 2 });
    expect(kept.currentAssets.map((thumb) => thumb.id).sort()).toEqual(
      before.current.map((take) => take.id).sort(),
    );

    // One that adds a slide: no round opens on the old takes; the Visual Director re-plans.
    const longer = reshape(reworded, before.wanted.length + 1);
    const edited = await api<PostDto>("PATCH", `/v1/posts/${postId}/copy`, { copy: longer });
    expect(edited).toMatchObject({ humanEditCount: 2, revision: 1 });
    expect(edited.status).not.toBe("PENDING_APPROVAL");
    expect(
      await db.approvalRequest.findMany({
        where: { postId },
        orderBy: { round: "asc" },
        select: { round: true, status: true },
      }),
    ).toEqual([
      { round: 1, status: "CANCELLED" },
      { round: 2, status: "CANCELLED" },
    ]);

    const roundThree = await waitForRound(h, postId, 3);
    const after = await takesAndCopy(postId);
    // The human's words stand; the takes now fill every slide of them.
    expect(after.copy).toEqual(longer);
    expect(after.filled).toEqual(after.wanted);
    const revision = await db.agentTask.findMany({
      where: { postId, revision: 1 },
      orderBy: { createdAt: "asc" },
    });
    expect(revision.map((task) => [task.action, task.status, task.feedback])).toEqual([
      ["direct", "SUCCEEDED", null],
      ["qa", "SUCCEEDED", null],
    ]);
    expect(roundThree.contentHash).toBe(await currentContentHash(db, postId));
    expect(await db.post.findUniqueOrThrow({ where: { id: postId } })).toMatchObject({
      status: "PENDING_APPROVAL",
      humanEditCount: 2,
    });
  }, 60_000);

  it("keeps one take per scene when a dropped scene comes back: its old takes can't be regenerated", async () => {
    const { h, api, postId } = await startPost(undefined, "REEL");
    const db = testDb();
    await waitForRound(h, postId, 1);
    const before = await takesAndCopy(postId);
    const last = before.wanted.at(-1)!;
    const dropped = before.current.find((take) => take.sceneIndex === last)!;

    // An edit drops the last scene, and the next one brings a scene back in its place.
    await api<PostDto>("PATCH", `/v1/posts/${postId}/copy`, {
      copy: reshape(before.copy, before.wanted.length - 1),
    });
    await waitForRound(h, postId, 2);
    const shorter = await takesAndCopy(postId);
    await api<PostDto>("PATCH", `/v1/posts/${postId}/copy`, {
      copy: reshape(shorter.copy, before.wanted.length),
    });
    const roundThree = await waitForRound(h, postId, 3);

    // The scene came back as a lineage of its own; the dropped scene's lineage has no take on show.
    const after = await takesAndCopy(postId);
    expect(after.filled).toEqual(before.wanted);
    const readded = after.current.find((take) => take.sceneIndex === last)!;
    expect(readded).toMatchObject({ version: 1, parentAssetId: null });
    expect(readded.rootAssetId).not.toBe(dropped.rootAssetId);
    expect(await db.asset.findUniqueOrThrow({ where: { id: dropped.id } })).toMatchObject({
      isCurrent: false,
      status: "READY",
    });

    // "Show all versions" still lists the old take, but regenerating it would put a second take
    // of the scene on the post: refused, and nothing changes.
    const assets = await db.asset.count();
    await expect(
      api<AssetDto>("POST", `/v1/assets/${dropped.id}/regenerate`, { instruction: "Warmer" }),
    ).rejects.toThrow(/→ 409: .*The post shows another take of this scene now/);
    expect(await db.asset.count()).toBe(assets);
    expect(
      (await db.approvalRequest.findUniqueOrThrow({ where: { id: roundThree.id } })).status,
    ).toBe("PENDING");

    // The scene's take on show regenerates as usual, and the scene keeps exactly one take.
    const v2 = await api<AssetDto>("POST", `/v1/assets/${readded.id}/regenerate`, {
      instruction: "Warmer",
    });
    expect(v2).toMatchObject({ version: 2, parentAssetId: readded.id });
    await waitForRound(h, postId, 4);
    const final = await takesAndCopy(postId);
    expect(final.filled).toEqual(final.wanted);
    expect(final.current.find((take) => take.sceneIndex === last)?.id).toBe(v2.id);
  }, 90_000);

  it("refuses an edit that adds a slide to a post outside any plan", async () => {
    const h = (harness = await startHarness({}));
    const db = testDb();
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM"] });
    const { campaign } = await seedCampaign({ createdBy: admin, client, status: "PRODUCING" });
    const caption = "Three reasons to slow down tonight.";
    const copy: CopywriterOutput = {
      caption,
      hashtags: ["#IcedLatte"],
      cta: "Order tonight",
      altText: "An iced latte at dusk",
      platformCaptions: [{ platform: "INSTAGRAM", caption }],
      script: null,
      slides: [0, 1, 2].map((index) => ({ index, headline: `Reason ${index + 1}`, body: "" })),
      onScreenText: null,
    };
    const post = await db.post.create({
      data: {
        campaignId: campaign.id,
        clientId: client.id,
        ref: "p1",
        type: "CAROUSEL",
        platforms: ["INSTAGRAM"],
        status: "PENDING_APPROVAL",
        copy,
      },
    });
    for (const index of [0, 1, 2]) {
      await createAsset({
        client,
        campaignId: campaign.id,
        postId: post.id,
        shotId: `s${index + 1}`,
        slideIndex: index,
      });
    }
    await db.approvalRequest.create({
      data: {
        postId: post.id,
        round: 1,
        chain: client.approvalChain ?? {},
        contentHash: await currentContentHash(db, post.id),
      },
    });
    const headers = browserHeaders(await sessionCookieFor(admin, { now: h.clock.now() }));

    const refused = await h.app.inject({
      method: "PATCH",
      url: `/v1/posts/${post.id}/copy`,
      headers,
      payload: { copy: reshape(copy, 4) },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(
      /adds or drops a scene or slide/,
    );
    expect(await db.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({
      copy,
      humanEditCount: 0,
    });

    const reworded = await h.app.inject({
      method: "PATCH",
      url: `/v1/posts/${post.id}/copy`,
      headers,
      payload: { copy: { ...copy, altText: "An iced latte, backlit" } },
    });
    expect(reworded.statusCode).toBe(200);
  }, 60_000);

  it("has QA send takes that don't fit the copy back to the Visual Director", async () => {
    const llm = new HookedReviewLlm();
    const { h, postId } = await startPost(llm, "CAROUSEL");
    const db = testDb();
    // The copy gains a slide while the takes are under review: the takes the direct task
    // finishes with no longer fit it.
    llm.onFirstReview = () => addSlideBehindTheBack(postId);

    const round = await waitForRound(h, postId, 1);
    const qa = await db.agentTask.findFirstOrThrow({
      where: { postId, action: "qa", revision: 0 },
    });
    // QA's check caught it and sent the post to the Visual Director before any round opened.
    const input = qa.input as { automatedChecks: { name: string; passed: boolean }[] };
    expect(input.automatedChecks).toContainEqual(
      expect.objectContaining({ name: "shots", passed: false }),
    );
    const revision = await db.agentTask.findMany({
      where: { postId, revision: 1 },
      orderBy: { createdAt: "asc" },
    });
    expect(revision.map((task) => task.action)).toEqual(["direct", "qa"]);
    expect(revision[0]!.feedback).toMatchObject({ source: "QA" });
    const after = await takesAndCopy(postId);
    expect(after.filled).toEqual(after.wanted);
    expect(round.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("never opens a round on takes that don't fit the copy once QA is out of revisions", async () => {
    const llm = new HookedReviewLlm();
    const { h, postId } = await startPost(llm, "CAROUSEL", { MAX_QA_REVISIONS: "0" });
    const db = testDb();
    llm.onFirstReview = () => addSlideBehindTheBack(postId);

    const qa = await h.waitFor(async () => {
      const task = await db.agentTask.findFirst({ where: { postId, action: "qa" } });
      return task?.status === "ESCALATED" ? task : null;
    }, 30_000);
    expect(qa.error).toMatch(/can't send p1 for approval: its takes don't match the copy/);
    expect(await db.approvalRequest.count({ where: { postId } })).toBe(0);
    const message = await db.chatMessage.findFirstOrThrow({ where: { kind: "ESCALATION" } });
    expect(message.payload).toMatchObject({ taskId: qa.id, reason: "SHOTS_OUT_OF_STEP" });
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).needsAttention).toBe(true);
  }, 60_000);
});
