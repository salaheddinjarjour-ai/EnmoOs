import type { DbTransaction, Prisma } from "@enmo/db";
import {
  ApprovalChain,
  AUDIT_ACTIONS,
  canDecideRequest,
  nextStateAfterDecision,
  type ApprovalDecisionRequest,
  type ApprovalListQuery,
  type ApprovalRequestDto,
  type ApproveAllItem,
  type ApproveAllResponse,
  type ChainOutcome,
  type ChainRejection,
  type ChainRequestState,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { badRequest, conflict, forbidden, notFound, type AppError } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { afterCommit } from "../orchestrator/after-commit";
import { approvalResolved } from "../orchestrator/approval-round";
import { EventBatch } from "../orchestrator/events";
import { routeHumanFeedback } from "../orchestrator/feedback";
import { advanceOrRecount } from "../orchestrator/graph";
import { lockApprovalRequests } from "../orchestrator/locks";
import { postUpdated, requireTransition } from "../orchestrator/post-status";
import { onPostApproved, type ApprovedPost } from "../orchestrator/publishing";
import type { ServiceUser } from "./actor";
import { recordAudit } from "./audit";
import { POST_INCLUDE, toPostDto } from "./posts";

/*
 * Approval rounds (DESIGN §D "Request Changes", §E "Approval chain"). Chain rules come from
 * @enmo/shared approval-chain.ts (chainRejection, nextStateAfterDecision); every resolution emits
 * approval.resolved and post.updated. Decisions on a round are serialised with a row lock, so two
 * reviewers clicking at once each see the other's decision.
 */

const REQUEST_INCLUDE = {
  decisions: {
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true } } },
  },
  post: {
    include: {
      ...POST_INCLUDE,
      client: { select: { id: true, name: true } },
      // POST_INCLUDE's campaign status (for PostDto.editable), plus what the DTO names.
      campaign: { select: { id: true, name: true, status: true } },
    },
  },
} as const satisfies Prisma.ApprovalRequestInclude;

type RequestRow = Prisma.ApprovalRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

function chainState(request: {
  id: string;
  chain: unknown;
  status: ChainRequestState["status"];
  currentStep: number;
  decisions: ChainRequestState["decisions"];
}): ChainRequestState {
  return {
    chain: parseStored(ApprovalChain, request.chain, `ApprovalRequest ${request.id}.chain`),
    status: request.status,
    currentStep: request.currentStep,
    decisions: request.decisions,
  };
}

