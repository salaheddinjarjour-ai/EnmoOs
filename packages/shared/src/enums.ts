import { z } from "zod";

/*
 * Every Prisma enum (packages/db/prisma/schema.prisma) is mirrored here, value for value.
 * packages/db/test/enums.test.ts fails the build if the two ever drift apart.
 */

export const Role = z.enum(["ADMIN", "MANAGER", "EDITOR"]);
export type Role = z.infer<typeof Role>;

export const Platform = z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK"]);
export type Platform = z.infer<typeof Platform>;

export const PostType = z.enum(["REEL", "TIKTOK", "CAROUSEL", "STATIC", "STORY"]);
export type PostType = z.infer<typeof PostType>;

export const PostStatus = z.enum([
  "IDEA",
  "DRAFTING",
  "VISUALIZING",
  "ADAPTING",
  "QA",
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHING",
  "LIVE",
  "SCORED",
  "FAILED",
]);
export type PostStatus = z.infer<typeof PostStatus>;

export const VariantFormat = z.enum(["VERTICAL_9_16", "PORTRAIT_4_5", "SQUARE_1_1"]);
export type VariantFormat = z.infer<typeof VariantFormat>;

export const AgentName = z.enum([
  "MANAGER",
  "STRATEGIST",
  "COPYWRITER",
  "VISUAL_DIRECTOR",
  "ADAPTER",
  "ANALYST",
  "PUBLISHER",
]);
export type AgentName = z.infer<typeof AgentName>;

export const CampaignStatus = z.enum([
  "BRIEFING",
  "PLANNING",
  "PRODUCING",
  "ACTIVE",
  "COMPLETED",
  "ARCHIVED",
]);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const TaskGraphStatus = z.enum([
  "PROPOSED",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
  "COMPLETED",
]);
export type TaskGraphStatus = z.infer<typeof TaskGraphStatus>;

export const TaskStatus = z.enum([
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING",
  "SUCCEEDED",
  "ESCALATED",
  "FAILED",
  "BLOCKED_BUDGET",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const RunOutcome = z.enum(["OK", "INVALID_OUTPUT", "REFUSED", "TRUNCATED", "API_ERROR"]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const AssetKind = z.enum(["IMAGE", "VIDEO"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetRole = z.enum(["SHOT", "MASTER", "VARIANT_FRAME"]);
export type AssetRole = z.infer<typeof AssetRole>;

export const AssetStatus = z.enum(["QUEUED", "RENDERING", "READY", "FAILED", "REJECTED"]);
export type AssetStatus = z.infer<typeof AssetStatus>;

export const ApprovalStatus = z.enum(["PENDING", "APPROVED", "CHANGES_REQUESTED", "CANCELLED"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Decision = z.enum(["APPROVE", "REQUEST_CHANGES"]);
export type Decision = z.infer<typeof Decision>;

export const FeedbackTarget = z.enum(["COPY", "VISUAL", "BOTH"]);
export type FeedbackTarget = z.infer<typeof FeedbackTarget>;

export const PublishStatus = z.enum([
  "SCHEDULED",
  "QUEUED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
]);
export type PublishStatus = z.infer<typeof PublishStatus>;

export const MessageRole = z.enum(["USER", "AGENT", "SYSTEM"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageKind = z.enum([
  "TEXT",
  "CLARIFY",
  "BRIEF",
  "PLAN",
  "PROGRESS",
  "POST_CARD",
  "ESCALATION",
]);
export type MessageKind = z.infer<typeof MessageKind>;

export const AccountStatus = z.enum(["ACTIVE", "EXPIRED", "REVOKED", "ERROR"]);
export type AccountStatus = z.infer<typeof AccountStatus>;

export const Confidence = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type Confidence = z.infer<typeof Confidence>;

/** Name → schema for every Prisma-mirrored enum; the db drift test iterates this. */
export const PRISMA_ENUMS = {
  Role,
  Platform,
  PostType,
  PostStatus,
  VariantFormat,
  AgentName,
  CampaignStatus,
  TaskGraphStatus,
  TaskStatus,
  RunOutcome,
  AssetKind,
  AssetRole,
  AssetStatus,
  ApprovalStatus,
  Decision,
  FeedbackTarget,
  PublishStatus,
  MessageRole,
  MessageKind,
  AccountStatus,
  Confidence,
} as const;

/* App-level enums with no Prisma counterpart (stored as plain strings or only used in config). */

/** Per-post pipeline actions; `PIPELINE_ACTIONS` enables a subset per phase. */
export const PipelineAction = z.enum(["strategy", "write", "direct", "adapt", "qa"]);
export type PipelineAction = z.infer<typeof PipelineAction>;

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  EDITOR: "Editor",
};

export const PLATFORM_LABEL: Readonly<Record<Platform, string>> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TIKTOK: "TikTok",
};

export const AGENT_LABEL: Readonly<Record<AgentName, string>> = {
  MANAGER: "Manager",
  STRATEGIST: "Strategist",
  COPYWRITER: "Copywriter",
  VISUAL_DIRECTOR: "Visual Director",
  ADAPTER: "Adapter",
  ANALYST: "Analyst",
  PUBLISHER: "Publisher",
};
