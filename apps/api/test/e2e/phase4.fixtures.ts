import type { Client, Post, PublishJob, SocialAccount, User } from "@enmo/db";
import {
  canonicalGraph,
  estimatePlan,
  type Brief,
  type ManagerPlanOutput,
  type Platform,
  type PostType,
} from "@enmo/shared";
import { expect } from "vitest";
import { DAY_MS } from "../../src/lib/clock";
import { browserHeaders } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";
import type { Harness } from "../helpers/harness";
import { FAKE_META_PAGES } from "../fakes/meta-graph";

/*
 * Shared arrangements of the Phase 4 pipeline suites (phase4.*.test.ts): a Meta campaign whose
 * plan waits for approval, driven through the real pipeline to approval, then publishing. Times
 * are in Asia/Riyadh (UTC+3 all year), so slot arithmetic in the tests stays readable.
 */

/** Monday 1 March 2027, 09:00 in Riyadh. */
export const NOW = "2027-03-01T06:00:00.000Z";
export const RIYADH = "Asia/Riyadh";
/** Tuesday 2 March, the plan's date for p1 (p2 on Wednesday, p3 on Thursday). */
export const TUESDAY = "2027-03-02";
export const WEDNESDAY = "2027-03-03";
export const THURSDAY = "2027-03-04";
/** The optimizer's best Tuesday slots: Facebook's 09:00 and Instagram's 11:00 peaks. */
export const FB_TUESDAY_0900 = "2027-03-02T06:00:00.000Z";
export const IG_TUESDAY_1100 = "2027-03-02T08:00:00.000Z";

export interface SeededMetaPlan {
  admin: User;
  client: Client;
  campaignId: string;
  threadId: string;
  graphId: string;
  cookie: string;
}

export interface SeedMetaPlanOptions {
  postCount?: number;
  type?: PostType;
  /** One post per entry, in order (p1 is types[0]); overrides postCount and type. */
  types?: readonly PostType[];
  platforms?: readonly Platform[];
  bannedWords?: string[];
  /** Every post's target date (default: p1 on Tuesday, p2 on Wednesday, …). */
  sameTargetDate?: boolean;
}

/**
 * A client on Instagram and Facebook in Riyadh and a campaign whose plan v1 (write → direct → qa
 * per post, dated from Tuesday on) waits for approval, written straight to the database.
 */
export async function seedMetaPlan(
  h: Harness,
  options: SeedMetaPlanOptions = {},
): Promise<SeededMetaPlan> {
  const db = testDb();
  const types: PostType[] = options.types
    ? [...options.types]
    : Array.from({ length: options.postCount ?? 1 }, () => options.type ?? "STATIC");
  const postCount = types.length;
  const platforms = [...(options.platforms ?? ["INSTAGRAM", "FACEBOOK"])];
  const postMix = [...new Set(types)].map((type) => ({
    type,
    count: types.filter((other) => other === type).length,
  }));
  const admin = await createUser({ role: "ADMIN", name: "Salah" });
  const client = await createClient({
    name: "Qahwa Co",
    timezone: RIYADH,
    enabledPlatforms: platforms,
    bannedWords: options.bannedWords ?? [],
  });
  const day = (offset: number) =>
    new Date(h.clock.now().getTime() + offset * DAY_MS).toISOString().slice(0, 10);
  const brief: Brief = {
    clientId: client.id,
    title: "Iced Line",
    objective: "Drive trial of the iced line after iftar.",
    productFocus: "iced line",
    audience: "Young professionals in Riyadh",
    keyMessages: ["Cold brew, done properly."],
    platforms,
    postCount,
    postMix,
    window: { start: day(1), end: day(postCount + 14) },
    cadenceNotes: null,
    constraints: [],
    assumptions: [],
  };
  const posts = types.map((type, i) => ({
    ref: `p${i + 1}`,
    type,
    platforms,
    targetDate: day(options.sameTargetDate ? 1 : i + 1),
    angle: `Golden hour ${i + 1}: the iced line after iftar`,
    pillarHint: null,
  }));
  const plan: ManagerPlanOutput = {
    summary: `${postCount} posts (${postMix.map((mix) => `${mix.count} ${mix.type.toLowerCase()}`).join(", ")}) for ${platforms.join(" and ")}.`,
    posts,
    nodes: canonicalGraph(posts, h.deps.config.PIPELINE_ACTIONS),
  };
  const campaign = await db.campaign.create({
    data: {
      clientId: client.id,
      name: brief.title,
      status: "PLANNING",
      brief,
      briefLockedAt: h.clock.now(),
      createdById: admin.id,
      thread: { create: {} },
    },
    include: { thread: true },
  });
  const graph = await db.taskGraph.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      summary: plan.summary,
      graph: plan,
      estimate: estimatePlan(plan),
    },
  });
  return {
    admin,
    client,
    campaignId: campaign.id,
    threadId: campaign.thread!.id,
    graphId: graph.id,
    cookie: await sessionCookieFor(admin, { now: h.clock.now() }),
  };
}

