import type { Client } from "@enmo/db";
import {
  calendarGhostId,
  type CalendarGhostItem,
  type CalendarItemDto,
  type CalendarJobItem,
  type CalendarResponse,
} from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor, type CookieHeader } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createAsset, createClient, createUser, type TestUser } from "../helpers/factories";
import { RIYADH, seedPublishPost } from "../helpers/publish-fixtures";
import { sender } from "../helpers/route-fixtures";

/*
 * GET /v1/calendar (DESIGN §E "calendar", §G MonthGrid): every client's publish jobs on the range's
 * client-local days, plus ghost slots for planned posts' platforms with no job yet, each with its
 * post's first current take as the thumbnail.
 */

/** UTC-10 all year, so its days start 13 hours after Riyadh's. */
const HONOLULU = "Pacific/Honolulu";

let t: TestApp;
let admin: TestUser;
let editorCookie: CookieHeader;
let riyadh: Client;
let honolulu: Client;
const send = sender(() => t.app);

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  t.clock.set("2027-02-20T06:00:00.000Z");
  admin = await createUser({ role: "ADMIN" });
  const editor = await createUser({ role: "EDITOR" });
  editorCookie = await sessionCookieFor(editor, { now: t.clock.now() });
  riyadh = await createClient({ name: "Qahwa Co", timezone: RIYADH });
  honolulu = await createClient({ name: "Aloha Brew", timezone: HONOLULU });
});

