import type {
  AgentTask,
  ApprovalRequest,
  Campaign,
  CampaignStatus,
  Client,
  Post,
  PostStatus,
  TaskGraph,
  TaskGraphStatus,
} from "@enmo/db";
import {
  ApprovalChain,
  canonicalGraph,
  estimatePlan,
  type Brief,
  type CopywriterOutput,
  type ManagerPlanOutput,
  type PipelineAction,
  type Platform,
  type PlannedPost,
  type PostType,
} from "@enmo/shared";
import type { InjectOptions } from "fastify";
import type { Deps } from "../../src/deps";
import { QUEUE_NAMES } from "../../src/jobs/queues";
import type { ApiApp } from "../../src/types";
import { browserHeaders } from "./app";
import { sessionCookieFor, type CookieHeader } from "./auth";
import { testDb } from "./db";
import { createUser, type TestUser } from "./factories";

/*
 * Phase 2 rows for the route tests, written straight through Prisma: the state the orchestrator
 * would have produced (a locked brief, a proposed or approved plan, drafted posts waiting in
 * approval), without running the worker.
 */

/** One signed-in teammate per role. */
export interface Team {
  admin: TestUser;
  manager: TestUser;
  editor: TestUser;
  cookies: Record<"admin" | "manager" | "editor", CookieHeader>;
}

export async function createTeam(): Promise<Team> {
  const admin = await createUser({ role: "ADMIN" });
  const manager = await createUser({ role: "MANAGER" });
  const editor = await createUser({ role: "EDITOR" });
  return {
    admin,
    manager,
    editor,
    cookies: {
      admin: await sessionCookieFor(admin),
      manager: await sessionCookieFor(manager),
      editor: await sessionCookieFor(editor),
    },
  };
}

export type Method = NonNullable<InjectOptions["method"]>;

/** A browser-like request to `app`: the allowed Origin, the cookie and an optional JSON body. */
export function sender(app: () => ApiApp) {
  return (method: Method, url: string, cookie?: CookieHeader, payload?: unknown) =>
    app().inject({
      method,
      url,
      headers: browserHeaders(cookie),
      ...(payload === undefined ? {} : { payload: payload as InjectOptions["payload"] }),
    });
}

export const FIXTURE_PLATFORMS: readonly Platform[] = ["INSTAGRAM", "TIKTOK"];

export function testBrief(client: Pick<Client, "id">, overrides: Partial<Brief> = {}): Brief {
  return {
    clientId: client.id,
    title: "Ramadan iced line",
    objective: "Push the iced line through Ramadan evenings",
    productFocus: "Iced oat latte",
    audience: "Young professionals breaking their fast late",
    keyMessages: ["Cold, smooth, made for suhoor"],
    platforms: [...FIXTURE_PLATFORMS],
    postCount: 3,
    postMix: [{ type: "STATIC", count: 3 }],
    window: { start: "2027-02-08", end: "2027-03-09" },
    cadenceNotes: null,
    constraints: [],
    assumptions: [],
    ...overrides,
  };
}

export function plannedPosts(count: number, type: PostType = "STATIC"): PlannedPost[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: `p${index + 1}`,
    type,
    platforms: [...FIXTURE_PLATFORMS],
    targetDate: `2027-02-${String(10 + index).padStart(2, "0")}`,
    angle: `Angle ${index + 1}`,
    pillarHint: null,
  }));
}

export function testPlan(
  count: number,
  actions: readonly PipelineAction[] = ["write", "qa"],
): ManagerPlanOutput {
  const posts = plannedPosts(count);
  return {
    summary: `${count} static posts, drafted then checked by the Manager.`,
    posts,
    nodes: canonicalGraph(posts, actions),
  };
}

/** A complete STATIC-post draft for the fixture platforms. */
export function testCopy(caption = "Cold brew, warm evenings."): CopywriterOutput {
  return {
    caption,
    hashtags: ["#Ramadan", "#IcedLatte"],
    cta: "Order tonight",
    altText: "An iced oat latte on a table at dusk",
    platformCaptions: FIXTURE_PLATFORMS.map((platform) => ({ platform, caption })),
    script: null,
    slides: null,
    onScreenText: "Iced, after iftar",
  };
}

export interface SeededCampaign {
  campaign: Campaign;
  threadId: string;
}

export interface SeedCampaignInput {
  createdBy: { id: string };
  client?: Client | null;
  status?: CampaignStatus;
  brief?: Brief | null;
  name?: string;
  createdAt?: Date;
}

export async function seedCampaign(input: SeedCampaignInput): Promise<SeededCampaign> {
  const locked = input.brief !== undefined && input.brief !== null;
  const campaign = await testDb().campaign.create({
    data: {
      clientId: input.client?.id ?? null,
      name: input.name ?? "Ramadan iced line",
      status: input.status ?? (locked ? "PLANNING" : "BRIEFING"),
      brief: input.brief ?? undefined,
      clarifyCount: locked ? 1 : 0,
      briefLockedAt: locked ? new Date() : null,
      createdById: input.createdBy.id,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      thread: { create: {} },
    },
    include: { thread: true },
  });
  if (!campaign.thread) throw new Error("seedCampaign: no thread");
  return { campaign, threadId: campaign.thread.id };
}