export function toApprovalRequestDto(row: RequestRow, user: ServiceUser): ApprovalRequestDto {
  const state = chainState(row);
  const { client, campaign, ...post } = row.post;
  return {
    id: row.id,
    postId: row.postId,
    round: row.round,
    status: row.status,
    chain: state.chain,
    currentStep: row.currentStep,
    canDecide: canDecideRequest(state, user),
    decisions: row.decisions.map((decision) => ({
      id: decision.id,
      step: decision.step,
      user: decision.user,
      decision: decision.decision,
      feedback: decision.feedback,
      target: decision.target,
      viaApproveAll: decision.viaApproveAll,
      createdAt: decision.createdAt.toISOString(),
    })),
    post: toPostDto({ ...post, campaign }, user),
    client,
    campaign: { id: campaign.id, name: campaign.name },
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

async function getApprovalRequest(
  deps: Deps,
  user: ServiceUser,
  requestId: string,
): Promise<ApprovalRequestDto> {
  const row = await deps.prisma.approvalRequest.findUnique({
    where: { id: requestId },
    include: REQUEST_INCLUDE,
  });
  if (!row) throw notFound("Approval request");
  return toApprovalRequestDto(row, user);
}

/** GET /approvals: PENDING requests, newest first, each with the viewer's `canDecide`. */
export async function listPendingApprovals(
  deps: Deps,
  user: ServiceUser,
  filters: ApprovalListQuery,
): Promise<ApprovalRequestDto[]> {
  const rows = await deps.prisma.approvalRequest.findMany({
    where: {
      status: "PENDING",
      post: {
        clientId: filters.clientId,
        campaignId: filters.campaignId,
        ...(filters.platform ? { platforms: { has: filters.platform } } : {}),
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: REQUEST_INCLUDE,
  });
  return rows.map((row) => toApprovalRequestDto(row, user));
}

function rejectionError(reason: ChainRejection): AppError {
  switch (reason) {
    case "NOT_PENDING":
      return conflict("This approval round is no longer pending");
    case "INVALID_STEP":
      return conflict("This approval round's chain has no current step");
    case "NOT_ELIGIBLE":
      return forbidden("You're not an approver for the current step of this post's chain");
    case "ALREADY_DECIDED":
      return conflict("You already decided this step");
  }
}

interface RoundUpdate {
  request: { id: string; postId: string; round: number };
  post: { campaignId: string; clientId: string };
  outcome: ChainOutcome;
}

/**
 * Stores the new chain position; an APPROVED round approves the post, which is returned so the
 * caller hands it to the Publisher once the transaction commits.
 */
async function applyApproval(
  deps: Deps,
  tx: DbTransaction,
  { request, post, outcome }: RoundUpdate,
  events: EventBatch,
): Promise<ApprovedPost | null> {
  const now = deps.clock.now();
  const resolved = outcome.status !== "PENDING";
  await tx.approvalRequest.update({
    where: { id: request.id },
    data: {
      status: outcome.status,
      currentStep: outcome.currentStep,
      ...(resolved ? { resolvedAt: now } : {}),
    },
  });
  if (outcome.status === "PENDING") {
    // Same status, but the round moved to its next step: cards refresh their buttons.
    if (outcome.stepCompleted) {
      postUpdated(events, await tx.post.findUniqueOrThrow({ where: { id: request.postId } }));
    }
    return null;
  }
  if (outcome.status !== "APPROVED") return null;
  const approved = await requireTransition(tx, request.postId, "APPROVED", { approvedAt: now });
  postUpdated(events, approved);
  approvalResolved(events, { ...request, status: "APPROVED" }, post);
  return { postId: request.postId, round: request.round };
}

/** Hands each approved post to the Publisher; a queue outage never undoes the approval. */
async function scheduleApproved(deps: Deps, approved: readonly ApprovedPost[]): Promise<void> {
  for (const post of approved) {
    await afterCommit(deps, "scheduling the approved post", () => onPostApproved(deps, post));
  }
}

/**
 * POST /approvals/:id/decision. Records the user's decision on the current step. APPROVE moves
 * the chain on (the post is APPROVED after the last step). REQUEST_CHANGES stores the feedback
 * verbatim with its target, resolves the request as CHANGES_REQUESTED, moves the post to
 * CHANGES_REQUESTED with revision + 1 and appends the revision subgraph whose first task carries
 * AgentTask.feedback = {verbatim, source: HUMAN, decisionId}, queued once the decision commits.
 * FORBIDDEN when the chain says the user can't decide this step (REQUEST_CHANGES included: it
 * starts generation spend); CONFLICT when the request is no longer PENDING; NOT_FOUND when
 * missing.
 */
export async function decide(
  deps: Deps,
  user: ServiceUser,
  requestId: string,
  body: ApprovalDecisionRequest,
): Promise<ApprovalRequestDto> {
  if (body.decision === "REQUEST_CHANGES" && (body.feedback === undefined || !body.target)) {
    throw badRequest("Requesting changes needs the feedback and a target (copy, visual or both)");
  }
  const events = new EventBatch();
  const { revisedGraph, approved } = await deps.prisma.$transaction(async (tx) => {
    await lockApprovalRequests(tx, [requestId]);
    const request = await tx.approvalRequest.findUnique({
      where: { id: requestId },
      include: {
        decisions: { select: { step: true, userId: true, decision: true } },
        post: { select: { campaignId: true, clientId: true } },
      },
    });
    if (!request) throw notFound("Approval request");
    const transition = nextStateAfterDecision(chainState(request), user, body.decision);
    if (!transition.ok) throw rejectionError(transition.reason);
    const { outcome } = transition;

    const decision = await tx.approvalDecision.create({
      data: {
        requestId,
        step: outcome.decidedStep,
        userId: user.id,
        decision: body.decision,
        feedback: body.feedback ?? null,
        target: body.target ?? null,
      },
      select: { id: true },
    });

    if (outcome.status !== "CHANGES_REQUESTED") {
      const post = await applyApproval(deps, tx, { request, post: request.post, outcome }, events);
      return { revisedGraph: null, approved: post };
    }

    await tx.approvalRequest.update({
      where: { id: requestId },
      data: { status: "CHANGES_REQUESTED", resolvedAt: deps.clock.now() },
    });
    const routed = await routeHumanFeedback(tx, {
      postId: request.postId,
      decisionId: decision.id,
      // Byte-for-byte: this string is what the agent will read.
      feedback: body.feedback ?? "",
      target: body.target ?? "COPY",
      enabledActions: deps.config.PIPELINE_ACTIONS,
    });
    postUpdated(events, routed.post);
    approvalResolved(events, { ...request, status: "CHANGES_REQUESTED" }, request.post);
    return { revisedGraph: routed.graphId, approved: null };
  });

  // The decision stands once committed; the sweeper queues a revision this couldn't.
  await afterCommit(deps, "publishing the decision", () => events.publish(deps));
  if (revisedGraph) {
    await afterCommit(deps, "starting the revision", () => advanceOrRecount(deps, revisedGraph));
  }
  if (approved) await scheduleApproved(deps, [approved]);
  return getApprovalRequest(deps, user, requestId);
}

type ApproveAllPlan =
  | { requestId: string; reason: "NOT_FOUND" }
  | { requestId: string; request: LockedRequest; reason: ChainRejection }
  | { requestId: string; request: LockedRequest; outcome: ChainOutcome };

type LockedRequest = Prisma.ApprovalRequestGetPayload<{
  include: {
    decisions: { select: { step: true; userId: true; decision: true } };
    post: { select: { campaignId: true; clientId: true } };
  };
}>;

/**
 * POST /approvals/approve-all. Approves the current step of every listed request the user may
 * decide (never skipping a step), marking each decision viaApproveAll, and writes one
 * approval.approve_all AuditLog row that the decisions reference. Requests it can't act on are
 * reported as skipped with the chain's reason, never as an error.
 */
export async function approveAll(
  deps: Deps,
  user: ServiceUser,
  requestIds: readonly string[],
): Promise<ApproveAllResponse> {
  const ids = [...new Set(requestIds)];
  const events = new EventBatch();
  const approvedPosts: ApprovedPost[] = [];
  const response = await deps.prisma.$transaction(
    async (tx) => {
      await lockApprovalRequests(tx, ids);
      const rows = await tx.approvalRequest.findMany({
        where: { id: { in: ids } },
        include: {
          decisions: { select: { step: true, userId: true, decision: true } },
          post: { select: { campaignId: true, clientId: true } },
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const plans: ApproveAllPlan[] = ids.map((requestId) => {
        const request = byId.get(requestId);
        if (!request) return { requestId, reason: "NOT_FOUND" };
        const transition = nextStateAfterDecision(chainState(request), user, "APPROVE");
        return transition.ok
          ? { requestId, request, outcome: transition.outcome }
          : { requestId, request, reason: transition.reason };
      });

      const approvals = plans.filter((plan) => "outcome" in plan);
      let auditLogId: string | null = null;
      if (approvals.length > 0) {
        const audit = await recordAudit(tx, {
          actorId: user.id,
          ip: user.ip,
          action: AUDIT_ACTIONS.approvalApproveAll,
          entityType: "ApprovalRequest",
          entityId: null,
          data: {
            requestIds: ids,
            decisions: approvals.map(({ request, outcome }) => ({
              requestId: request.id,
              postId: request.postId,
              step: outcome.decidedStep,
              status: outcome.status,
            })),
            skipped: plans.flatMap((plan) =>
              "reason" in plan ? [{ requestId: plan.requestId, reason: plan.reason }] : [],
            ),
          },
        });
        auditLogId = audit.id;
        for (const { request, outcome } of approvals) {
          await tx.approvalDecision.create({
            data: {
              requestId: request.id,
              step: outcome.decidedStep,
              userId: user.id,
              decision: "APPROVE",
              viaApproveAll: true,
              auditLogId,
            },
          });
          const approved = await applyApproval(
            deps,
            tx,
            { request, post: request.post, outcome },
            events,
          );
          if (approved) approvedPosts.push(approved);
        }
      }

      const results: ApproveAllItem[] = plans.map((plan) => {
        if ("outcome" in plan) {
          return {
            requestId: plan.requestId,
            postId: plan.request.postId,
            outcome: plan.outcome.status === "APPROVED" ? "approved" : "pending",
            status: plan.outcome.status,
            currentStep: plan.outcome.currentStep,
            reason: null,
          };
        }
        const request = "request" in plan ? plan.request : null;
        return {
          requestId: plan.requestId,
          postId: request?.postId ?? null,
          outcome: "skipped",
          status: request?.status ?? null,
          currentStep: request?.currentStep ?? null,
          reason: plan.reason,
        };
      });
      const count = (outcome: ApproveAllItem["outcome"]) =>
        results.filter((result) => result.outcome === outcome).length;
      return {
        results,
        approvedCount: count("approved"),
        pendingCount: count("pending"),
        skippedCount: count("skipped"),
        auditLogId,
      };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await events.publish(deps);
  await scheduleApproved(deps, approvedPosts);
  return response;
}
