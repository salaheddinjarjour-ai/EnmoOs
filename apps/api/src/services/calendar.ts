import type { DbClient, Prisma } from "@enmo/db";
import {
  AssetParams,
  calendarGhostId,
  compareShotPosition,
  Platform,
  platformVariantFormat,
  SlotSource,
  type CalendarGhostItem,
  type CalendarItemDto,
  type CalendarJobItem,
  type CalendarQuery,
  type CalendarResponse,
  type PublishStatus,
  type ShotPosition,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { calendarDay, DAY_MS } from "../lib/clock";
import { notFound } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { dateFromIsoDate, isoDate } from "../orchestrator/context";
import { refNumber } from "../orchestrator/progress";

/*
 * The calendar read model (DESIGN §E "calendar", §G MonthGrid). Each client's items sit on its own
 * calendar days: a job on the client-local day of its scheduledFor, a ghost (a planned post's
 * platform with no job yet) on the post's targetDate. A CANCELLED job doesn't hold its day: the
 * platform shows as a ghost again, since nothing will go out unless it is scheduled anew.
 */

/** Jobs that are (or were) really going out; a cancelled one leaves its platform unscheduled. */
const CALENDAR_JOB_STATUSES: readonly PublishStatus[] = [
  "SCHEDULED",
  "QUEUED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
];

/** The post fields every calendar item is labelled from. */
const POST_LABEL_SELECT = {
  id: true,
  ref: true,
  type: true,
  hook: true,
  angle: true,
  campaignId: true,
  clientId: true,
  client: { select: { name: true, timezone: true } },
} as const satisfies Prisma.PostSelect;

type LabelledPost = Prisma.PostGetPayload<{ select: typeof POST_LABEL_SELECT }>;

function titleOf(post: Pick<LabelledPost, "hook" | "angle" | "ref">): string {
  return post.hook?.trim() || post.angle?.trim() || post.ref;
}

function baseOf(post: LabelledPost, platform: Platform, date: string, thumbUrl: string | null) {
  return {
    postId: post.id,
    campaignId: post.campaignId,
    clientId: post.clientId,
    clientName: post.client.name,
    platform,
    postType: post.type,
    date,
    timezone: post.client.timezone,
    title: titleOf(post),
    thumbUrl,
  };
}

/** Each post's first ready current take, as the URL a cell shows (the poster for a video). */
async function thumbsOf(db: DbClient, postIds: readonly string[]): Promise<Map<string, string>> {
  if (postIds.length === 0) return new Map();
  const takes = await db.asset.findMany({
    where: {
      postId: { in: [...new Set(postIds)] },
      role: "SHOT",
      isCurrent: true,
      status: "READY",
      url: { not: null },
    },
    select: {
      id: true,
      postId: true,
      shotId: true,
      sceneIndex: true,
      params: true,
      url: true,
      posterUrl: true,
    },
  });
  const first = new Map<string, { position: ShotPosition; url: string | null }>();
  for (const take of takes) {
    if (!take.postId) continue;
    const params = parseStored(AssetParams, take.params, `Asset ${take.id}.params`);
    const position: ShotPosition = {
      shotId: take.shotId,
      sceneIndex: take.sceneIndex,
      slideIndex: params.shot?.slideIndex ?? null,
    };
    const best = first.get(take.postId);
    if (!best || compareShotPosition(position, best.position) < 0) {
      first.set(take.postId, { position, url: take.posterUrl ?? take.url });
    }
  }
  const thumbs = new Map<string, string>();
  for (const [postId, { url }] of first) if (url) thumbs.set(postId, url);
  return thumbs;
}

/**
 * Jobs whose scheduledFor falls on one of the range's days in their client's time zone. The query
 * widens the range by a day each side (every UTC offset fits in that), then each job is placed on
 * its client-local day.
 */
async function jobsInRange(db: DbClient, query: CalendarQuery) {
  const jobs = await db.publishJob.findMany({
    where: {
      status: { in: [...CALENDAR_JOB_STATUSES] },
      scheduledFor: {
        gte: new Date(dateFromIsoDate(query.from).getTime() - DAY_MS),
        lt: new Date(dateFromIsoDate(query.to).getTime() + 2 * DAY_MS),
      },
      ...(query.clientId ? { variant: { post: { clientId: query.clientId } } } : {}),
    },
    include: { variant: { select: { post: { select: POST_LABEL_SELECT } } } },
  });
  return jobs.flatMap((job) => {
    const date = calendarDay(job.scheduledFor, job.variant.post.client.timezone);
    return date < query.from || date > query.to ? [] : [{ job, date }];
  });
}

/** Posts planned inside the range, whose campaign and client aren't archived. */
function postsPlannedInRange(db: DbClient, query: CalendarQuery) {
  return db.post.findMany({
    where: {
      targetDate: { gte: dateFromIsoDate(query.from), lte: dateFromIsoDate(query.to) },
      campaign: { status: { not: "ARCHIVED" } },
      client: { archivedAt: null },
      ...(query.clientId ? { clientId: query.clientId } : {}),
    },
    select: {
      ...POST_LABEL_SELECT,
      status: true,
      platforms: true,
      targetDate: true,
      variants: { select: { platform: true, publishJob: { select: { status: true } } } },
    },
  });
}

type PlannedPost = Awaited<ReturnType<typeof postsPlannedInRange>>[number];

/** The post's platforms that take its type but have no job that counts, as ghost slots. */
function ghostsOf(post: PlannedPost, thumbUrl: string | null): CalendarGhostItem[] {
  if (!post.targetDate) return [];
  const date = isoDate(post.targetDate);
  return post.platforms.flatMap((platform) => {
    if (platformVariantFormat(post.type, platform) === null) return [];
    const job = post.variants.find((variant) => variant.platform === platform)?.publishJob;
    if (job && job.status !== "CANCELLED") return [];
    return [
      {
        ...baseOf(post, platform, date, thumbUrl),
        kind: "ghost" as const,
        id: calendarGhostId(post.id, platform),
        postStatus: post.status,
      },
    ];
  });
}

const PLATFORM_ORDER = new Map(Platform.options.map((platform, index) => [platform, index]));

/** An item with the post ref it sorts by (the DTO doesn't carry the ref). */
interface Placed {
  item: CalendarItemDto;
  ref: string;
}

/** By day; a day's jobs by time, then its ghosts; then client, post and platform. */
function compareItems({ item: a, ref: refA }: Placed, { item: b, ref: refB }: Placed): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "job" ? -1 : 1;
  if (a.kind === "job" && b.kind === "job" && a.scheduledFor !== b.scheduledFor) {
    return Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor);
  }
  return (
    a.clientName.localeCompare(b.clientName) ||
    a.campaignId.localeCompare(b.campaignId) ||
    refNumber(refA) - refNumber(refB) ||
    (PLATFORM_ORDER.get(a.platform) ?? 0) - (PLATFORM_ORDER.get(b.platform) ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/** GET /calendar. NOT_FOUND for an unknown `clientId`. */
export async function listCalendar(
  deps: Pick<Deps, "prisma">,
  query: CalendarQuery,
): Promise<CalendarResponse> {
  const db = deps.prisma;
  if (query.clientId) {
    const client = await db.client.findUnique({
      where: { id: query.clientId },
      select: { id: true },
    });
    if (!client) throw notFound("Client");
  }
  const jobs = await jobsInRange(db, query);
  const posts = await postsPlannedInRange(db, query);
  const thumbs = await thumbsOf(db, [
    ...jobs.map(({ job }) => job.variant.post.id),
    ...posts.map((post) => post.id),
  ]);
  const thumbOf = (postId: string) => thumbs.get(postId) ?? null;

  const placed: Placed[] = [
    ...jobs.map(({ job, date }): Placed => {
      const { post } = job.variant;
      const item: CalendarJobItem = {
        ...baseOf(post, job.platform, date, thumbOf(post.id)),
        kind: "job",
        id: job.id,
        variantId: job.variantId,
        status: job.status,
        scheduledFor: job.scheduledFor.toISOString(),
        publishedAt: job.publishedAt?.toISOString() ?? null,
        liveUrl: job.liveUrl,
        dryRun: job.dryRun,
        slotSource: parseStored(SlotSource, job.slotSource, `PublishJob ${job.id}.slotSource`),
        slotReason: job.slotReason,
        lastError: job.lastError,
      };
      return { item, ref: post.ref };
    }),
    ...posts.flatMap((post) =>
      ghostsOf(post, thumbOf(post.id)).map((item): Placed => ({ item, ref: post.ref })),
    ),
  ];
  return {
    from: query.from,
    to: query.to,
    items: placed.sort(compareItems).map(({ item }) => item),
  };
}