export interface SeedPlanInput {
  campaign: Pick<Campaign, "id">;
  plan: ManagerPlanOutput;
  version?: number;
  status?: TaskGraphStatus;
  changeRequest?: string | null;
  approvedBy?: { id: string } | null;
}

export function seedPlan(input: SeedPlanInput): Promise<TaskGraph> {
  const { plan } = input;
  return testDb().taskGraph.create({
    data: {
      campaignId: input.campaign.id,
      version: input.version ?? 1,
      status: input.status ?? "PROPOSED",
      summary: plan.summary,
      graph: plan,
      estimate: estimatePlan(plan),
      changeRequest: input.changeRequest ?? null,
      approvedById: input.approvedBy?.id ?? null,
      approvedAt: input.approvedBy ? new Date() : null,
    },
  });
}

export interface SeededPipeline extends SeededCampaign {
  graph: TaskGraph;
  posts: Post[];
  tasks: AgentTask[];
  /** One PENDING round 1 per post, in post order (empty when `postStatus` isn't in approval). */
  requests: ApprovalRequest[];
}

export interface SeedPipelineInput {
  createdBy: { id: string };
  client: Client;
  postCount?: number;
  postStatus?: PostStatus;
  campaignStatus?: CampaignStatus;
}

/**
 * An approved write+qa plan whose posts were drafted and passed QA: every task SUCCEEDED, every post
 * PENDING_APPROVAL with copy and an open round 1 snapshotting the client's chain. Rounds are created
 * a second apart in post order, so p1's is the oldest.
 */
export async function seedPipeline(input: SeedPipelineInput): Promise<SeededPipeline> {
  const db = testDb();
  const count = input.postCount ?? 3;
  const brief = testBrief(input.client, {
    postCount: count,
    postMix: [{ type: "STATIC", count }],
  });
  const seeded = await seedCampaign({
    createdBy: input.createdBy,
    client: input.client,
    brief,
    status: input.campaignStatus ?? "PRODUCING",
  });
  const plan = testPlan(count);
  const graph = await seedPlan({
    campaign: seeded.campaign,
    plan,
    status: "APPROVED",
    approvedBy: input.createdBy,
  });

  const postStatus = input.postStatus ?? "PENDING_APPROVAL";
  const posts: Post[] = [];
  for (const planned of plan.posts) {
    posts.push(
      await db.post.create({
        data: {
          campaignId: seeded.campaign.id,
          clientId: input.client.id,
          ref: planned.ref,
          type: planned.type,
          platforms: planned.platforms,
          status: postStatus,
          targetDate: new Date(`${planned.targetDate}T00:00:00Z`),
          angle: planned.angle,
          copy: testCopy(`Caption for ${planned.ref}`),
        },
      }),
    );
  }
  const postIdByRef = new Map(posts.map((post) => [post.ref, post.id]));

  const tasks: AgentTask[] = [];
  const taskIdByNode = new Map<string, string>();
  const finishedAt = new Date();
  for (const node of plan.nodes) {
    const task = await db.agentTask.create({
      data: {
        graphId: graph.id,
        nodeKey: node.id,
        agent: node.agent,
        action: node.action,
        postId: node.postRef ? (postIdByRef.get(node.postRef) ?? null) : null,
        dependsOn: node.deps.map((dep) => taskIdByNode.get(dep) ?? dep),
        status: "SUCCEEDED",
        contractAttempts: 1,
        queuedAt: finishedAt,
        startedAt: finishedAt,
        finishedAt,
      },
    });
    taskIdByNode.set(node.id, task.id);
    tasks.push(task);
  }

  const requests: ApprovalRequest[] = [];
  if (postStatus === "PENDING_APPROVAL") {
    const chain = ApprovalChain.parse(input.client.approvalChain);
    const base = Date.now() - posts.length * 1000;
    for (const [index, post] of posts.entries()) {
      requests.push(
        await db.approvalRequest.create({
          data: {
            postId: post.id,
            round: 1,
            status: "PENDING",
            chain,
            currentStep: 0,
            contentHash: `fixture-${post.ref}`,
            createdAt: new Date(base + index * 1000),
          },
        }),
      );
    }
  }

  return { ...seeded, graph, posts, tasks, requests };
}

/** Removes the jobs routes enqueued on this app's queues (each test app has its own prefix). */
export async function obliterateQueues(deps: Deps): Promise<void> {
  for (const name of QUEUE_NAMES) {
    await deps.queues.queue(name).obliterate({ force: true });
  }
}

/** Jobs waiting on one of the app's queues, as {name, data, id}. */
export async function queuedJobs(deps: Deps, queue: (typeof QUEUE_NAMES)[number] = "agents") {
  const jobs = await deps.queues.queue(queue).getJobs(["waiting", "delayed", "prioritized"]);
  return jobs.map((job) => ({ id: job.id, name: job.name, data: job.data as unknown }));
}