async function calendar(query: string, cookie = editorCookie): Promise<CalendarResponse> {
  const response = await send("GET", `/v1/calendar?${query}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CalendarResponse>();
}

const jobsOf = (items: CalendarItemDto[]) =>
  items.filter((item): item is CalendarJobItem => item.kind === "job");
const ghostsOf = (items: CalendarItemDto[]) =>
  items.filter((item): item is CalendarGhostItem => item.kind === "ghost");

describe("GET /v1/calendar", () => {
  it("places each job on its client's local day", async () => {
    // 01:30 on Tuesday 2 March in Riyadh, still Monday evening in UTC.
    const late = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      targetDate: null,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-01T22:30:00.000Z" }],
    });
    // 22:00 on Monday 1 March in Honolulu, already Tuesday in UTC.
    const early = await seedPublishPost({
      createdBy: admin,
      client: honolulu,
      targetDate: null,
      jobs: [{ platform: "FACEBOOK", scheduledFor: "2027-03-02T08:00:00.000Z" }],
    });

    const tuesday = await calendar("from=2027-03-02&to=2027-03-02");
    expect(tuesday.items).toEqual([
      expect.objectContaining({
        kind: "job",
        id: late.jobs.INSTAGRAM!.id,
        date: "2027-03-02",
        timezone: RIYADH,
        clientName: "Qahwa Co",
      }),
    ]);
    const monday = await calendar("from=2027-03-01&to=2027-03-01");
    expect(monday.items).toEqual([
      expect.objectContaining({
        kind: "job",
        id: early.jobs.FACEBOOK!.id,
        date: "2027-03-01",
        timezone: HONOLULU,
      }),
    ]);
    expect(monday).toMatchObject({ from: "2027-03-01", to: "2027-03-01" });
  });

  it("describes a job fully", async () => {
    const { jobs, post, variants, campaignId } = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      status: "LIVE",
      targetDate: null,
      jobs: [
        {
          platform: "INSTAGRAM",
          status: "PUBLISHED",
          scheduledFor: "2027-03-02T08:00:00.000Z",
          publishedAt: new Date("2027-03-02T08:00:05.000Z"),
          liveUrl: "https://dryrun.enmo.marketing/instagram/v1",
          attempts: 1,
        },
      ],
    });
    const [item] = (await calendar("from=2027-03-01&to=2027-03-31")).items;
    expect(item).toEqual({
      kind: "job",
      id: jobs.INSTAGRAM!.id,
      variantId: variants.INSTAGRAM!.id,
      postId: post.id,
      campaignId,
      clientId: riyadh.id,
      clientName: "Qahwa Co",
      platform: "INSTAGRAM",
      postType: "STATIC",
      date: "2027-03-02",
      timezone: RIYADH,
      title: "Iced, after iftar",
      thumbUrl: null,
      status: "PUBLISHED",
      scheduledFor: "2027-03-02T08:00:00.000Z",
      publishedAt: "2027-03-02T08:00:05.000Z",
      liveUrl: "https://dryrun.enmo.marketing/instagram/v1",
      dryRun: true,
      slotSource: "publisher",
      slotReason: "Seeded by the test",
      lastError: null,
    });
  });

  it("adds a ghost for each planned platform without a job that counts", async () => {
    const { post, jobs } = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      status: "SCHEDULED",
      targetDate: "2027-03-02",
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-02T08:00:00.000Z" }],
    });
    const { items } = await calendar("from=2027-03-01&to=2027-03-07");
    expect(jobsOf(items).map((item) => item.id)).toEqual([jobs.INSTAGRAM!.id]);
    expect(ghostsOf(items)).toEqual([
      {
        kind: "ghost",
        id: calendarGhostId(post.id, "FACEBOOK"),
        postId: post.id,
        campaignId: post.campaignId,
        clientId: riyadh.id,
        clientName: "Qahwa Co",
        platform: "FACEBOOK",
        postType: "STATIC",
        date: "2027-03-02",
        timezone: RIYADH,
        title: "Iced, after iftar",
        thumbUrl: null,
        postStatus: "SCHEDULED",
      },
    ]);
  });

  it("shows a planned post with a cancelled job as a ghost again", async () => {
    const { post, jobs } = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      status: "APPROVED",
      platforms: ["INSTAGRAM"],
      targetDate: "2027-03-02",
      jobs: [
        { platform: "INSTAGRAM", status: "CANCELLED", scheduledFor: "2027-03-03T08:00:00.000Z" },
      ],
    });
    const { items } = await calendar("from=2027-03-01&to=2027-03-07");
    expect(items.map((item) => item.id)).toEqual([calendarGhostId(post.id, "INSTAGRAM")]);
    expect(items.map((item) => item.id)).not.toContain(jobs.INSTAGRAM!.id);
  });

  it("leaves out ghosts of archived campaigns and clients, and platforms that can't take the post", async () => {
    const archivedCampaign = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      status: "APPROVED",
      targetDate: "2027-03-02",
    });
    await testDb().campaign.update({
      where: { id: archivedCampaign.campaignId },
      data: { status: "ARCHIVED" },
    });
    const gone = await createClient({ name: "Gone Co", timezone: RIYADH });
    await seedPublishPost({
      createdBy: admin,
      client: gone,
      status: "APPROVED",
      targetDate: "2027-03-02",
    });
    await testDb().client.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });
    // TikTok has no stories.
    const story = await seedPublishPost({
      createdBy: admin,
      client: honolulu,
      type: "STORY",
      platforms: ["INSTAGRAM", "TIKTOK"],
      status: "PENDING_APPROVAL",
      targetDate: "2027-03-03",
    });

    const { items } = await calendar("from=2027-03-01&to=2027-03-07");
    expect(items.map((item) => item.id)).toEqual([calendarGhostId(story.post.id, "INSTAGRAM")]);
  });

  it("filters by client", async () => {
    await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-02T08:00:00.000Z" }],
    });
    const aloha = await seedPublishPost({
      createdBy: admin,
      client: honolulu,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-02T21:00:00.000Z" }],
    });
    const { items } = await calendar(`from=2027-03-01&to=2027-03-07&clientId=${honolulu.id}`);
    expect(items.map((item) => [item.kind, item.clientId])).toEqual([
      ["job", honolulu.id],
      ["ghost", honolulu.id],
    ]);
    expect(items[0]?.id).toBe(aloha.jobs.INSTAGRAM!.id);
  });

  it("orders by day, a day's jobs by time before its ghosts", async () => {
    const first = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      ref: "p1",
      targetDate: "2027-03-03",
      platforms: ["INSTAGRAM"],
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-03T16:00:00.000Z" }],
    });
    const second = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      campaignId: first.campaignId,
      ref: "p2",
      targetDate: "2027-03-03",
      platforms: ["INSTAGRAM", "FACEBOOK"],
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-03T08:00:00.000Z" }],
    });
    const third = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      campaignId: first.campaignId,
      ref: "p3",
      status: "APPROVED",
      targetDate: "2027-03-02",
      platforms: ["FACEBOOK", "INSTAGRAM"],
    });

    const { items } = await calendar("from=2027-03-01&to=2027-03-07");
    expect(items.map((item) => item.id)).toEqual([
      calendarGhostId(third.post.id, "INSTAGRAM"),
      calendarGhostId(third.post.id, "FACEBOOK"),
      second.jobs.INSTAGRAM!.id,
      first.jobs.INSTAGRAM!.id,
      calendarGhostId(second.post.id, "FACEBOOK"),
    ]);
  });

  it("labels each item with the hook, else the angle, else the ref", async () => {
    const hooked = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      platforms: ["INSTAGRAM"],
    });
    const angled = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      campaignId: hooked.campaignId,
      ref: "p2",
      platforms: ["INSTAGRAM"],
      hook: null,
    });
    const bare = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      campaignId: hooked.campaignId,
      ref: "p3",
      platforms: ["INSTAGRAM"],
      hook: "  ",
      angle: null,
    });
    const { items } = await calendar("from=2027-03-02&to=2027-03-02");
    const titles = Object.fromEntries(items.map((item) => [item.postId, item.title]));
    expect(titles).toEqual({
      [hooked.post.id]: "Iced, after iftar",
      [angled.post.id]: "Golden hour",
      [bare.post.id]: "p3",
    });
  });

  it("shows the post's first ready take, the poster for a video", async () => {
    const photo = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      platforms: ["INSTAGRAM"],
    });
    await createAsset({ client: riyadh, postId: photo.post.id, shotId: "s2", sceneIndex: 1 });
    const first = await createAsset({
      client: riyadh,
      postId: photo.post.id,
      shotId: "s1",
      sceneIndex: 0,
    });
    await createAsset({
      client: riyadh,
      postId: photo.post.id,
      shotId: "s0",
      sceneIndex: 0,
      status: "RENDERING",
    });
    const video = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      campaignId: photo.campaignId,
      ref: "p2",
      type: "REEL",
      platforms: ["INSTAGRAM"],
    });
    const clip = await createAsset({ client: riyadh, postId: video.post.id, kind: "VIDEO" });
    await testDb().asset.update({
      where: { id: clip.id },
      data: { posterUrl: "https://files.enmo.test/poster.png" },
    });
    const pending = await seedPublishPost({
      createdBy: admin,
      client: riyadh,
      campaignId: photo.campaignId,
      ref: "p3",
      platforms: ["INSTAGRAM"],
    });

    const { items } = await calendar("from=2027-03-02&to=2027-03-02");
    const thumbs = Object.fromEntries(items.map((item) => [item.postId, item.thumbUrl]));
    expect(thumbs).toEqual({
      [photo.post.id]: first.url,
      [video.post.id]: "https://files.enmo.test/poster.png",
      [pending.post.id]: null,
    });
  });

  it("validates the range", async () => {
    const bad = async (query: string) =>
      (await send("GET", `/v1/calendar?${query}`, editorCookie)).statusCode;
    expect(await bad("from=2027-03-10&to=2027-03-01")).toBe(400);
    expect(await bad("from=2027-03-01&to=2027-05-02")).toBe(400);
    expect(await bad("from=2027-03-01")).toBe(400);
    expect(await bad("from=March&to=2027-03-02")).toBe(400);
    // 62 days, the most a request may span.
    await calendar("from=2027-03-01&to=2027-05-01");
  });

  it("answers 404 for an unknown client and 401 without a session", async () => {
    expect(
      (await send("GET", "/v1/calendar?from=2027-03-01&to=2027-03-31&clientId=nope", editorCookie))
        .statusCode,
    ).toBe(404);
    expect((await send("GET", "/v1/calendar?from=2027-03-01&to=2027-03-31")).statusCode).toBe(401);
  });
});
