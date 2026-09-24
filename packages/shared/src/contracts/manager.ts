import { z } from "zod";
import {
  AgentName,
  MessageKind,
  MessageRole,
  PipelineAction,
  Platform,
  PostType,
  VariantFormat,
} from "../enums";
import { IsoDate } from "../dto/common";
import { BrandContext, Brief, BriefDraft, NodeId, PostContext, PostRef } from "./common";
import { CopywriterOutput } from "./copywriter";

/** At most one automatic QA revision per post; after that it goes to humans with qaNotes. */
export const MAX_QA_REVISIONS = 1;

/* ─── manager.intake ─────────────────────────────────────────────────────────────────────────── */

/** A chat turn as the Manager reads it (oldest first). */
export const IntakeMessage = z.object({
  role: MessageRole,
  kind: MessageKind,
  agent: AgentName.nullable(),
  content: z.string(),
});
export type IntakeMessage = z.infer<typeof IntakeMessage>;

/** A client the brief may be for; enabledPlatforms lets the validator check the brief's platforms. */
export const IntakeClient = z.object({
  id: z.string(),
  name: z.string(),
  enabledPlatforms: z.array(Platform),
});
export type IntakeClient = z.infer<typeof IntakeClient>;

export const ManagerIntakeInput = z.object({
  thread: z.array(IntakeMessage).min(1),
  clients: z.array(IntakeClient),
  selectedClientId: z.string().nullable(),
  /**
   * The selected client's calendar day (brand.timezone), or the UTC day while no client is
   * selected; window.start may not be earlier.
   */
  today: IsoDate,
  /** False once Campaign.clarifyCount ≥ 1: the call then uses ManagerIntakeNoClarifyOutput. */
  allowClarify: z.boolean(),
  /** The selected client's brand, when one is known. */
  brand: BrandContext.nullable(),
});
export type ManagerIntakeInput = z.infer<typeof ManagerIntakeInput>;

/** Brief fields the one consolidated clarifying question can ask about. */
export const BriefGap = z.enum([
  "client",
  "platforms",
  "postCount",
  "postMix",
  "window",
  "objective",
  "productFocus",
]);
export type BriefGap = z.infer<typeof BriefGap>;

export const IntakeClarify = z.object({
  kind: z.literal("clarify"),
  /** ONE consolidated question covering every gap. */
  question: z.string().min(1),
  missing: z.array(BriefGap).min(1),
  draft: BriefDraft,
});
export type IntakeClarify = z.infer<typeof IntakeClarify>;

export const IntakeBrief = z.object({
  kind: z.literal("brief"),
  brief: Brief,
  /** Plain-language read-back of the brief, posted to the thread. */
  confirmation: z.string().min(1),
});
export type IntakeBrief = z.infer<typeof IntakeBrief>;

export const ManagerIntakeOutput = z.object({
  result: z.discriminatedUnion("kind", [IntakeClarify, IntakeBrief]),
});
export type ManagerIntakeOutput = z.infer<typeof ManagerIntakeOutput>;

/** After the one question has been asked: remaining gaps must become written assumptions. */
export const ManagerIntakeNoClarifyOutput = z.object({
  result: IntakeBrief,
});
export type ManagerIntakeNoClarifyOutput = z.infer<typeof ManagerIntakeNoClarifyOutput>;

/* ─── manager.plan ───────────────────────────────────────────────────────────────────────────── */

export const PlannedPost = z.object({
  ref: PostRef,
  type: PostType,
  platforms: z.array(Platform).min(1),
  targetDate: IsoDate,
  angle: z.string().min(1),
  pillarHint: z.string().nullable(),
});
export type PlannedPost = z.infer<typeof PlannedPost>;

export const TaskNode = z.object({
  id: NodeId,
  agent: AgentName,
  action: PipelineAction,
  /** The post this node works on; null only for the campaign-wide strategy node. */
  postRef: PostRef.nullable(),
  /** Ids of nodes that must succeed first. */
  deps: z.array(NodeId),
  instructions: z.string().nullable(),
});
export type TaskNode = z.infer<typeof TaskNode>;

