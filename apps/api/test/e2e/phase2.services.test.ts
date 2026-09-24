import {
  COPY_BANNED_SCAN_IGNORE,
  MockLlm,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from "@enmo/agents";
import {
  AgentTaskDto,
  ApprovalRequestDto,
  CampaignDto,
  ChatMessageDto,
  CopywriterOutput as CopywriterOutputSchema,
  ManagerPlanOutput,
  PostDto,
  scanForBannedWords,
  TaskGraphDto,
  type AlertPayload,
  type ApprovalChain,
  type Brief,
  type CopywriterOutput,
  type ManagerIntakeInput,
  type ManagerIntakeOutput,
  type ManagerPlanInput,
} from "@enmo/shared";
import { afterEach, describe, expect, it } from "vitest";
import { managerIntakeProcessor } from "../../src/jobs/processors/manager-intake";
import { taskRunProcessor } from "../../src/jobs/processors/task-run";
import { FakeClock } from "../../src/lib/clock";
import { toServiceUser } from "../../src/services/actor";
import { listCampaignTasks } from "../../src/services/agent-tasks";
import { approveAll, decide, listPendingApprovals } from "../../src/services/approvals";
import {
  archiveCampaign,
  createCampaignFromMessage,
  getCampaign,
  listMessages,
  postUserMessage,
} from "../../src/services/campaigns";
import { editCopy, getPost, listPosts } from "../../src/services/posts";
import { approvePlan, getTaskGraph, requestPlanChanges } from "../../src/services/task-graphs";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";
import { seedProposedPlan, startHarness, type Harness } from "../helpers/harness";

/*
 * The Phase 2 domain services around the pipeline: intake's client, plan change requests, QA's
 * automatic revision and banned-words gate, human copy edits, multi-step approval chains,
 * archiving and the thread cursor. Every DTO a service returns is checked against its shared
 * schema.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const db = () => testDb();

/** Delegates to `target`, which a test may replace between calls. */
class SwitchableLlm implements LlmClient {
  readonly provider = "mock" as const;
  constructor(public target: LlmClient) {}
  get model(): string {
    return this.target.model;
  }
  complete(request: LlmRequest): Promise<LlmResponse> {
    return this.target.complete(request);
  }
}

/** MockLlm, but its clarifying question puts a guess of the client in the draft. */
class GuessingClientLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  guess: string | null = null;

  get model(): string {
    return this.#mock.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.#mock.complete(request);
    if (request.meta.agent !== "MANAGER" || request.meta.action !== "intake") return response;
    const output = JSON.parse(response.text) as ManagerIntakeOutput;
    if (output.result.kind !== "clarify") return response;
    output.result.draft.clientId = this.guess;
    return { ...response, text: JSON.stringify(output) };
  }
}

/** MockLlm whose next MANAGER.intake call waits, once it has started, until the test releases it. */
class GatedIntakeLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  #gate: { enter: () => void; released: Promise<void> } | null = null;

  get model(): string {
    return this.#mock.model;
  }

  /** Holds the next intake call: `entered` resolves once it is waiting, `release` lets it go. */
  hold(): { entered: Promise<void>; release: () => void } {
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.#gate = { enter, released };
    return { entered, release };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const gate = this.#gate;
    if (gate && request.meta.agent === "MANAGER" && request.meta.action === "intake") {
      this.#gate = null;
      gate.enter();
      await gate.released;
    }
    return this.#mock.complete(request);
  }
}

/** Runs the one QUEUED task with `nodeKey` now, as its task.run job would. */
async function runQueued(h: Harness, nodeKey: string) {
  const task = await db().agentTask.findFirstOrThrow({ where: { nodeKey, status: "QUEUED" } });
  await taskRunProcessor(
    {
      id: `run-${task.id}`,
      name: "task.run",
      data: { taskId: task.id, revision: task.revision, requeue: null },
      attemptsMade: 0,
      opts: { attempts: 3 },
    },
    h.deps,
  );
  return db().agentTask.findUniqueOrThrow({ where: { id: task.id } });
}

async function waitForApproval(h: Harness, campaignId: string, count: number) {
  await h.waitFor(
    async () =>
      (await db().post.count({ where: { campaignId, status: "PENDING_APPROVAL" } })) === count,
    30_000,
  );
}