/** JSON requests as the signed-in browser sends them; anything but 2xx throws. */
export function apiFor(h: Harness, cookie: string) {
  const headers = browserHeaders(cookie);
  return async <T>(method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
    const response = await h.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300) {
      throw new Error(`${method} ${url} → ${response.statusCode}: ${response.body}`);
    }
    return response.json<T>();
  };
}

export function waitForPostStatus(h: Harness, postId: string, status: Post["status"]) {
  return h.waitFor(async () => {
    const post = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    return post.status === status ? post : null;
  }, 45_000);
}

/** Approves the plan and waits for every post to reach approval; returns them by ref. */
export async function runToApproval(h: Harness, seeded: SeededMetaPlan): Promise<Post[]> {
  const api = apiFor(h, seeded.cookie);
  await api("POST", `/v1/task-graphs/${seeded.graphId}/approve`, {});
  const posts = await testDb().post.findMany({
    where: { campaignId: seeded.campaignId },
    orderBy: { ref: "asc" },
  });
  for (const post of posts) await waitForPostStatus(h, post.id, "PENDING_APPROVAL");
  return posts;
}

/** The post's latest approval round, approved through the API. */
export async function approvePost(h: Harness, seeded: SeededMetaPlan, postId: string) {
  const round = await testDb().approvalRequest.findFirstOrThrow({
    where: { postId, status: "PENDING" },
    orderBy: { round: "desc" },
  });
  await apiFor(h, seeded.cookie)("POST", `/v1/approvals/${round.id}/decision`, {
    decision: "APPROVE",
  });
  return round;
}

export type JobWithPlatform = PublishJob & { variant: { postId: string; platform: Platform } };

/** The post's publish jobs by platform. */
export async function jobsOf(postId: string): Promise<Record<string, JobWithPlatform>> {
  const jobs = await testDb().publishJob.findMany({
    where: { variant: { postId } },
    include: { variant: { select: { postId: true, platform: true } } },
  });
  return Object.fromEntries(jobs.map((job) => [job.platform, job]));
}

/** Waits until every listed job of the post is in `status`. */
export function waitForJobs(
  h: Harness,
  postId: string,
  status: PublishJob["status"],
  platforms: readonly Platform[] = ["INSTAGRAM", "FACEBOOK"],
) {
  return h.waitFor(async () => {
    const jobs = await jobsOf(postId);
    return platforms.every((platform) => jobs[platform]?.status === status) ? jobs : null;
  }, 45_000);
}

/**
 * The fake Graph's first Page and its Instagram account, connected as the client's accounts it
 * publishes through (each the client's only one on its platform, so its publishing account).
 */
export async function connectMetaAccounts(
  h: Harness,
  client: Client,
  overrides: Partial<
    Pick<SocialAccount, "tokenExpiresAt" | "status" | "scopes" | "isPrimary">
  > = {},
): Promise<{ instagram: SocialAccount; facebook: SocialAccount; token: string }> {
  const page = FAKE_META_PAGES[0]!;
  const ig = page.instagram!;
  const token = page.accessToken;
  const common = {
    clientId: client.id,
    accessTokenEnc: h.deps.tokenCipher.encrypt(token),
    status: "ACTIVE" as const,
    isPrimary: true,
    ...overrides,
  };
  const facebook = await testDb().socialAccount.create({
    data: {
      ...common,
      platform: "FACEBOOK",
      externalId: page.id,
      handle: page.name,
      displayName: page.name,
      meta: { pageId: page.id, pageName: page.name, source: "oauth" },
    },
  });
  const instagram = await testDb().socialAccount.create({
    data: {
      ...common,
      platform: "INSTAGRAM",
      externalId: ig.id,
      handle: ig.username,
      displayName: ig.username,
      meta: {
        pageId: page.id,
        pageName: page.name,
        igUserId: ig.id,
        username: ig.username,
        source: "oauth",
      },
    },
  });
  return { instagram, facebook, token };
}

/** Moves the FakeClock to `iso` and runs tick.publish, as the minutely scheduler would. */
export async function tickAt(h: Harness, iso: string): Promise<void> {
  h.clock.set(iso);
  await h.runTick("tick.publish");
}

/** Realtime rows of one type, oldest first, with their payloads. */
export async function eventsOfType<T>(type: string): Promise<T[]> {
  const rows = await testDb().realtimeEvent.findMany({ where: { type }, orderBy: { id: "asc" } });
  return rows.map((row) => row.payload as T);
}

/** The Publisher's signed notes in the thread, oldest first. */
export async function publisherNotes(threadId: string): Promise<string[]> {
  const messages = await testDb().chatMessage.findMany({
    where: { threadId, agent: "PUBLISHER" },
    orderBy: { createdAt: "asc" },
  });
  return messages.map((message) => message.content);
}

export function expectSameInstant(actual: Date | string | null | undefined, expected: string) {
  expect(actual === null || actual === undefined ? null : new Date(actual).toISOString()).toBe(
    expected,
  );
}
