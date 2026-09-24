import { z } from "zod";
import { ApprovalChain } from "../approval-chain";
import { ApprovalStatus, Decision, FeedbackTarget, Platform } from "../enums";
import { hasUniqueItems } from "../internal";
import { Id, IsoDateTime, NamedRef, VerbatimText, listResponse } from "./common";
import { PostDto } from "./post";

export const ApprovalDecisionDto = z.object({
  id: Id,
  step: z.int().nonnegative(),
  user: NamedRef,
  decision: Decision,
  /** Verbatim, exactly as the reviewer typed it. */
  feedback: z.string().nullable(),
  target: FeedbackTarget.nullable(),
  viaApproveAll: z.boolean(),
  createdAt: IsoDateTime,
});
export type ApprovalDecisionDto = z.infer<typeof ApprovalDecisionDto>;

/** An approval round for one post, as the queue and the post card show it. */
export const ApprovalRequestDto = z.object({
  id: Id,
  postId: Id,
  round: z.int().positive(),
  status: ApprovalStatus,
  /** Snapshot of the client's chain when the round opened. */
  chain: ApprovalChain,
  currentStep: z.int().nonnegative(),
  /** Whether the viewer may decide the current step (chainRejection() is null). */
  canDecide: z.boolean(),
  decisions: z.array(ApprovalDecisionDto),
  post: PostDto,
  client: NamedRef,
  campaign: NamedRef,
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export type ApprovalRequestDto = z.infer<typeof ApprovalRequestDto>;

/** GET /v1/approvals — PENDING requests, newest first. */
export const ApprovalListQuery = z.object({
  clientId: Id.optional(),
  campaignId: Id.optional(),
  platform: Platform.optional(),
});
export type ApprovalListQuery = z.infer<typeof ApprovalListQuery>;

export const ApprovalListResponse = listResponse(ApprovalRequestDto);
export type ApprovalListResponse = z.infer<typeof ApprovalListResponse>;

/**
 * POST /v1/approvals/:id/decision → ApprovalRequestDto. REQUEST_CHANGES needs the feedback (routed
 * verbatim to the target agent) and a target.
 */
export const ApprovalDecisionRequest = z
  .object({
    decision: Decision,
    feedback: VerbatimText.optional(),
    target: FeedbackTarget.optional(),
  })
  .refine((body) => body.decision !== "REQUEST_CHANGES" || body.feedback !== undefined, {
    message: "Say what should change",
    path: ["feedback"],
  })
  .refine((body) => body.decision !== "REQUEST_CHANGES" || body.target !== undefined, {
    message: "Pick what should change: copy, visual or both",
    path: ["target"],
  });
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const APPROVE_ALL_MAX = 200;

/** POST /v1/approvals/approve-all: approves the current step of each request the caller may decide. */
export const ApproveAllRequest = z.object({
  requestIds: z.array(Id).min(1).max(APPROVE_ALL_MAX).refine(hasUniqueItems, "Duplicate ids"),
});
export type ApproveAllRequest = z.infer<typeof ApproveAllRequest>;

/** Why approve-all left a request alone (the chain rejections plus an unknown id). */
export const ApproveAllSkipReason = z.enum([
  "NOT_FOUND",
  "NOT_PENDING",
  "INVALID_STEP",
  "NOT_ELIGIBLE",
  "ALREADY_DECIDED",
]);
export type ApproveAllSkipReason = z.infer<typeof ApproveAllSkipReason>;

export const ApproveAllItem = z.object({
  requestId: Id,
  postId: Id.nullable(),
  /** approved: the request is APPROVED; pending: approval recorded, later steps remain. */
  outcome: z.enum(["approved", "pending", "skipped"]),
  status: ApprovalStatus.nullable(),
  currentStep: z.int().nonnegative().nullable(),
  reason: ApproveAllSkipReason.nullable(),
});
export type ApproveAllItem = z.infer<typeof ApproveAllItem>;

export const ApproveAllResponse = z.object({
  results: z.array(ApproveAllItem),
  approvedCount: z.int().nonnegative(),
  pendingCount: z.int().nonnegative(),
  skippedCount: z.int().nonnegative(),
  /** The single approval.approve_all AuditLog row; null when nothing was approved. */
  auditLogId: Id.nullable(),
});
export type ApproveAllResponse = z.infer<typeof ApproveAllResponse>;