/** The task graph (TaskGraph.graph). Checked by validateTaskGraph (task-graph.ts). */
export const ManagerPlanOutput = z.object({
  /** Plain-language summary shown on the PlanCard. */
  summary: z.string().min(1),
  posts: z.array(PlannedPost).min(1),
  nodes: z.array(TaskNode).min(1),
});
export type ManagerPlanOutput = z.infer<typeof ManagerPlanOutput>;

export const ManagerPlanInput = z.object({
  brief: Brief,
  brand: BrandContext,
  /** The client's calendar day (brand.timezone); no post may be dated earlier. */
  today: IsoDate,
  /** PIPELINE_ACTIONS, in pipeline order. */
  enabledActions: z.array(PipelineAction).min(1),
  /** Dates the client already has posts on, to spread the new ones around. */
  busyDates: z.array(IsoDate),
  /** Plan feedback, verbatim (plan request-changes). */
  changeRequest: z.string().nullable(),
  /** The graph the change request is about. */
  previousGraph: ManagerPlanOutput.nullable(),
});
export type ManagerPlanInput = z.infer<typeof ManagerPlanInput>;

/* ─── manager.qa ─────────────────────────────────────────────────────────────────────────────── */

/** A code-run check the Manager sees alongside the copy (banned words, limits, …). */
export const AutomatedCheck = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().nullable(),
});
export type AutomatedCheck = z.infer<typeof AutomatedCheck>;

/** A rendered shot, as QA reviews it (Phase 3+; null before visuals exist). */
export const QaVisual = z.object({
  assetId: z.string(),
  shotId: z.string().nullable(),
  sceneIndex: z.int().nullable(),
  slideIndex: z.int().nullable(),
  prompt: z.string(),
  url: z.string().nullable(),
  reviewScore: z.number().nullable(),
});
export type QaVisual = z.infer<typeof QaVisual>;

/** A platform variant, as QA reviews it (Phase 5+). */
export const QaVariant = z.object({
  platform: Platform,
  format: VariantFormat,
  caption: z.string(),
  hashtags: z.array(z.string()),
  frameCount: z.int().nonnegative(),
});
export type QaVariant = z.infer<typeof QaVariant>;

export const ManagerQaInput = z.object({
  brief: Brief,
  brand: BrandContext,
  post: PostContext,
  copy: CopywriterOutput,
  visuals: z.array(QaVisual).nullable(),
  variants: z.array(QaVariant).nullable(),
  automatedChecks: z.array(AutomatedCheck),
});
export type ManagerQaInput = z.infer<typeof ManagerQaInput>;

/** Which specialist a QA issue is routed back to. */
export const QaTarget = z.enum(["COPYWRITER", "VISUAL_DIRECTOR", "ADAPTER"]);
export type QaTarget = z.infer<typeof QaTarget>;

export const QaIssue = z.object({
  target: QaTarget,
  /** The output field at fault, e.g. "caption" or "script.scenes[0].voiceover". */
  field: z.string(),
  problem: z.string(),
  /** What the specialist should change; becomes the revision feedback verbatim. */
  instruction: z.string(),
});
export type QaIssue = z.infer<typeof QaIssue>;

export const ManagerQaOutput = z.object({
  verdict: z.enum(["pass", "revise"]),
  issues: z.array(QaIssue),
  /** Shown to human reviewers on the post card. */
  summaryForReviewer: z.string(),
});
export type ManagerQaOutput = z.infer<typeof ManagerQaOutput>;

/**
 * Post.qaNotes of a post sent to humans with issues QA's revision didn't fix: the summary, then
 * this heading and the open issues. The post card highlights what follows it.
 */
export const QA_STILL_OPEN_HEADING = "Still open after the automatic revision:";
