import { COPY_BANNED_SCAN_IGNORE } from "@enmo/agents";
import type { DbTransaction } from "@enmo/db";
import {
  findSlotCandidate,
  PLATFORM_LABEL,
  platformVariantFormat,
  scanForBannedWords,
  topSlotCandidate,
  type Brief,
  type BriefWindow,
  type CopywriterOutput,
  type Platform,
  type PostType,
  type PublisherInput,
  type SlotCandidate,
  type SlotSource,
  type VariantFormat,
} from "@enmo/shared";
import type { Deps } from "../deps";
import type { PublisherScheduleJob } from "../jobs/queues";
import { calendarDay } from "../lib/clock";
import { runAgentFor } from "../orchestrator/agent-run";
import { currentContentHash, lockReopenableRounds } from "../orchestrator/approval-round";
import { isoDate, storedBrief } from "../orchestrator/context";
import { EventBatch } from "../orchestrator/events";
import { lockPost } from "../orchestrator/locks";
import { postUpdated } from "../orchestrator/post-status";
import { publishUpdated, syncPostPublishStatus } from "../orchestrator/publishing";
import { publishingAccountUnchosen } from "../services/social-accounts";
import { activeAccountOf, copyOf, currentTakesOf, publisherNote } from "./context";
import { describeIssues, preparePayload, variantCopyOf, type PayloadTake } from "./payload";
import { addDays, candidates, slotIsFree, type CandidateRequest } from "./slot-optimizer";

/*
 * publisher.schedule (DESIGN §C "Publisher", §F): once a post's final approval committed, one
 * PostVariant per platform that takes its type (caption from the copy's platform caption, the
 * copy's hashtags), the optimizer's top candidates for each, the Publisher's pick among them (its
 * top candidate once the agent fails: slotSource "optimizer", never an escalation), then one
 * SCHEDULED PublishJob per variant and the post SCHEDULED, announced in the thread.
 *
 * Two short transactions around the LLM call, each re-checking that the post is still APPROVED on
 * the round being scheduled (an edit racing it wins, and this becomes a no-op). The second one
 * re-checks each slot under the client's slot lock and re-picks when another post took it.
 *
 * Slots stay inside the campaign window (DESIGN §F "Slot optimizer"): a variant with no free slot
 * left there, or whose window has passed, is not scheduled; the post is flagged and a teammate puts
 * that platform on a day of their choosing from the calendar (services/publishing.ts schedule).
 */

/** How far ahead the optimizer looks for a post whose campaign has no window. */
export const NO_WINDOW_DAYS = 14;

/**
 * Post.attentionReason of a post the Publisher left with a platform unscheduled (a problem here,
 * or its job giving up twice): scheduling the last such platform by hand answers it.
 */
export const UNSCHEDULED_ATTENTION_PREFIXES = [
  "Not scheduled on ",
  "The Publisher couldn't schedule it: ",
] as const;