describe("plans", () => {
  it("re-plans a change request verbatim as version 2 and supersedes version 1", async () => {
    const h = (harness = await startHarness());
    const seeded = await seedProposedPlan(h, { postCount: 2 });
    const user = toServiceUser(seeded.admin, null);
    const feedback = " Move everything a week later —\nand keep it to statics. ";

    const v1 = await requestPlanChanges(h.deps, user, seeded.graphId, feedback);
    expect(TaskGraphDto.parse(v1)).toMatchObject({ status: "PROPOSED", version: 1 });

    const v2 = await h.waitFor(() =>
      db().taskGraph.findFirst({ where: { campaignId: seeded.campaignId, version: 2 } }),
    );
    expect(v2).toMatchObject({ status: "PROPOSED", changeRequest: feedback });
    expect((await getTaskGraph(h.deps, seeded.graphId)).status).toBe("SUPERSEDED");

    const run = await db().agentRun.findFirstOrThrow({
      where: { agent: "MANAGER", action: "plan", outcome: "OK" },
    });
    expect(run.inputSnapshot).toMatchObject({
      changeRequest: feedback,
      enabledActions: ["write", "qa"],
    });
    expect((run.inputSnapshot as { previousGraph: unknown }).previousGraph).not.toBeNull();

    const messages = await listMessages(h.deps, seeded.threadId);
    expect(messages.map((message) => [message.role, message.kind])).toEqual([
      ["USER", "TEXT"],
      ["AGENT", "PLAN"],
    ]);
    expect(messages[0]?.content).toBe(feedback);
    expect(messages[1]?.payload).toEqual({ graphId: v2.id, version: 2 });
    expect(await db().realtimeEvent.count({ where: { type: "plan.proposed" } })).toBe(1);

    await expect(approvePlan(h.deps, user, seeded.graphId)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(requestPlanChanges(h.deps, user, seeded.graphId, "again")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const campaign = CampaignDto.parse(await getCampaign(h.deps, seeded.campaignId));
    expect(campaign.latestGraph).toEqual({ id: v2.id, version: 2, status: "PROPOSED" });
  });

  it("lets a failed re-plan be asked for again, by change request or by chat", async () => {
    // MOCK_LLM_FAULTS would fault every new plan request, so this test swaps LLMs mid-way.
    const llm = new SwitchableLlm(new MockLlm({ faults: "MANAGER.plan:invalid*3" }));
    const h = (harness = await startHarness({ llm }));
    const seeded = await seedProposedPlan(h, { postCount: 1 });
    const user = toServiceUser(seeded.admin, null);

    // The first change request fails all three attempts…
    await requestPlanChanges(h.deps, user, seeded.graphId, "Make it a carousel.");
    await h.waitFor(async () =>
      (await listMessages(h.deps, seeded.threadId)).some(
        (message) => message.role === "AGENT" && message.kind === "TEXT",
      ),
    );
    expect(
      await db().agentRun.count({ where: { action: "plan", outcome: "INVALID_OUTPUT" } }),
    ).toBe(3);
    expect((await getTaskGraph(h.deps, seeded.graphId)).status).toBe("PROPOSED");
    const alertsRaised = await db().realtimeEvent.findMany({ where: { type: "alert" } });
    expect(alertsRaised.map((row) => (row.payload as { entityType: string }).entityType)).toEqual([
      "Campaign",
    ]);

    // …and once the model behaves, asking again drafts version 2 after all.
    llm.target = new MockLlm();
    await requestPlanChanges(h.deps, user, seeded.graphId, "Make it a static, then.");
    const v2 = await h.waitFor(() =>
      db().taskGraph.findFirst({ where: { campaignId: seeded.campaignId, version: 2 } }),
    );
    expect(v2.changeRequest).toBe("Make it a static, then.");

    // A plan that never landed is drafted again from the next chat message.
    await db().taskGraph.deleteMany({ where: { campaignId: seeded.campaignId } });
    await postUserMessage(h.deps, user, seeded.threadId, "Spread them over two weeks.");
    const redrafted = await h.waitFor(() =>
      db().taskGraph.findFirst({ where: { campaignId: seeded.campaignId, version: 1 } }),
    );
    expect(redrafted.changeRequest).toBe("Spread them over two weeks.");
  });
});

describe("QA", () => {
  it("sends a draft back once, then hands it to humans with its notes", async () => {
    const h = (harness = await startHarness({ env: { MOCK_LLM_FAULTS: "MANAGER.qa:weak*2" } }));
    const seeded = await seedProposedPlan(h, { postCount: 1 });
    await approvePlan(h.deps, toServiceUser(seeded.admin, null), seeded.graphId);
    await waitForApproval(h, seeded.campaignId, 1);

    const tasks = (await listCampaignTasks(h.deps, seeded.campaignId)).map((task) =>
      AgentTaskDto.parse(task),
    );
    expect(tasks.map((task) => [task.nodeKey, task.action, task.status])).toEqual([
      ["n1", "write", "SUCCEEDED"],
      ["n1.r1", "write", "SUCCEEDED"],
      ["n2", "qa", "SUCCEEDED"],
      ["n2.r1", "qa", "SUCCEEDED"],
    ]);
    const revision = tasks.find((task) => task.nodeKey === "n1.r1");
    expect(revision?.feedback).toMatchObject({ source: "QA", decisionId: null });
    expect(revision?.dependsOn).toEqual([]);
    expect(tasks.find((task) => task.nodeKey === "n2.r1")?.dependsOn).toEqual([revision?.id]);

    const post = await db().post.findFirstOrThrow({ where: { campaignId: seeded.campaignId } });
    expect(post.revision).toBe(1);
    expect(post.qaNotes).toMatch(/Still open after the automatic revision/);
    expect(await db().approvalRequest.count({ where: { postId: post.id } })).toBe(1);
  });
});

describe("banned words before approval", () => {
  /** A word of at least five letters from the post's caption, other than `except`. */
  async function captionWord(postId: string, except: readonly string[] = []) {
    const post = await db().post.findUniqueOrThrow({ where: { id: postId } });
    const { caption } = CopywriterOutputSchema.parse(post.copy);
    const taken = new Set(except.map((word) => word.toLowerCase()));
    const word = [...caption.matchAll(/\p{L}{5,}/gu)]
      .map((match) => match[0])
      .find((candidate) => !taken.has(candidate.toLowerCase()));
    if (!word) throw new Error(`No word to ban in "${caption}"`);
    return word;
  }

  /** Drafts the single post, then bans a word its copy uses, as a client edit mid-run would. */
  async function draftThenBan(h: Harness) {
    const seeded = await seedProposedPlan(h, { postCount: 1 });
    await approvePlan(h.deps, toServiceUser(seeded.admin, null), seeded.graphId);
    await runQueued(h, "n1");
    const post = await db().post.findFirstOrThrow({ where: { campaignId: seeded.campaignId } });
    const term = await captionWord(post.id);
    await banWords(seeded.client.id, [term]);
    return { seeded, post, term };
  }

  const banWords = (clientId: string, bannedWords: string[]) =>
    db().client.update({ where: { id: clientId }, data: { bannedWords } });
  const rounds = (postId: string) => db().approvalRequest.count({ where: { postId } });

  it("sends a draft using a banned word back; only its clean rewrite reaches approval", async () => {
    const h = (harness = await startHarness({ workers: false }));
    const { post, term } = await draftThenBan(h);

    await runQueued(h, "n2");
    expect(await rounds(post.id)).toBe(0);
    const revised = await db().post.findUniqueOrThrow({ where: { id: post.id } });
    expect(revised).toMatchObject({ status: "QA", revision: 1 });
    const chain = await db().agentTask.findMany({
      where: { postId: post.id, revision: 1 },
      orderBy: { createdAt: "asc" },
    });
    expect(chain.map((task) => [task.nodeKey, task.status])).toEqual([
      ["n1.r1", "QUEUED"],
      ["n2.r1", "PENDING"],
    ]);
    const feedback = chain[0]?.feedback as { verbatim: string; source: string };
    expect(feedback.source).toBe("QA");
    expect(feedback.verbatim).toContain(`"${term}"`);

    await runQueued(h, "n1.r1");
    await runQueued(h, "n2.r1");
    const approvable = await db().post.findUniqueOrThrow({ where: { id: post.id } });
    expect(approvable.status).toBe("PENDING_APPROVAL");
    expect(
      scanForBannedWords(CopywriterOutputSchema.parse(approvable.copy), [term], {
        ignoreKeys: COPY_BANNED_SCAN_IGNORE,
      }),
    ).toEqual([]);
    expect(await rounds(post.id)).toBe(1);
  });

  it("escalates a draft still using a banned word once QA revisions run out, with no round", async () => {
    const h = (harness = await startHarness({ workers: false }));
    const { seeded, post, term } = await draftThenBan(h);
    await runQueued(h, "n2");
    await runQueued(h, "n1.r1");
    // The rewrite dropped the first word; the client now bans one the rewrite uses too.
    const second = await captionWord(post.id, [term]);
    await banWords(seeded.client.id, [term, second]);

    const qa = await runQueued(h, "n2.r1");
    expect(qa.status).toBe("ESCALATED");
    expect(qa.output).toMatchObject({ verdict: "revise" });
    expect(await rounds(post.id)).toBe(0);
    expect(await db().agentTask.count({ where: { postId: post.id, revision: 2 } })).toBe(0);
    const stuck = await db().post.findUniqueOrThrow({ where: { id: post.id } });
    expect(stuck.status).not.toBe("PENDING_APPROVAL");
    expect(stuck.needsAttention).toBe(true);
    expect(stuck.attentionReason).toContain(second);

    const message = await db().chatMessage.findFirstOrThrow({
      where: { threadId: seeded.threadId, kind: "ESCALATION" },
    });
    expect(message.payload).toMatchObject({ taskId: qa.id, postRef: "p1", reason: "BANNED_WORDS" });
    const alerts = await db().realtimeEvent.findMany({ where: { type: "alert" } });
    expect(alerts.map((row) => row.payload as AlertPayload)).toEqual([
      expect.objectContaining({ kind: "escalated", entityType: "AgentTask", entityId: qa.id }),
    ]);
  });

  it("escalates at once when no QA revision is allowed", async () => {
    const h = (harness = await startHarness({ env: { MAX_QA_REVISIONS: "0" }, workers: false }));
    const { post, term } = await draftThenBan(h);

    const qa = await runQueued(h, "n2");
    expect(qa.status).toBe("ESCALATED");
    expect(qa.error).toContain(term);
    expect(await rounds(post.id)).toBe(0);
    expect(await db().agentTask.count({ where: { postId: post.id, revision: { gt: 0 } } })).toBe(0);
  });
});

describe("intake", () => {
  it("lets the answer name another client than the one the question guessed", async () => {
    const llm = new GuessingClientLlm();
    const h = (harness = await startHarness({ llm }));
    const admin = await createUser({ role: "ADMIN" });
    const bayt = await createClient({ name: "Bayt Coffee", enabledPlatforms: ["INSTAGRAM"] });
    const qahwa = await createClient({ name: "Qahwa Coffee", enabledPlatforms: ["INSTAGRAM"] });
    // Two coffee clients: the Manager asks which one, with a (wrong) guess in its draft.
    llm.guess = bayt.id;
    const user = toServiceUser(admin, null);
    const campaign = await createCampaignFromMessage(h.deps, user, {
      message: "Ramadan campaign for the coffee client — 12 posts, push the iced line",
    });

    const clarify = await h.waitFor(() =>
      db().chatMessage.findFirst({ where: { threadId: campaign.threadId, kind: "CLARIFY" } }),
    );
    expect(clarify.payload).toMatchObject({
      missing: expect.arrayContaining(["client"]) as unknown,
      draft: { clientId: bayt.id },
    });
    // A guess isn't a choice: the campaign still has no client of its own.
    expect((await getCampaign(h.deps, campaign.id)).client).toBeNull();

    await postUserMessage(h.deps, user, campaign.threadId, "It's for Qahwa: Instagram, March 1–30");
    const brief = await h.waitFor(() =>
      db().chatMessage.findFirst({ where: { threadId: campaign.threadId, kind: "BRIEF" } }),
    );
    expect((brief.payload as { brief: Brief }).brief.clientId).toBe(qahwa.id);
    expect((await getCampaign(h.deps, campaign.id)).client?.id).toBe(qahwa.id);
    const answered = await db().agentRun.findFirstOrThrow({
      where: { campaignId: campaign.id, action: "intake", outcome: "OK" },
      orderBy: { createdAt: "desc" },
    });
    expect((answered.inputSnapshot as ManagerIntakeInput).selectedClientId).toBeNull();
  });

  it("holds the brief to the client the team picked when it started the campaign", async () => {
    const h = (harness = await startHarness());
    const admin = await createUser({ role: "ADMIN" });
    const qahwa = await createClient({ name: "Qahwa Coffee", enabledPlatforms: ["INSTAGRAM"] });
    await createClient({ name: "Bayt Coffee", enabledPlatforms: ["INSTAGRAM"] });
    const user = toServiceUser(admin, null);
    const campaign = await createCampaignFromMessage(h.deps, user, {
      clientId: qahwa.id,
      message: "Ramadan campaign — 4 posts on Instagram, March 1–30",
    });
    const brief = await h.waitFor(() =>
      db().chatMessage.findFirst({ where: { threadId: campaign.threadId, kind: "BRIEF" } }),
    );
    expect((brief.payload as { brief: Brief }).brief.clientId).toBe(qahwa.id);
    const run = await db().agentRun.findFirstOrThrow({
      where: { campaignId: campaign.id, action: "intake" },
    });
    expect((run.inputSnapshot as ManagerIntakeInput).selectedClientId).toBe(qahwa.id);
  });
});

describe("today, in the client's calendar", () => {
  it("dates the brief and the plan by the client's day, not the UTC one", async () => {
    // 21:00 on Sept 24 in New York, when UTC is already on Sept 25.
    const clock = new FakeClock("2026-09-25T01:00:00.000Z");
    const h = (harness = await startHarness({ clock }));
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({
      name: "Hudson Roasters",
      timezone: "America/New_York",
      enabledPlatforms: ["INSTAGRAM"],
    });
    const campaign = await createCampaignFromMessage(h.deps, toServiceUser(admin, null), {
      clientId: client.id,
      message: "Iced line launch — 4 posts on Instagram, September 24–30",
    });

    // The window starts on the client's today, which the UTC day would have called the past.
    const brief = await h.waitFor(() =>
      db().chatMessage.findFirst({ where: { threadId: campaign.threadId, kind: "BRIEF" } }),
    );
    expect((brief.payload as { brief: Brief }).brief.window).toEqual({
      start: "2026-09-24",
      end: "2026-09-30",
    });
    const intake = await db().agentRun.findFirstOrThrow({
      where: { campaignId: campaign.id, action: "intake" },
    });
    expect((intake.inputSnapshot as ManagerIntakeInput).today).toBe("2026-09-24");

    await h.waitFor(() =>
      db().chatMessage.findFirst({ where: { threadId: campaign.threadId, kind: "PLAN" } }),
    );
    const plan = await db().agentRun.findFirstOrThrow({
      where: { campaignId: campaign.id, action: "plan" },
    });
    expect((plan.inputSnapshot as ManagerPlanInput).today).toBe("2026-09-24");
    const graph = await db().taskGraph.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(ManagerPlanOutput.parse(graph.graph).posts[0]?.targetDate).toBe("2026-09-24");
  });
});

describe("intake with several turns in flight", () => {
  const BRIEF = "Ramadan campaign — 4 posts";
  const MORE = "Push the iced oat latte hardest";
  const ANSWER = "Instagram, March 1–30";

  /** Runs manager.intake for `messageId` now, as its job would. */
  function runIntakeJob(h: Harness, campaignId: string, messageId: string) {
    return managerIntakeProcessor(
      {
        id: `intake-${messageId}`,
        name: "manager.intake",
        data: { campaignId, messageId },
        attemptsMade: 0,
        opts: { attempts: 3 },
      },
      h.deps,
    );
  }

  /** A campaign for Qahwa whose brief turn and a second message both wait for the Manager. */
  async function twoTurns(h: Harness) {
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM"] });
    const user = toServiceUser(admin, null);
    const campaign = await createCampaignFromMessage(h.deps, user, {
      clientId: client.id,
      message: BRIEF,
    });
    const [first] = await listMessages(h.deps, campaign.threadId);
    const second = await postUserMessage(h.deps, user, campaign.threadId, MORE);
    if (!first) throw new Error("no brief turn");
    return { campaign, user, first, second };
  }

  /** The thread as [role, kind], oldest first. */
  async function thread(hs: Harness, threadId: string) {
    return (await listMessages(hs.deps, threadId)).map((message) => [message.role, message.kind]);
  }

  /** The one question stands unanswered, and the team's answer is what locks the brief. */
  async function expectQuestionThenAnswer(
    hs: Harness,
    turns: Awaited<ReturnType<typeof twoTurns>>,
  ) {
    const { campaign, user } = turns;
    expect(await thread(hs, campaign.threadId)).toEqual([
      ["USER", "TEXT"],
      ["USER", "TEXT"],
      ["AGENT", "CLARIFY"],
    ]);
    expect(await db().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      status: "BRIEFING",
      clarifyCount: 1,
      briefLockedAt: null,
    });
    // Both turns were read by the one question.
    const asked = await db().agentRun.findFirstOrThrow({
      where: { campaignId: campaign.id, action: "intake", outcome: "OK" },
    });
    expect(
      (asked.inputSnapshot as ManagerIntakeInput).thread.map((message) => message.content),
    ).toEqual([BRIEF, MORE]);

    const answer = await postUserMessage(hs.deps, user, campaign.threadId, ANSWER);
    await runIntakeJob(hs, campaign.id, answer.id);
    expect(await thread(hs, campaign.threadId)).toEqual([
      ["USER", "TEXT"],
      ["USER", "TEXT"],
      ["AGENT", "CLARIFY"],
      ["USER", "TEXT"],
      ["AGENT", "BRIEF"],
    ]);
    const locked = await getCampaign(hs.deps, campaign.id);
    expect(locked.status).toBe("PLANNING");
    expect(locked.brief).toMatchObject({ platforms: ["INSTAGRAM"], postCount: 4 });
    expect(locked.brief?.window.start.slice(5)).toBe("03-01");
  }

  it("answers only the newest of two turns, one after the other, and waits for the answer", async () => {
    const hs = (harness = await startHarness({ workers: false }));
    const turns = await twoTurns(hs);
    const { campaign, first, second } = turns;

    await runIntakeJob(hs, campaign.id, first.id);
    // The older turn's job leaves it to the newer one: nothing asked, nothing spent.
    expect(await thread(hs, campaign.threadId)).toEqual([
      ["USER", "TEXT"],
      ["USER", "TEXT"],
    ]);
    expect(await db().agentRun.count()).toBe(0);
    await runIntakeJob(hs, campaign.id, second.id);
    // Run again (a retry, a stalled job), both are no-ops now that the Manager has asked.
    await runIntakeJob(hs, campaign.id, first.id);
    await runIntakeJob(hs, campaign.id, second.id);
    expect(await db().agentRun.count()).toBe(1);

    await expectQuestionThenAnswer(hs, turns);
  });

  it("answers only the newest of two turns when their jobs run at once", async () => {
    const hs = (harness = await startHarness({ workers: false }));
    const turns = await twoTurns(hs);
    const { campaign, first, second } = turns;

    // Two jobs for the newest turn too (a stalled job run twice): still one question.
    await Promise.all([
      runIntakeJob(hs, campaign.id, first.id),
      runIntakeJob(hs, campaign.id, second.id),
      runIntakeJob(hs, campaign.id, second.id),
    ]);
    expect(await db().chatMessage.count({ where: { kind: { in: ["CLARIFY", "BRIEF"] } } })).toBe(1);

    await expectQuestionThenAnswer(hs, turns);
  });

  it("drops a reply to a turn that a newer message overtook while the model was thinking", async () => {
    const llm = new GatedIntakeLlm();
    const hs = (harness = await startHarness({ llm, workers: false }));
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM"] });
    const user = toServiceUser(admin, null);
    const campaign = await createCampaignFromMessage(hs.deps, user, {
      clientId: client.id,
      message: BRIEF,
    });
    const [first] = await listMessages(hs.deps, campaign.threadId);
    if (!first) throw new Error("no brief turn");

    const gate = llm.hold();
    const running = runIntakeJob(hs, campaign.id, first.id);
    await gate.entered;
    // The model is reading [BRIEF] when the second message lands.
    const second = await postUserMessage(hs.deps, user, campaign.threadId, MORE);
    gate.release();
    await running;
    expect(await thread(hs, campaign.threadId)).toEqual([
      ["USER", "TEXT"],
      ["USER", "TEXT"],
    ]);
    expect(
      (await db().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).clarifyCount,
    ).toBe(0);

    await runIntakeJob(hs, campaign.id, second.id);
    expect(await thread(hs, campaign.threadId)).toEqual([
      ["USER", "TEXT"],
      ["USER", "TEXT"],
      ["AGENT", "CLARIFY"],
    ]);
    const answer = await postUserMessage(hs.deps, user, campaign.threadId, ANSWER);
    await runIntakeJob(hs, campaign.id, answer.id);
    expect((await getCampaign(hs.deps, campaign.id)).status).toBe("PLANNING");
  });
});

describe("copy edits", () => {
  it("refuses banned words and reopens approval with a fresh round after an edit", async () => {
    const h = (harness = await startHarness());
    const client = await createClient({
      name: "Qahwa Co",
      enabledPlatforms: ["INSTAGRAM"],
      bannedWords: ["cheap"],
    });
    const seeded = await seedProposedPlan(h, { postCount: 1, client });
    const user = toServiceUser(seeded.admin, null);
    await approvePlan(h.deps, user, seeded.graphId);
    await waitForApproval(h, seeded.campaignId, 1);

    const post = await getPost(h.deps, user, (await db().post.findFirstOrThrow()).id);
    const copy = post.copy as CopywriterOutput;
    const round1 = await db().approvalRequest.findFirstOrThrow({ where: { postId: post.id } });

    await expect(
      editCopy(h.deps, user, post.id, { copy: { ...copy, caption: "Cheap and cold." } }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE",
      details: { bannedWords: [{ path: "caption", term: "cheap", match: "Cheap" }] },
    });

    const edited = PostDto.parse(
      await editCopy(h.deps, user, post.id, { copy: { ...copy, caption: "Cold, slow, iced." } }),
    );
    expect(edited).toMatchObject({ status: "PENDING_APPROVAL", humanEditCount: 1 });
    expect(edited.currentApproval).toMatchObject({ round: 2, status: "PENDING", canDecide: true });
    const round2 = await db().approvalRequest.findUniqueOrThrow({
      where: { postId_round: { postId: post.id, round: 2 } },
    });
    expect(
      (await db().approvalRequest.findUniqueOrThrow({ where: { id: round1.id } })).status,
    ).toBe("CANCELLED");
    expect(round2.contentHash).not.toBe(round1.contentHash);

    const approved = ApprovalRequestDto.parse(
      await decide(h.deps, user, round2.id, { decision: "APPROVE" }),
    );
    expect(approved.status).toBe("APPROVED");
    expect(approved.post).toMatchObject({ status: "APPROVED", approved: true });

    const reopened = await editCopy(h.deps, user, post.id, {
      copy: { ...copy, cta: "Order ahead" },
    });
    expect(reopened).toMatchObject({
      status: "PENDING_APPROVAL",
      approvedAt: null,
      humanEditCount: 2,
    });
    expect(reopened.currentApproval?.round).toBe(3);
    expect(
      (await db().approvalRequest.findUniqueOrThrow({ where: { id: round2.id } })).status,
    ).toBe("CANCELLED");
  });
});

describe("approval chains", () => {
  const chain: ApprovalChain = {
    steps: [
      { name: "Manager review", approverRoles: ["MANAGER"], approverUserIds: [], minApprovals: 1 },
      { name: "Admin sign-off", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 },
    ],
  };

  it("approve-all decides only the current step the user may decide, never skipping one", async () => {
    const h = (harness = await startHarness());
    const admin = await createUser({ role: "ADMIN" });
    const manager = toServiceUser(await createUser({ role: "MANAGER" }), null);
    const editor = toServiceUser(await createUser({ role: "EDITOR" }), null);
    const adminUser = toServiceUser(admin, "10.0.0.1");
    const client = await createClient({
      name: "Qahwa Co",
      enabledPlatforms: ["INSTAGRAM"],
      approvalChain: chain,
    });
    const seeded = await seedProposedPlan(h, { postCount: 2, client, admin });
    await approvePlan(h.deps, adminUser, seeded.graphId);
    await waitForApproval(h, seeded.campaignId, 2);

    const forManager = await listPendingApprovals(h.deps, manager, {
      campaignId: seeded.campaignId,
    });
    expect(forManager.map((request) => ApprovalRequestDto.parse(request).canDecide)).toEqual([
      true,
      true,
    ]);
    const ids = forManager.map((request) => request.id);
    expect(
      (await listPendingApprovals(h.deps, adminUser, { clientId: client.id })).every(
        (request) => !request.canDecide,
      ),
    ).toBe(true);
    expect(await listPendingApprovals(h.deps, manager, { platform: "TIKTOK" })).toEqual([]);

    await expect(
      decide(h.deps, editor, ids[0] ?? "", { decision: "APPROVE" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const tooEarly = await approveAll(h.deps, adminUser, [...ids, "missing"]);
    expect(tooEarly).toMatchObject({
      approvedCount: 0,
      pendingCount: 0,
      skippedCount: 3,
      auditLogId: null,
    });
    expect(tooEarly.results.map((result) => result.reason)).toEqual([
      "NOT_ELIGIBLE",
      "NOT_ELIGIBLE",
      "NOT_FOUND",
    ]);

    const firstStep = await approveAll(h.deps, manager, ids);
    expect(firstStep).toMatchObject({ approvedCount: 0, pendingCount: 2, skippedCount: 0 });
    expect(firstStep.results.every((result) => result.currentStep === 1)).toBe(true);
    const again = await approveAll(h.deps, manager, ids);
    expect(again.results.map((result) => result.reason)).toEqual(["NOT_ELIGIBLE", "NOT_ELIGIBLE"]);

    const signOff = await approveAll(h.deps, adminUser, ids);
    expect(signOff).toMatchObject({ approvedCount: 2, pendingCount: 0, skippedCount: 0 });
    expect(
      await db().post.count({ where: { status: "APPROVED", approvedAt: { not: null } } }),
    ).toBe(2);

    const audits = await db().auditLog.findMany({
      where: { action: "approval.approve_all" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((audit) => audit.id)).toEqual([firstStep.auditLogId, signOff.auditLogId]);
    expect(audits[1]).toMatchObject({ actorId: admin.id, ip: "10.0.0.1" });
    const decisions = await db().approvalDecision.findMany({ orderBy: { createdAt: "asc" } });
    expect(decisions.map((d) => [d.step, d.viaApproveAll])).toEqual([
      [0, true],
      [0, true],
      [1, true],
      [1, true],
    ]);
  });
});

describe("campaigns", () => {
  it("archiving cancels unfinished work so nothing more is spent", async () => {
    const h = (harness = await startHarness({ workers: false }));
    const seeded = await seedProposedPlan(h, { postCount: 2 });
    const user = toServiceUser(seeded.admin, null);
    await approvePlan(h.deps, user, seeded.graphId);
    const queued = await db().agentTask.findMany({ where: { status: "QUEUED" } });
    expect(queued).toHaveLength(2);

    const archived = CampaignDto.parse(await archiveCampaign(h.deps, user, seeded.campaignId));
    expect(archived.status).toBe("ARCHIVED");
    expect(await db().agentTask.count({ where: { status: { not: "CANCELLED" } } })).toBe(0);
    expect((await archiveCampaign(h.deps, user, seeded.campaignId)).status).toBe("ARCHIVED");

    // A job that was already queued finds its task cancelled and does nothing.
    const task = queued[0];
    if (!task) throw new Error("no queued task");
    await taskRunProcessor(
      {
        id: "late",
        name: "task.run",
        data: { taskId: task.id, revision: 0, requeue: null },
        attemptsMade: 0,
        opts: { attempts: 3 },
      },
      h.deps,
    );
    expect(await db().agentRun.count()).toBe(0);
    await expect(postUserMessage(h.deps, user, seeded.threadId, "hello?")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("stores the brief turn, queues intake and pages the thread with an exclusive cursor", async () => {
    const h = (harness = await startHarness({ workers: false }));
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co" });
    const user = toServiceUser(admin, null);

    await expect(
      createCampaignFromMessage(h.deps, user, { clientId: "nope", message: "hi" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const campaign = CampaignDto.parse(
      await createCampaignFromMessage(h.deps, user, {
        clientId: client.id,
        message: "Ramadan campaign — 12 posts",
      }),
    );
    expect(campaign).toMatchObject({
      status: "BRIEFING",
      client: { id: client.id, name: "Qahwa Co" },
      name: "Ramadan campaign — 12 posts",
      clarifyCount: 0,
      latestGraph: null,
    });
    const intake = await h.deps.queues.queue("agents").getJobs(["waiting"]);
    expect(intake.map((job) => job.name)).toEqual(["manager.intake"]);

    const second = await postUserMessage(h.deps, user, campaign.threadId, "Instagram only");
    await postUserMessage(h.deps, user, campaign.threadId, "March 1–30");
    const all = await listMessages(h.deps, campaign.threadId);
    expect(all.map((message) => ChatMessageDto.parse(message).content)).toEqual([
      "Ramadan campaign — 12 posts",
      "Instagram only",
      "March 1–30",
    ]);
    expect(all[0]?.author).toEqual({ id: admin.id, name: admin.name });
    const after = await listMessages(h.deps, campaign.threadId, all[0]?.id);
    expect(after.map((message) => message.id)).toEqual([second.id, all[2]?.id]);
    await expect(listMessages(h.deps, campaign.threadId, "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await h.deps.queues.queue("agents").count()).toBe(3);

    const posts = await listPosts(h.deps, user, { campaignId: campaign.id });
    expect(posts).toEqual([]);
  });
});
