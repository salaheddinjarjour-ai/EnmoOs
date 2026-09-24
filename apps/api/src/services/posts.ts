import { COPY_BANNED_SCAN_IGNORE, editedCopyIssues } from "@enmo/agents";
import type { DbTransaction, Post, Prisma } from "@enmo/db";
import {
  ApprovalChain,
  canDecideRequest,
  COPY_EDITABLE_STATUSES,
  CopywriterOutput,
  inferFailedStage,
  postPlacement,
  scanForBannedWords,
  type ApprovalSummary,
  type BannedWordsErrorDetails,
  type CampaignStatus,
  type CopyRuleErrorDetails,
  type PostDto,
  type PostListQuery,
  type PostStatus,
  type UpdatePostCopyRequest,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { conflict, notFound, unprocessable, type AppError } from "../lib/errors";
import { parseStored } from "../lib/stored";
import {
  approvalCreated,
  approvalResolved,
  cancelOpenRounds,
  lockReopenableRounds,
  openApprovalRound,
} from "../orchestrator/approval-round";
import { isoDate, postContextOf } from "../orchestrator/context";
import { EventBatch } from "../orchestrator/events";
import { lockPost, shareLockCampaign } from "../orchestrator/locks";
import { postUpdated, requireTransition } from "../orchestrator/post-status";
import { refNumber } from "../orchestrator/progress";
import { UNFINISHED_STATUSES } from "../orchestrator/tasks";
import type { ServiceUser } from "./actor";

/*
 * Posts (DESIGN §B "Posts and assets", §E). A PostDto's `currentApproval.canDecide` depends on the
 * viewer, hence the user argument on reads.
 */

/** What decides whether a post's copy may be edited now (PostDto.editable, whyNotEditable). */
const EDIT_STATE_INCLUDE = {
  campaign: { select: { status: true } },
  _count: { select: { tasks: { where: { status: { in: [...UNFINISHED_STATUSES] } } } } },
} as const satisfies Prisma.PostInclude;

export const POST_INCLUDE = {
  approvalRequests: {
    orderBy: { round: "desc" },
    take: 1,
    include: { decisions: { select: { step: true, userId: true, decision: true } } },
  },
  ...EDIT_STATE_INCLUDE,
} as const satisfies Prisma.PostInclude;

export type PostRow = Prisma.PostGetPayload<{ include: typeof POST_INCLUDE }>;
type ApprovalRow = PostRow["approvalRequests"][number];

/** Statuses whose content is already out in the world. */
const PUBLISHED_STATUSES: ReadonlySet<PostStatus> = new Set(["PUBLISHING", "LIVE", "SCORED"]);

interface EditState {
  status: PostStatus;
  copy: unknown;
  campaign: { status: CampaignStatus };
  /** Its tasks in UNFINISHED_STATUSES: agent work still owed on the post. */
  _count: { tasks: number };
}

/**
 * Why a human can't edit the post's copy now (the CONFLICT message), or null when they can: only
 * copy that waits on a human, or is approved and not yet published, with no agent work still owed
 * on the post. A pending, budget-blocked or running task would store its own copy over the edit.
 */
function whyNotEditable(post: EditState): string | null {
  if (post.campaign.status === "ARCHIVED") return "The campaign is archived";
  if (PUBLISHED_STATUSES.has(post.status)) return "A published post can't be edited";
  if (post.status === "FAILED") return "A failed post can't be edited";
  if (post._count.tasks > 0) {
    return "An agent is working on this post right now; edit it once it's done";
  }
  if (post.copy === null || !COPY_EDITABLE_STATUSES.includes(post.status)) {
    return "The agents haven't finished this post yet; edit it once it's in approval";
  }
  return null;
}

async function loadEditState(db: DbTransaction, postId: string): Promise<EditState | null> {
  return db.post.findUnique({
    where: { id: postId },
    select: { status: true, copy: true, ...EDIT_STATE_INCLUDE },
  });
}

function approvalSummary(request: ApprovalRow, user: ServiceUser): ApprovalSummary {
  const chain = parseStored(ApprovalChain, request.chain, `ApprovalRequest ${request.id}.chain`);
  return {
    id: request.id,
    round: request.round,
    status: request.status,
    currentStep: request.currentStep,
    stepCount: chain.steps.length,
    stepName: chain.steps[request.currentStep]?.name ?? null,
    canDecide: canDecideRequest(
      {
        chain,
        status: request.status,
        currentStep: request.currentStep,
        decisions: request.decisions,
      },
      user,
    ),
  };
}

export function toPostDto(row: PostRow, user: ServiceUser): PostDto {
  const placement = postPlacement(row.status, inferFailedStage(row));
  const latest = row.approvalRequests[0];
  return {
    id: row.id,
    campaignId: row.campaignId,
    clientId: row.clientId,
    ref: row.ref,
    type: row.type,
    platforms: row.platforms,
    status: row.status,
    column: placement.column,
    pill: placement.pill,
    approved: placement.approved,
    failed: placement.failed,
    targetDate: row.targetDate ? isoDate(row.targetDate) : null,
    pillar: row.pillar,
    angle: row.angle,
    hook: row.hook,
    copy: row.copy === null ? null : parseStored(CopywriterOutput, row.copy, `Post ${row.id}.copy`),
    humanEditCount: row.humanEditCount,
    editable: whyNotEditable(row) === null,
    revision: row.revision,
    needsAttention: row.needsAttention,
    attentionReason: row.attentionReason,
    qaNotes: row.qaNotes,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    liveAt: row.liveAt?.toISOString() ?? null,
    currentApproval: latest ? approvalSummary(latest, user) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * GET /posts: filtered by client, campaign, status and platform; campaign order (p1, p2, …).
 * Posts of archived campaigns are left out unless the query names the campaign: the pipeline
 * shows work in flight, while an archived campaign's own thread still shows what it made.
 */
export async function listPosts(
  deps: Deps,
  user: ServiceUser,
  query: PostListQuery,
): Promise<PostDto[]> {
  const rows = await deps.prisma.post.findMany({
    where: {
      clientId: query.clientId,
      campaignId: query.campaignId,
      status: query.status,
      ...(query.platform ? { platforms: { has: query.platform } } : {}),
      ...(query.campaignId ? {} : { campaign: { status: { not: "ARCHIVED" } } }),
    },
    include: { ...POST_INCLUDE, campaign: { select: { status: true, createdAt: true } } },
  });
  rows.sort(
    (a, b) =>
      b.campaign.createdAt.getTime() - a.campaign.createdAt.getTime() ||
      (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0) ||
      refNumber(a.ref) - refNumber(b.ref),
  );
  return rows.map((row) => toPostDto(row, user));
}

/** GET /posts/:id. NOT_FOUND when missing. */
export async function getPost(deps: Deps, user: ServiceUser, postId: string): Promise<PostDto> {
  const row = await deps.prisma.post.findUnique({ where: { id: postId }, include: POST_INCLUDE });
  if (!row) throw notFound("Post");
  return toPostDto(row, user);
}

/** The most banned-word hits a 422 reports: enough to flag every field, never the whole body. */
export const BANNED_HITS_REPORTED_MAX = 50;

/**
 * Why an edit can't be stored: the client's banned words (with their offsets, for the editor to
 * flag) and the Copywriter contract for this post's type and platforms (DESIGN §C), which every
 * stored copy honours, whoever wrote it.
 */
function editRejection(
  post: Post,
  bannedWords: readonly string[],
  copy: CopywriterOutput,
): AppError | null {
  const hits = scanForBannedWords(copy, bannedWords, {
    ignoreKeys: COPY_BANNED_SCAN_IGNORE,
    limit: BANNED_HITS_REPORTED_MAX,
  });
  const issues = editedCopyIssues(copy, postContextOf(post, null));
  const [first] = issues;
  if (hits.length > 0) {
    const details: BannedWordsErrorDetails & Partial<CopyRuleErrorDetails> = {
      bannedWords: hits,
      ...(first ? { issues } : {}),
    };
    return unprocessable("The copy uses banned words", details);
  }
  if (!first) return null;
  const details: CopyRuleErrorDetails = { issues };
  const where = first.path ? `${first.path}: ` : "";
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  return unprocessable(
    `The copy doesn't fit this ${post.type} post. ${where}${first.message}${more}`,
    details,
  );
}

/**
 * PATCH /posts/:id/copy. Replaces Post.copy with the human's edit and increments humanEditCount.
 * UNPROCESSABLE (422) when scanForBannedWords finds the client's banned words (details
 * BannedWordsErrorDetails) or the copy breaks the Copywriter contract for this post (details
 * CopyRuleErrorDetails); both are reported at once when both apply. An edit after approval
 * reopens it: the approved (or pending) request is cancelled and a new round opens with a fresh
 * contentHash; any scheduled PublishJob is cancelled with it. CONFLICT unless the post is
 * PostDto.editable (whyNotEditable): while an agent is still owed the post (a change request's
 * revision included), once it is published, or when its campaign is archived. NOT_FOUND when
 * missing.
 *
 * The check is made again under the locks the other writers take (locks.ts), so an edit racing a
 * decision, a revision or an archive either lands first (and the other sees it) or is refused;
 * it is never stored where an agent will write over it.
 */
export async function editCopy(
  deps: Deps,
  user: ServiceUser,
  postId: string,
  patch: UpdatePostCopyRequest,
): Promise<PostDto> {
  const post = await deps.prisma.post.findUnique({
    where: { id: postId },
    include: { client: { select: { bannedWords: true } }, ...EDIT_STATE_INCLUDE },
  });
  if (!post) throw notFound("Post");
  const blocked = whyNotEditable(post);
  if (blocked) throw conflict(blocked);
  const rejection = editRejection(post, post.client.bannedWords, patch.copy);
  if (rejection) throw rejection;

  const now = deps.clock.now();
  const events = new EventBatch();
  await deps.prisma.$transaction(async (tx) => {
    // Campaign, rounds, then the post: the order every other writer locks them in (locks.ts).
    await shareLockCampaign(tx, post.campaignId);
    await lockReopenableRounds(tx, postId);
    await lockPost(tx, postId);
    const current = await loadEditState(tx, postId);
    if (!current) throw notFound("Post");
    const changed = whyNotEditable(current);
    if (changed) throw conflict(changed);

    const cancelled = await cancelOpenRounds(tx, postId, now);
    let updated = await tx.post.update({
      where: { id: postId },
      data: { copy: patch.copy, humanEditCount: { increment: 1 } },
    });
    if (cancelled.length > 0) {
      const context = { campaignId: updated.campaignId, clientId: updated.clientId };
      await tx.publishJob.updateMany({
        where: { variant: { postId }, status: { in: ["SCHEDULED", "QUEUED"] } },
        data: { status: "CANCELLED" },
      });
      updated = await requireTransition(tx, postId, "PENDING_APPROVAL", {
        approvedAt: null,
        needsAttention: false,
        attentionReason: null,
      });
      const request = await openApprovalRound(tx, updated);
      for (const round of cancelled) approvalResolved(events, round, context);
      approvalCreated(events, request, context);
    }
    postUpdated(events, updated);
  });
  await events.publish(deps);
  return getPost(deps, user, postId);
}
