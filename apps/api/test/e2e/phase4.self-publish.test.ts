import { DryRunPublisher, MetaPublisher } from "@enmo/providers";
import {
  AssetParams,
  compareShotPosition,
  CopywriterOutput,
  PublisherInput,
  publishedCaption,
  type AlertPayload,
  type PostDto,
  type PublishJobDto,
  type PublishUpdatedPayload,
} from "@enmo/shared";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { DAY_MS, FakeClock } from "../../src/lib/clock";
import { currentContentHash } from "../../src/orchestrator/approval-round";
import { PUBLISH_CANCEL_REASONS } from "../../src/orchestrator/publishing";
import { testDb } from "../helpers/db";
import { startHarness, type Harness, type HarnessOptions } from "../helpers/harness";
import { FAKE_META_PAGES, GRAPH_ERRORS, startFakeGraph, type FakeGraph } from "../fakes/meta-graph";
import {
  apiFor,
  approvePost,
  connectMetaAccounts,
  eventsOfType,
  expectSameInstant,
  FB_TUESDAY_0900,
  IG_TUESDAY_1100,
  jobsOf,
  NOW,
  publisherNotes,
  runToApproval,
  seedMetaPlan,
  THURSDAY,
  tickAt,
  TUESDAY,
  waitForJobs,
  waitForPostStatus,
  WEDNESDAY,
} from "./phase4.fixtures";

/*
 * Phase 4 exit test "an approved post publishes itself to Instagram and Facebook" (DESIGN
 * "Phase 4", phase4.self-publish), on the harness with MockLlm, MockProvider and LocalStorage:
 *   (a) approve → the Publisher picks each variant's slot among the optimizer's candidates (best
 *       times in the client's own time zone) → SCHEDULED; the FakeClock reaches each slot and
 *       tick.publish sends it through the dry-run publisher → PUBLISHED with its live URL and
 *       publishedAt → the post LIVE once both are out;
 *   (b) the same flow in PUBLISH_MODE=live through the real MetaPublisher against the fake Graph
 *       server, asserting the exact Graph call sequence of every Meta flow: Instagram image,
 *       reel (polled while processing, resumed on its persisted container after an outage),
 *       carousel and story; Facebook photo, reel (rupload), multi-photo and photo story;
 *   (c) an edit after approval cancels the scheduled jobs and reopens approval; the re-approval
 *       schedules the same job rows again with the edited caption;
 *   (d) a calendar drag moves a job to the best free hour of the new day.
 */

let harness: Harness | undefined;
let graph: FakeGraph | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await graph?.close();
  graph = undefined;
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness({ clock: new FakeClock(NOW), ...options });
  return harness;
}

/**
 * The JPEG Instagram fetches instead of a 9:16 PNG master (publishing/renditions.ts): 4:5 for the
 * feed, whole for a story. Checks the file is in storage as that, and answers its public URL.
 */
async function instagramFrame(
  h: Harness,
  masterKey: string | null,
  size: { width: number; height: number } = { width: 1080, height: 1350 },
): Promise<string> {
  const key = masterKey!.replace(/\.png$/, `-instagram-${size.width}x${size.height}.jpg`);
  const stored = await h.deps.storage.get(key);
  expect(stored, key).not.toBeNull();
  expect(await sharp(stored!.body).metadata()).toMatchObject({ format: "jpeg", ...size });
  return h.deps.storage.publicUrl(key);
}