export function isUnscheduledAttention(reason: string | null): boolean {
  return reason !== null && UNSCHEDULED_ATTENTION_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** Why a variant has no candidate slot: its window is full, or over. */
function noSlotIn(window: BriefWindow, today: string): string {
  return window.end < today
    ? `the campaign window ended on ${window.end}; put it on a day on the calendar`
    : `no free slot is left in the campaign window (${window.start} to ${window.end}); put it on a day on the calendar`;
}

interface PreparedVariant {
  id: string;
  platform: Platform;
  format: VariantFormat;
  caption: string;
  hashtags: string[];
  /** The variant's job when it has one that still counts (not CANCELLED): it keeps it. */
  keeps: boolean;
}

interface Problem {
  platform: Platform;
  message: string;
  /**
   * False for a platform that simply has no such post (TikTok stories): noted in the thread, but
   * nothing anyone could fix, so no alert.
   */
  actionable: boolean;
}

interface PreparedPost {
  postId: string;
  ref: string;
  postType: PostType;
  clientId: string;
  campaignId: string;
  campaignName: string;
  timezone: string;
  targetDate: string | null;
  brief: Brief | null;
  threadId: string | null;
  variants: PreparedVariant[];
  problems: Problem[];
}

interface PlannedItem {
  variant: PreparedVariant;
  request: CandidateRequest;
  candidates: SlotCandidate[];
}

interface Pick {
  slot: SlotCandidate;
  source: SlotSource;
  reason: string;
}

export type ScheduleResult =
  { status: "stale" } | { status: "done"; scheduled: number; unscheduled: number };

type ScheduleRow = {
  status: string;
  campaign: { status: string };
  client: { archivedAt: Date | null };
  approvalRequests: { round: number; status: string }[];
};

/**
 * The job only acts on a post still APPROVED on the round it was queued for, whose campaign and
 * client aren't archived.
 */
function scheduleDue(post: ScheduleRow | null, round: number): boolean {
  const latest = post?.approvalRequests[0];
  return (
    post?.status === "APPROVED" &&
    post.campaign.status !== "ARCHIVED" &&
    post.client.archivedAt === null &&
    latest?.round === round &&
    latest.status === "APPROVED"
  );
}

const LATEST_ROUND = {
  orderBy: { round: "desc" },
  take: 1,
  select: { id: true, round: true, status: true, contentHash: true },
} as const;

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Transaction A: the variants. The round approved the copy; each variant's text is derived from
 * it here, so when nothing else changed since approval the round's contentHash is extended to
 * cover the variants (a drifted hash is left alone for the publish guard to catch).
 */
async function prepareVariants(
  deps: Deps,
  data: PublisherScheduleJob,
): Promise<PreparedPost | null> {
  return deps.prisma.$transaction(async (tx) => {
    await lockReopenableRounds(tx, data.postId);
    await lockPost(tx, data.postId);
    const post = await tx.post.findUnique({
      where: { id: data.postId },
      include: {
        client: { select: { timezone: true, bannedWords: true, archivedAt: true } },
        campaign: {
          select: {
            id: true,
            name: true,
            status: true,
            brief: true,
            thread: { select: { id: true } },
          },
        },
        approvalRequests: LATEST_ROUND,
      },
    });
    if (!post || !scheduleDue(post, data.round)) return null;
    const existingVariants = await tx.postVariant.findMany({
      where: { postId: post.id },
      include: { publishJob: { select: { status: true } } },
    });
    const takes = await currentTakesOf(tx, post.id);
    const round = post.approvalRequests[0]!;
    const copy = copyOf(post);
    const prepared: PreparedPost = {
      postId: post.id,
      ref: post.ref,
      postType: post.type,
      clientId: post.clientId,
      campaignId: post.campaignId,
      campaignName: post.campaign.name,
      timezone: post.client.timezone,
      targetDate: post.targetDate ? isoDate(post.targetDate) : null,
      brief: post.campaign.brief === null ? null : storedBrief(post.campaign),
      threadId: post.campaign.thread?.id ?? null,
      variants: [],
      problems: [],
    };
    if (!copy) {
      for (const platform of post.platforms) {
        prepared.problems.push({
          platform,
          message: "the post has no copy to publish",
          actionable: true,
        });
      }
      return prepared;
    }

    const hashBefore = await currentContentHash(tx, post.id);
    let changed = false;
    for (const platform of post.platforms) {
      const format = platformVariantFormat(post.type, platform);
      if (!format) {
        prepared.problems.push({
          platform,
          message: `it doesn't take ${post.type.toLowerCase()} posts`,
          actionable: false,
        });
        continue;
      }
      const text = variantCopyOf(copy, platform);
      const existing = existingVariants.find((variant) => variant.platform === platform);
      const keeps = existing?.publishJob != null && existing.publishJob.status !== "CANCELLED";
      let row = existing;
      if (!row) {
        row = await tx.postVariant.create({
          data: { postId: post.id, platform, format, ...text },
          include: { publishJob: { select: { status: true } } },
        });
        changed = true;
      } else if (
        !keeps &&
        (row.format !== format ||
          row.caption !== text.caption ||
          !sameList(row.hashtags, text.hashtags))
      ) {
        // A variant from an earlier round still carries that round's text.
        row = await tx.postVariant.update({
          where: { id: row.id },
          data: { format, ...text },
          include: { publishJob: { select: { status: true } } },
        });
        changed = true;
      }
      prepared.variants.push({
        id: row.id,
        platform,
        format: row.format,
        caption: row.caption,
        hashtags: row.hashtags,
        keeps,
      });
    }
    if (changed && hashBefore === round.contentHash) {
      await tx.approvalRequest.update({
        where: { id: round.id },
        data: { contentHash: await currentContentHash(tx, post.id) },
      });
    }

    // What would fail at publish time is caught now, before a slot is spent on it.
    for (const variant of prepared.variants) {
      if (variant.keeps) continue;
      const problem = variantProblem(deps, {
        platform: variant.platform,
        postType: post.type,
        variantId: variant.id,
        caption: variant.caption,
        hashtags: variant.hashtags,
        copy,
        takes,
        bannedWords: post.client.bannedWords,
      });
      if (problem) {
        prepared.problems.push({ platform: variant.platform, message: problem, actionable: true });
      }
    }
    const blocked = new Set(prepared.problems.map((problem) => problem.platform));
    prepared.variants = prepared.variants.filter(
      (variant) => variant.keeps || !blocked.has(variant.platform),
    );
    return prepared;
  });
}

export interface VariantCheck {
  platform: Platform;
  postType: PostType;
  variantId: string;
  caption: string;
  hashtags: readonly string[];
  copy: CopywriterOutput;
  takes: readonly PayloadTake[];
  bannedWords: readonly string[];
}

/**
 * What would stop the variant at publish time (its publishing rules, the client's banned words),
 * as a clause for people, or null when it can go out.
 */
export function variantProblem(
  deps: { config: Deps["config"]; storage: Deps["storage"] },
  check: VariantCheck,
): string | null {
  const payload = preparePayload({
    platform: check.platform,
    postType: check.postType,
    variantId: check.variantId,
    caption: check.caption,
    hashtags: check.hashtags,
    copy: check.copy,
    takes: check.takes,
    publicBaseUrl: deps.config.PUBLIC_ASSET_BASE_URL,
    storageUrl: (key) => deps.storage.publicUrl(key),
  });
  if (!payload.ok) return `the post breaks its publishing rules: ${describeIssues(payload.issues)}`;
  const banned = scanForBannedWords(
    { copy: check.copy, variant: { caption: check.caption, hashtags: check.hashtags } },
    check.bannedWords,
    { ignoreKeys: COPY_BANNED_SCAN_IGNORE, limit: 20 },
  );
  if (banned.length === 0) return null;
  const terms = [...new Set(banned.map((hit) => `"${hit.term}"`))].join(", ");
  return `it uses the client's banned words ${terms}`;
}

/** The campaign window, or the next NO_WINDOW_DAYS for a post whose campaign has none. */
function windowOf(prepared: PreparedPost, today: string): BriefWindow {
  return prepared.brief?.window ?? { start: today, end: addDays(today, NO_WINDOW_DAYS - 1) };
}

/** The optimizer's candidates inside the campaign window, or why there are none. */
async function candidatesFor(
  deps: Deps,
  prepared: PreparedPost,
  variant: PreparedVariant,
  window: BriefWindow,
  today: string,
): Promise<{ request: CandidateRequest; candidates: SlotCandidate[] } | { problem: string }> {
  const request: CandidateRequest = {
    clientId: prepared.clientId,
    platform: variant.platform,
    timezone: prepared.timezone,
    now: deps.clock.now(),
    window,
    targetDate: prepared.targetDate,
  };
  const found = window.end < today ? [] : await candidates(deps.prisma, request);
  return found.length > 0 ? { request, candidates: found } : { problem: noSlotIn(window, today) };
}

function briefSummaryOf(brief: Brief | null): string {
  if (!brief) return "";
  return [
    `${brief.title}: ${brief.objective}`,
    brief.productFocus ? `Product focus: ${brief.productFocus}` : null,
    brief.audience ? `Audience: ${brief.audience}` : null,
    brief.keyMessages.length > 0 ? `Key messages: ${brief.keyMessages.join("; ")}` : null,
    brief.cadenceNotes ? `Cadence: ${brief.cadenceNotes}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function optimizerPick(candidates: readonly SlotCandidate[]): Pick | null {
  const top = topSlotCandidate(candidates);
  if (!top) return null;
  return {
    slot: top,
    source: "optimizer",
    reason: `Top-scored slot: ${top.reasons[0] ?? `score ${top.score.toFixed(2)}`}.`,
  };
}

/**
 * The Publisher's pick per variant. Whatever goes wrong with the agent (retries exhausted, budget,
 * transport), each variant still gets the optimizer's top candidate: it never escalates.
 */
async function pickSlots(
  deps: Deps,
  prepared: PreparedPost,
  window: BriefWindow,
  items: readonly PlannedItem[],
): Promise<Map<string, Pick>> {
  const picks = new Map<string, Pick>();
  const input: PublisherInput = {
    campaign: { name: prepared.campaignName, window },
    briefSummary: briefSummaryOf(prepared.brief),
    timezone: prepared.timezone,
    items: items.map((item) => ({
      variantId: item.variant.id,
      platform: item.variant.platform,
      postType: prepared.postType,
      targetDate: prepared.targetDate,
      candidates: item.candidates,
    })),
  };
  try {
    const result = await runAgentFor(deps, "PUBLISHER.schedule", input, {
      taskId: null,
      campaignId: prepared.campaignId,
      clientId: prepared.clientId,
    });
    for (const assignment of result.output.assignments) {
      const item = items.find((candidate) => candidate.variant.id === assignment.variantId);
      const slot = item ? findSlotCandidate(item.candidates, assignment.slotStart) : null;
      if (slot)
        picks.set(assignment.variantId, { slot, source: "publisher", reason: assignment.reason });
    }
  } catch (error) {
    deps.logger.warn(
      { err: error, postId: prepared.postId },
      "the Publisher could not pick slots; taking the optimizer's top candidates",
    );
  }
  for (const item of items) {
    if (picks.has(item.variant.id)) continue;
    const fallback = optimizerPick(item.candidates);
    if (fallback) picks.set(item.variant.id, fallback);
  }
  return picks;
}

/** "Tue 2 Mar 12:00" in the client's time zone. */
function localTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(instant)
    .replace(",", "");
}

interface Scheduled {
  platform: Platform;
  scheduledFor: Date;
  reason: string;
  dryRun: boolean;
  liveMode: boolean;
}

function scheduleNote(prepared: PreparedPost, scheduled: Scheduled[], problems: Problem[]): string {
  const lines: string[] = [];
  if (scheduled.length > 0) {
    lines.push(`Scheduled ${prepared.ref} (${prepared.timezone}):`);
    for (const entry of scheduled) {
      const mode = !entry.dryRun
        ? ""
        : entry.liveMode
          ? ` [dry run: no ${PLATFORM_LABEL[entry.platform]} account connected]`
          : " [dry run]";
      lines.push(
        `- ${PLATFORM_LABEL[entry.platform]}: ${localTime(entry.scheduledFor, prepared.timezone)}${mode}. ${entry.reason}`,
      );
    }
  }
  if (problems.length > 0) {
    lines.push(`${scheduled.length > 0 ? "Not scheduled" : `Couldn't schedule ${prepared.ref}`}:`);
    for (const problem of problems) {
      lines.push(`- ${PLATFORM_LABEL[problem.platform]}: ${problem.message}.`);
    }
  }
  return lines.join("\n");
}

/**
 * Transaction B: a job per planned variant at its pick (re-picked when another post of the client
 * took the slot meanwhile), the post SCHEDULED, the thread told. A variant that already has a job
 * that counts keeps it; one whose earlier job was CANCELLED gets that same row back, reset (all but
 * its attempt count, which only ever grows).
 */
async function commitSchedule(
  deps: Deps,
  data: PublisherScheduleJob,
  prepared: PreparedPost,
  items: readonly PlannedItem[],
  picks: ReadonlyMap<string, Pick>,
  problems: Problem[],
): Promise<ScheduleResult> {
  const events = new EventBatch();
  const result = await deps.prisma.$transaction(async (tx: DbTransaction) => {
    await lockReopenableRounds(tx, prepared.postId);
    await lockPost(tx, prepared.postId);
    const post = await tx.post.findUnique({
      where: { id: prepared.postId },
      select: {
        status: true,
        campaign: { select: { status: true } },
        client: { select: { archivedAt: true } },
        approvalRequests: LATEST_ROUND,
      },
    });
    if (!scheduleDue(post, data.round)) return null;

    const now = deps.clock.now();
    const scheduled: Scheduled[] = [];
    for (const item of items) {
      const { variant } = item;
      const current = await tx.publishJob.findUnique({ where: { variantId: variant.id } });
      if (current && current.status !== "CANCELLED") continue;
      const request = { ...item.request, now };
      let pick = picks.get(variant.id) ?? null;
      if (pick && !(await slotIsFree(tx, request, new Date(pick.slot.slotStart)))) {
        const taken = localTime(new Date(pick.slot.slotStart), prepared.timezone);
        const again = optimizerPick(await candidates(tx, request));
        pick = again && {
          ...again,
          reason: `${taken} was taken meanwhile. ${again.reason}`,
        };
      }
      if (!pick) {
        problems.push({
          platform: variant.platform,
          message: noSlotIn(request.window, calendarDay(now, prepared.timezone)),
          actionable: true,
        });
        continue;
      }
      const account = await activeAccountOf(tx, prepared.clientId, variant.platform);
      const liveMode = deps.publishers[variant.platform].mode === "live";
      if (
        liveMode &&
        !account &&
        (await publishingAccountUnchosen(tx, prepared.clientId, variant.platform))
      ) {
        // Several accounts and none chosen: a dry run would pass for a post nobody will see.
        problems.push({
          platform: variant.platform,
          message: `several ${PLATFORM_LABEL[variant.platform]} accounts are connected and none is chosen to publish through; choose one in the client's accounts, then put it on a day on the calendar`,
          actionable: true,
        });
        continue;
      }
      const fields = {
        socialAccountId: account?.id ?? null,
        platform: variant.platform,
        status: "SCHEDULED" as const,
        scheduledFor: new Date(pick.slot.slotStart),
        slotSource: pick.source,
        slotReason: pick.reason,
        // A forecast: the claim settles it with the mode and account there are at the slot.
        dryRun: !liveMode || !account,
        // A reused row counts on: its earlier runs' BullMQ ids (publish-<id>-run<n>) stay in Redis
        // for a day, and BullMQ ignores an add whose id exists, so starting again at run 1 would
        // never run. The +1 also skips the run that may have been queued when it was cancelled.
        attempts: current ? current.attempts + 1 : 0,
        containerId: null,
        externalId: null,
        liveUrl: null,
        lastError: null,
        publishedAt: null,
      };
      const job = current
        ? await tx.publishJob.update({ where: { id: current.id }, data: fields })
        : await tx.publishJob.create({ data: { variantId: variant.id, ...fields } });
      publishUpdated(events, job, prepared.postId);
      scheduled.push({
        platform: variant.platform,
        scheduledFor: job.scheduledFor,
        reason: pick.reason,
        dryRun: job.dryRun,
        liveMode,
      });
    }

    const actionable = problems.filter((problem) => problem.actionable);
    if (actionable.length > 0) {
      const summary = actionable
        .map((problem) => `${PLATFORM_LABEL[problem.platform]}: ${problem.message}`)
        .join("; ");
      const flagged = await tx.post.update({
        where: { id: prepared.postId },
        data: {
          needsAttention: true,
          attentionReason: `${UNSCHEDULED_ATTENTION_PREFIXES[0]}${summary}`.slice(0, 500),
        },
      });
      postUpdated(events, flagged);
      events.alert({
        kind: "failed",
        entityType: "Post",
        entityId: prepared.postId,
        message: `The Publisher couldn't schedule ${prepared.ref} on ${summary}.`,
        clientId: prepared.clientId,
        campaignId: prepared.campaignId,
      });
    }
    await syncPostPublishStatus(tx, events, prepared.postId);
    if (scheduled.length > 0 || problems.length > 0) {
      await publisherNote(
        tx,
        events,
        prepared.threadId,
        scheduleNote(prepared, scheduled, problems),
      );
    }
    return {
      status: "done" as const,
      scheduled: scheduled.length,
      unscheduled: actionable.length,
    };
  });
  await events.publish(deps);
  return result ?? { status: "stale" };
}

/** publisher.schedule for one approved post and round. */
export async function schedulePost(
  deps: Deps,
  data: PublisherScheduleJob,
): Promise<ScheduleResult> {
  const prepared = await prepareVariants(deps, data);
  if (!prepared) return { status: "stale" };

  const today = calendarDay(deps.clock.now(), prepared.timezone);
  const window = windowOf(prepared, today);
  const problems = [...prepared.problems];
  const items: PlannedItem[] = [];
  for (const variant of prepared.variants) {
    if (variant.keeps) continue;
    const found = await candidatesFor(deps, prepared, variant, window, today);
    if ("problem" in found) {
      problems.push({ platform: variant.platform, message: found.problem, actionable: true });
      continue;
    }
    items.push({ variant, ...found });
  }
  const picks = items.length > 0 ? await pickSlots(deps, prepared, window, items) : new Map();
  return commitSchedule(deps, data, prepared, items, picks, problems);
}
