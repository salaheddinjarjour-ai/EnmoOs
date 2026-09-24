import { z } from "zod";
import { Platform, PostType } from "../enums";
import { VisualStyleTokens } from "../visual-style";
import { IsoDate } from "../dto/common";

/*
 * Agent contracts (DESIGN §C). Every schema an agent *outputs* is sent to the API as a structured
 * output format (`zodOutputFormat`), so output schemas follow these rules:
 *   - the root is an object; unions sit under an object key;
 *   - every field is required: absent values are `.nullable()`, never `.optional()`;
 *   - no z.record, no recursion, no z.any, no transforms or defaults;
 *   - business rules (sums, timing, banned words, cross-field checks) live in validators, not in
 *     refinements, so a draft the rules reject still parses and the runner can explain why.
 * Input schemas are only parsed locally and may use anything.
 */

export const POST_COUNT_MIN = 1;
export const POST_COUNT_MAX = 60;

/** Planned post reference inside one campaign: "p1" … "p999". */
export const PostRef = z.string().regex(/^p\d{1,3}$/, 'Expected a post ref like "p1"');
export type PostRef = z.infer<typeof PostRef>;

/** Task-graph node id: "n1" … "n9999". Revision nodes ("n7.r1") are minted by code, never planned. */
export const NodeId = z.string().regex(/^n\d{1,4}$/, 'Expected a node id like "n1"');
export type NodeId = z.infer<typeof NodeId>;

/** What every agent knows about the client it is working for. */
export const BrandContext = z.object({
  clientId: z.string(),
  name: z.string(),
  timezone: z.string(),
  brandVoice: z.string(),
  bannedWords: z.array(z.string()),
  visualStyle: VisualStyleTokens,
  /** The client's enabled platforms. */
  platforms: z.array(Platform),
});
export type BrandContext = z.infer<typeof BrandContext>;

export const PostMixItem = z.object({
  type: PostType,
  count: z.int().min(1).max(POST_COUNT_MAX),
});
export type PostMixItem = z.infer<typeof PostMixItem>;

/** Inclusive campaign window in the client's calendar. */
export const BriefWindow = z.object({
  start: IsoDate,
  end: IsoDate,
});
export type BriefWindow = z.infer<typeof BriefWindow>;

/** The resolved brief (manager.intake output, stored on Campaign.brief). */
export const Brief = z.object({
  clientId: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  productFocus: z.string().nullable(),
  audience: z.string().nullable(),
  keyMessages: z.array(z.string()),
  platforms: z.array(Platform).min(1),
  postCount: z.int().min(POST_COUNT_MIN).max(POST_COUNT_MAX),
  /** Must sum to postCount (checked by the intake validator). */
  postMix: z.array(PostMixItem).min(1),
  window: BriefWindow,
  cadenceNotes: z.string().nullable(),
  constraints: z.array(z.string()),
  /** Gaps the Manager filled itself instead of asking; shown to the user with the plan. */
  assumptions: z.array(z.string()),
});
export type Brief = z.infer<typeof Brief>;

/** Brief with every field nullable: what the Manager knows so far when it has to ask. */
export const BriefDraft = z.object({
  clientId: z.string().nullable(),
  title: z.string().nullable(),
  objective: z.string().nullable(),
  productFocus: z.string().nullable(),
  audience: z.string().nullable(),
  keyMessages: z.array(z.string()).nullable(),
  platforms: z.array(Platform).nullable(),
  postCount: z.int().min(POST_COUNT_MIN).max(POST_COUNT_MAX).nullable(),
  postMix: z.array(PostMixItem).nullable(),
  window: z.object({ start: IsoDate.nullable(), end: IsoDate.nullable() }).nullable(),
  cadenceNotes: z.string().nullable(),
  constraints: z.array(z.string()).nullable(),
  assumptions: z.array(z.string()).nullable(),
});
export type BriefDraft = z.infer<typeof BriefDraft>;

export const FeedbackSource = z.enum(["HUMAN", "QA"]);
export type FeedbackSource = z.infer<typeof FeedbackSource>;

/**
 * Revision feedback as stored on AgentTask.feedback and handed to the agent. `verbatim` is the
 * reviewer's text byte-for-byte: never trim or rewrite it on the way through.
 */
export const Feedback = z.object({
  verbatim: z.string(),
  source: FeedbackSource,
  /** The ApprovalDecision the feedback came from (HUMAN only). */
  decisionId: z.string().nullable(),
});
export type Feedback = z.infer<typeof Feedback>;

export const FeedbackInput = Feedback.nullable();
export type FeedbackInput = z.infer<typeof FeedbackInput>;

/** One post as an agent sees it (Copywriter input, Manager QA input). */
export const PostContext = z.object({
  ref: PostRef,
  type: PostType,
  platforms: z.array(Platform).min(1),
  targetDate: IsoDate,
  angle: z.string(),
  hook: z.string().nullable(),
  pillar: z.string().nullable(),
  /** From the Strategist (Phase 6): where the hook should land, in seconds. */
  targetHookSec: z.number().nullable(),
  /** The plan node's instructions for this step. */
  instructions: z.string().nullable(),
});
export type PostContext = z.infer<typeof PostContext>;