describe("phase4.self-publish", () => {
  it("(a) schedules an approved post at its best slots and publishes it as a dry run", async () => {
    const h = await start();
    expect(h.deps.publishers.INSTAGRAM).toBeInstanceOf(DryRunPublisher);
    const seeded = await seedMetaPlan(h);
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    const round = await approvePost(h, seeded, postId);

    // Scheduled by the Publisher among the optimizer's candidates, one job per platform.
    await waitForPostStatus(h, postId, "SCHEDULED");
    const scheduled = await jobsOf(postId);
    expect(Object.keys(scheduled).sort()).toEqual(["FACEBOOK", "INSTAGRAM"]);
    for (const job of Object.values(scheduled)) {
      expect(job).toMatchObject({
        status: "SCHEDULED",
        slotSource: "publisher",
        dryRun: true,
        socialAccountId: null,
        attempts: 0,
      });
      expect(job.slotReason).toMatch(/^Top-scored slot: /);
    }
    // Tuesday (the plan's date) at each platform's first peak hour in Riyadh.
    expectSameInstant(scheduled.FACEBOOK!.scheduledFor, FB_TUESDAY_0900);
    expectSameInstant(scheduled.INSTAGRAM!.scheduledFor, IG_TUESDAY_1100);

    const db = testDb();
    const variants = await db.postVariant.findMany({
      where: { postId },
      orderBy: { platform: "asc" },
    });
    expect(variants.map((variant) => [variant.platform, variant.format])).toEqual([
      ["INSTAGRAM", "PORTRAIT_4_5"],
      ["FACEBOOK", "SQUARE_1_1"],
    ]);
    // The approval now covers the variants the Publisher derived from the approved copy.
    const approved = await db.approvalRequest.findUniqueOrThrow({ where: { id: round.id } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.contentHash).toBe(await currentContentHash(db, postId));

    // The Publisher saw each variant's candidates, best first, in the client's time zone.
    const run = await db.agentRun.findFirstOrThrow({
      where: { agent: "PUBLISHER", action: "schedule", outcome: "OK" },
    });
    const input = PublisherInput.parse(run.inputSnapshot);
    expect(input).toMatchObject({ timezone: "Asia/Riyadh", campaign: { name: "Iced Line" } });
    for (const item of input.items) {
      expect(item.targetDate).toBe(TUESDAY);
      expect(item.candidates.length).toBeGreaterThan(1);
      expect(item.candidates.length).toBeLessThanOrEqual(5);
      // Every candidate keeps the rules: in the window, at least 30 minutes out, best first.
      for (const candidate of item.candidates) {
        expect(Date.parse(candidate.slotStart) - Date.parse(NOW)).toBeGreaterThanOrEqual(
          30 * 60_000,
        );
        const { start, end } = input.campaign.window;
        expect(Date.parse(candidate.slotStart)).toBeGreaterThanOrEqual(
          Date.parse(`${start}T00:00:00+03:00`),
        );
        expect(Date.parse(candidate.slotStart)).toBeLessThan(
          Date.parse(`${end}T00:00:00+03:00`) + DAY_MS,
        );
      }
      const scores = item.candidates.map((candidate) => candidate.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      // The job sits on the candidate the Publisher picked: the top one, a peak hour.
      const job = Object.values(scheduled).find((entry) => entry.variantId === item.variantId)!;
      expectSameInstant(job.scheduledFor, item.candidates[0]!.slotStart);
      expect(item.candidates[0]!.reasons[0]).toMatch(/peak hour: Tue \d{2}:00 Asia\/Riyadh/);
    }
    const [scheduleNote] = await publisherNotes(seeded.threadId);
    expect(scheduleNote).toContain("Scheduled p1 (Asia/Riyadh):");
    expect(scheduleNote).toContain("- Facebook: Tue 2 Mar 09:00 [dry run].");
    expect(scheduleNote).toContain("- Instagram: Tue 2 Mar 11:00 [dry run].");

    const api = apiFor(h, seeded.cookie);
    const dto = await api<PostDto>("GET", `/v1/posts/${postId}`);
    expect(dto.publishing.map((entry) => [entry.platform, entry.status])).toEqual([
      ["INSTAGRAM", "SCHEDULED"],
      ["FACEBOOK", "SCHEDULED"],
    ]);

    // Nothing goes out before its slot.
    await tickAt(h, "2027-03-02T05:59:00.000Z");
    expect((await jobsOf(postId)).FACEBOOK!.status).toBe("SCHEDULED");

    // Facebook's slot: that variant goes out, Instagram's still waits.
    await tickAt(h, FB_TUESDAY_0900);
    await waitForJobs(h, postId, "PUBLISHED", ["FACEBOOK"]);
    const partly = await waitForPostStatus(h, postId, "PUBLISHING");
    expect(partly.liveAt).toBeNull();
    expect((await jobsOf(postId)).INSTAGRAM!.status).toBe("SCHEDULED");

    await tickAt(h, IG_TUESDAY_1100);
    const live = await waitForPostStatus(h, postId, "LIVE");
    const published = await jobsOf(postId);
    for (const [platform, job] of Object.entries(published)) {
      const variant = variants.find((candidate) => candidate.platform === platform)!;
      expect(job).toMatchObject({
        status: "PUBLISHED",
        attempts: 1,
        externalId: `dryrun_${variant.id}`,
        liveUrl: `https://dryrun.enmo.marketing/${platform.toLowerCase()}/${variant.id}`,
        lastError: null,
      });
    }
    expectSameInstant(published.FACEBOOK!.publishedAt, FB_TUESDAY_0900);
    expectSameInstant(published.INSTAGRAM!.publishedAt, IG_TUESDAY_1100);
    expectSameInstant(live.liveAt, IG_TUESDAY_1100);
    expect(live.needsAttention).toBe(false);
    // The dry run wrote the JPEG a live Instagram publish would hand Meta.
    const [master] = await db.asset.findMany({ where: { postId, isCurrent: true } });
    await instagramFrame(h, master!.storageKey);

    // Events go out just after the commit the wait above saw: wait for the last of them.
    const postStatuses = await h.waitFor(async () => {
      const statuses = (await eventsOfType<{ postId: string; status: string }>("post.updated"))
        .filter((event) => event.postId === postId)
        .map((event) => event.status);
      return statuses.at(-1) === "LIVE" ? statuses : null;
    });
    expect(postStatuses.slice(-4)).toEqual(["APPROVED", "SCHEDULED", "PUBLISHING", "LIVE"]);
    const updates = await eventsOfType<PublishUpdatedPayload>("publish.updated");
    expect(
      updates.filter((update) => update.platform === "INSTAGRAM").map((update) => update.status),
    ).toEqual(["SCHEDULED", "QUEUED", "PUBLISHING", "PUBLISHED"]);
    expect(await eventsOfType<AlertPayload>("alert")).toEqual([]);

    const notes = await publisherNotes(seeded.threadId);
    expect(notes.at(-1)).toBe(
      [
        "p1 is live.",
        `Instagram: ${published.INSTAGRAM!.liveUrl} (dry run)`,
        `Facebook: ${published.FACEBOOK!.liveUrl} (dry run)`,
      ].join("\n"),
    );
    const final = await api<PostDto>("GET", `/v1/posts/${postId}`);
    expect(final.status).toBe("LIVE");
    expect(final.publishing.every((entry) => entry.status === "PUBLISHED" && entry.liveUrl)).toBe(
      true,
    );

    // A late duplicate tick or run changes nothing.
    await h.runTick("tick.publish");
    expect((await testDb().post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("LIVE");
  }, 90_000);

  it("(b) publishes live through the Meta Graph API with the exact call sequence", async () => {
    graph = await startFakeGraph();
    const h = await start({ publishMode: "live", metaBaseUrl: graph.url });
    expect(h.deps.publishers.INSTAGRAM).toBeInstanceOf(MetaPublisher);
    const seeded = await seedMetaPlan(h);
    const accounts = await connectMetaAccounts(h, seeded.client);
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    await approvePost(h, seeded, postId);
    await waitForPostStatus(h, postId, "SCHEDULED");
    const scheduled = await jobsOf(postId);
    expect(scheduled.INSTAGRAM).toMatchObject({
      dryRun: false,
      socialAccountId: accounts.instagram.id,
    });
    expect(scheduled.FACEBOOK).toMatchObject({
      dryRun: false,
      socialAccountId: accounts.facebook.id,
    });
    expectSameInstant(scheduled.FACEBOOK!.scheduledFor, FB_TUESDAY_0900);
    expectSameInstant(scheduled.INSTAGRAM!.scheduledFor, IG_TUESDAY_1100);
    // Scheduling never talks to the platform.
    expect(graph.calls).toEqual([]);

    const page = FAKE_META_PAGES[0]!;
    const igUserId = page.instagram!.id;
    const variants = await testDb().postVariant.findMany({ where: { postId } });
    const variantOf = (platform: string) => variants.find((v) => v.platform === platform)!;
    const [take] = await testDb().asset.findMany({ where: { postId, isCurrent: true } });

    // Facebook's slot: one photo post on the Page.
    await tickAt(h, FB_TUESDAY_0900);
    await waitForJobs(h, postId, "PUBLISHED", ["FACEBOOK"]);
    const [fbPost] = [...graph.state.posts.values()];
    expect(graph.sequence()).toEqual([`POST /v26.0/${page.id}/photos`, `GET /v26.0/${fbPost!.id}`]);
    const facebook = variantOf("FACEBOOK");
    expect(graph.calls[0]!.body).toMatchObject({
      url: take!.url,
      message: publishedCaption(facebook.caption, facebook.hashtags),
    });
    expect((await jobsOf(postId)).FACEBOOK).toMatchObject({
      externalId: fbPost!.id,
      liveUrl: fbPost!.permalink,
      attempts: 1,
    });

    // Instagram's slot: quota, container, its status, media_publish, the permalink.
    graph.reset();
    await tickAt(h, IG_TUESDAY_1100);
    const live = await waitForPostStatus(h, postId, "LIVE");
    const [container] = [...graph.state.containers.values()];
    const [media] = [...graph.state.media.values()];
    expect(graph.sequence()).toEqual([
      `GET /v26.0/${igUserId}/content_publishing_limit`,
      `POST /v26.0/${igUserId}/media`,
      `GET /v26.0/${container!.id}`,
      `POST /v26.0/${igUserId}/media_publish`,
      `GET /v26.0/${media!.id}`,
    ]);
    const instagram = variantOf("INSTAGRAM");
    // Not the 9:16 PNG master: Instagram fetches a 4:5 JPEG cut from it.
    expect(container!.params).toMatchObject({
      image_url: await instagramFrame(h, take!.storageKey),
      caption: publishedCaption(instagram.caption, instagram.hashtags),
    });
    const published = await jobsOf(postId);
    expect(published.INSTAGRAM).toMatchObject({
      status: "PUBLISHED",
      externalId: media!.id,
      liveUrl: media!.permalink,
    });
    // The container was persisted as soon as it existed, for a retry to resume.
    expect(published.INSTAGRAM!.containerId).toContain(container!.id);
    expectSameInstant(live.liveAt, IG_TUESDAY_1100);
    const notes = await publisherNotes(seeded.threadId);
    expect(notes.at(-1)).toBe(
      ["p1 is live.", `Instagram: ${media!.permalink}`, `Facebook: ${fbPost!.permalink}`].join(
        "\n",
      ),
    );
  }, 90_000);

  it("(b) publishes a reel, a carousel and a story live, each through its own Graph flow", async () => {
    graph = await startFakeGraph();
    const h = await start({
      publishMode: "live",
      metaBaseUrl: graph.url,
      env: { PUBLISH_POLL_INTERVAL_SEC: "1" },
    });
    const seeded = await seedMetaPlan(h, { types: ["REEL", "CAROUSEL", "STORY"] });
    await connectMetaAccounts(h, seeded.client);
    const posts = await runToApproval(h, seeded);
    const [reel, carousel, story] = posts.map((post) => post.id);
    for (const post of posts) await approvePost(h, seeded, post.id);
    for (const post of posts) await waitForPostStatus(h, post.id, "SCHEDULED");
    expect(graph.calls).toEqual([]);

    const page = FAKE_META_PAGES[0]!;
    const ig = page.instagram!.id;
    const V = "/v26.0";
    // The post's current takes in reading order (scenes, slides), as the payload lists them.
    const takesOf = async (postId: string) => {
      const takes = await testDb().asset.findMany({ where: { postId, isCurrent: true } });
      const placed = takes.map((take) => {
        const { shot } = AssetParams.parse(take.params);
        return {
          url: take.url,
          storageKey: take.storageKey,
          at: {
            shotId: take.shotId,
            sceneIndex: shot?.sceneIndex ?? take.sceneIndex,
            slideIndex: shot?.slideIndex ?? null,
          },
        };
      });
      return placed.sort((a, b) => compareShotPosition(a.at, b.at));
    };
    // Each post goes out on its plan's day, Facebook at 09:00 and Instagram at 11:00 in Riyadh.
    const slot = (day: string, hour: "09" | "11") =>
      new Date(`${day}T${hour}:00:00+03:00`).toISOString();

    // p1, the reel, on Facebook: video_reels start → rupload pulls file_url → finish → status.
    await tickAt(h, slot(TUESDAY, "09"));
    await waitForJobs(h, reel!, "PUBLISHED", ["FACEBOOK"]);
    const [fbReel] = [...graph.state.videos.values()];
    expect(graph.sequence()).toEqual([
      `POST ${V}/${page.id}/video_reels`,
      `POST /video-upload/v26.0/${fbReel!.id}`,
      `POST ${V}/${page.id}/video_reels`,
      `GET ${V}/${fbReel!.id}`,
    ]);
    const reelTake = (await takesOf(reel!))[0]!.url;
    expect(graph.calls[1]!.headers.file_url).toBe(reelTake);
    expect(graph.calls[2]!.body).toMatchObject({
      upload_phase: "finish",
      video_state: "PUBLISHED",
    });

    // On Instagram: the REELS container is still processing at first, and media_publish meets an
    // outage once. publish.poll carries on with the persisted container and never makes another.
    graph.reset();
    graph.state.containerPolls = 1;
    graph.failNext({
      match: /^POST \/v26\.0\/\d+\/media_publish$/,
      status: 500,
      error: GRAPH_ERRORS.unavailable,
    });
    await tickAt(h, slot(TUESDAY, "11"));
    await waitForPostStatus(h, reel!, "LIVE");
    const [reelContainer] = [...graph.state.containers.values()];
    const [reelMedia] = [...graph.state.media.values()];
    expect(graph.sequence()).toEqual([
      `GET ${V}/${ig}/content_publishing_limit`,
      `POST ${V}/${ig}/media`,
      `GET ${V}/${reelContainer!.id}`,
      `GET ${V}/${reelContainer!.id}`,
      `POST ${V}/${ig}/media_publish`,
      `GET ${V}/${reelContainer!.id}`,
      `POST ${V}/${ig}/media_publish`,
      `GET ${V}/${reelMedia!.id}`,
    ]);
    expect(graph.state.containers.size).toBe(1);
    expect(reelContainer!.params).toMatchObject({
      media_type: "REELS",
      video_url: reelTake,
      share_to_feed: true,
    });
    expect((await jobsOf(reel!)).INSTAGRAM).toMatchObject({
      status: "PUBLISHED",
      attempts: 1,
      externalId: reelMedia!.id,
      liveUrl: reelMedia!.permalink,
    });
    expect((await jobsOf(reel!)).INSTAGRAM!.containerId).toContain(reelContainer!.id);

    // p2, the carousel, on Facebook: its slides uploaded unpublished, then one feed post.
    graph.reset();
    const slides = await takesOf(carousel!);
    expect(slides.length).toBeGreaterThanOrEqual(2);
    await tickAt(h, slot(WEDNESDAY, "09"));
    await waitForJobs(h, carousel!, "PUBLISHED", ["FACEBOOK"]);
    const [feedPost] = [...graph.state.posts.values()];
    expect(graph.sequence()).toEqual([
      ...slides.map(() => `POST ${V}/${page.id}/photos`),
      `POST ${V}/${page.id}/feed`,
      `GET ${V}/${feedPost!.id}`,
    ]);
    expect(feedPost).toMatchObject({ kind: "feed", photoIds: [...graph.state.photos.keys()] });

    // On Instagram: one child container per slide, each checked, then the CAROUSEL parent.
    graph.reset();
    await tickAt(h, slot(WEDNESDAY, "11"));
    await waitForPostStatus(h, carousel!, "LIVE");
    const containers = [...graph.state.containers.values()];
    const children = containers.filter((container) => container.isCarouselItem);
    const parent = containers.find((container) => container.mediaType === "CAROUSEL")!;
    const [carouselMedia] = [...graph.state.media.values()];
    expect(children).toHaveLength(slides.length);
    expect(graph.sequence()).toEqual([
      `GET ${V}/${ig}/content_publishing_limit`,
      ...children.map(() => `POST ${V}/${ig}/media`),
      ...children.map((child) => `GET ${V}/${child.id}`),
      `POST ${V}/${ig}/media`,
      `GET ${V}/${parent.id}`,
      `POST ${V}/${ig}/media_publish`,
      `GET ${V}/${carouselMedia!.id}`,
    ]);
    const frames: string[] = [];
    for (const slide of slides) frames.push(await instagramFrame(h, slide.storageKey));
    expect(children.map((child) => child.params)).toEqual(
      frames.map((url) => ({ image_url: url, is_carousel_item: true })),
    );
    expect(parent.children).toEqual(children.map((child) => child.id));

    // p3, the story, on Facebook: an unpublished photo, then photo_stories.
    graph.reset();
    const [storyTake] = await takesOf(story!);
    await tickAt(h, slot(THURSDAY, "09"));
    await waitForJobs(h, story!, "PUBLISHED", ["FACEBOOK"]);
    const [fbStory] = [...graph.state.posts.values()];
    expect(graph.sequence()).toEqual([
      `POST ${V}/${page.id}/photos`,
      `POST ${V}/${page.id}/photo_stories`,
      `GET ${V}/${fbStory!.id}`,
    ]);
    expect(fbStory!.kind).toBe("photo_story");

    // On Instagram: a STORIES container without a caption.
    graph.reset();
    await tickAt(h, slot(THURSDAY, "11"));
    await waitForPostStatus(h, story!, "LIVE");
    const [storyContainer] = [...graph.state.containers.values()];
    const [storyMedia] = [...graph.state.media.values()];
    expect(graph.sequence()).toEqual([
      `GET ${V}/${ig}/content_publishing_limit`,
      `POST ${V}/${ig}/media`,
      `GET ${V}/${storyContainer!.id}`,
      `POST ${V}/${ig}/media_publish`,
      `GET ${V}/${storyMedia!.id}`,
    ]);
    expect(storyContainer!.params).toEqual({
      media_type: "STORIES",
      image_url: await instagramFrame(h, storyTake!.storageKey, { width: 1080, height: 1920 }),
    });
  }, 90_000);

  it("(c) an edit after approval cancels the scheduled jobs; re-approval reschedules the same rows", async () => {
    const h = await start();
    const seeded = await seedMetaPlan(h);
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    await approvePost(h, seeded, postId);
    await waitForPostStatus(h, postId, "SCHEDULED");
    const before = await jobsOf(postId);

    const api = apiFor(h, seeded.cookie);
    const current = await api<PostDto>("GET", `/v1/posts/${postId}`);
    const copy = CopywriterOutput.parse(current.copy);
    const edited: CopywriterOutput = {
      ...copy,
      caption: "Edited after approval: cold brew, after iftar.",
      platformCaptions: copy.platformCaptions.map((entry) => ({
        ...entry,
        caption: `Edited for ${entry.platform}: cold brew, after iftar.`,
      })),
    };
    await api("PATCH", `/v1/posts/${postId}/copy`, { copy: edited });

    const cancelled = await jobsOf(postId);
    for (const platform of ["INSTAGRAM", "FACEBOOK"]) {
      expect(cancelled[platform]).toMatchObject({
        id: before[platform]!.id,
        status: "CANCELLED",
        lastError: PUBLISH_CANCEL_REASONS.copyEdited,
      });
    }
    const reopened = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    expect(reopened).toMatchObject({ status: "PENDING_APPROVAL", approvedAt: null });
    const rounds = await testDb().approvalRequest.findMany({
      where: { postId },
      orderBy: { round: "asc" },
    });
    expect(rounds.map((round) => round.status)).toEqual(["CANCELLED", "PENDING"]);

    // The slot comes and goes: nothing is published without the new approval.
    await tickAt(h, IG_TUESDAY_1100);
    expect(Object.values(await jobsOf(postId)).map((job) => job.status)).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);

    // Re-approval: the same job rows, reset and scheduled again, the edited captions going out.
    // Their attempt count moves on rather than back to 0, so no run reuses an earlier one's id.
    h.clock.set(NOW);
    await approvePost(h, seeded, postId);
    await waitForPostStatus(h, postId, "SCHEDULED");
    const again = await jobsOf(postId);
    for (const platform of ["INSTAGRAM", "FACEBOOK"]) {
      expect(again[platform]).toMatchObject({
        id: before[platform]!.id,
        status: "SCHEDULED",
        attempts: before[platform]!.attempts + 1,
        lastError: null,
        liveUrl: null,
      });
    }
    expect(await testDb().publishJob.count()).toBe(2);
    const variants = await testDb().postVariant.findMany({ where: { postId } });
    expect(variants.map((variant) => variant.caption).sort()).toEqual([
      "Edited for FACEBOOK: cold brew, after iftar.",
      "Edited for INSTAGRAM: cold brew, after iftar.",
    ]);
    const roundTwo = await testDb().approvalRequest.findFirstOrThrow({
      where: { postId, round: 2 },
    });
    expect(roundTwo.contentHash).toBe(await currentContentHash(testDb(), postId));

    await tickAt(h, FB_TUESDAY_0900);
    await tickAt(h, IG_TUESDAY_1100);
    await waitForPostStatus(h, postId, "LIVE");
    for (const job of Object.values(await jobsOf(postId))) {
      expect(job).toMatchObject({ status: "PUBLISHED", attempts: 2 });
    }
  }, 90_000);

  it("(d) a calendar drag moves the job to the best free hour of the new day", async () => {
    const h = await start();
    const seeded = await seedMetaPlan(h);
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    await approvePost(h, seeded, postId);
    await waitForPostStatus(h, postId, "SCHEDULED");
    const { INSTAGRAM: job } = await jobsOf(postId);

    // Thursday 4 March: Instagram's first peak there, 11:00 in Riyadh.
    const moved = await apiFor(h, seeded.cookie)<PublishJobDto>(
      "PATCH",
      `/v1/publish-jobs/${job!.id}`,
      { date: "2027-03-04" },
    );
    expect(moved).toMatchObject({
      id: job!.id,
      status: "SCHEDULED",
      date: "2027-03-04",
      slotSource: "manual",
      scheduledFor: "2027-03-04T08:00:00.000Z",
    });
    await tickAt(h, IG_TUESDAY_1100);
    expect((await jobsOf(postId)).INSTAGRAM!.status).toBe("SCHEDULED");
    await tickAt(h, "2027-03-04T08:00:00.000Z");
    await waitForPostStatus(h, postId, "LIVE");
  }, 90_000);
});
