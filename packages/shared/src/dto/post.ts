import { z } from "zod";
import { ApprovalStatus, Platform, PostStatus, PostType } from "../enums";
import { KanbanColumn, StatusPill } from "../status";
import {
  COPY_LIMITS,
  CopywriterOutput,
  PlatformCaption,
  Scene,
  Script,
  Slide,
} from "../contracts/copywriter";
import { Issue } from "../contracts/issues";
import { Id, IsoDate, IsoDateTime, listResponse } from "./common";

/** The post's open (or latest) approval round, enough for a card's buttons. */
export const ApprovalSummary = z.object({
  id: Id,
  round: z.int().positive(),
  status: ApprovalStatus,
  currentStep: z.int().nonnegative(),
  stepCount: z.int().positive(),
  /** Name of the current step ("Manager review"). */
  stepName: z.string().nullable(),
  /** Whether the viewer may decide the current step now. */
  canDecide: z.boolean(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummary>;

export const PostDto = z.object({
  id: Id,
  campaignId: Id,
  clientId: Id,
  ref: z.string(),
  type: PostType,
  platforms: z.array(Platform),
  status: PostStatus,
  /** From postPlacement(status): where the card sits and which pill it shows. */
  column: KanbanColumn,
  pill: StatusPill,
  /** Past human approval: the card gets the green border. */
  approved: z.boolean(),
  failed: z.boolean(),
  targetDate: IsoDate.nullable(),
  pillar: z.string().nullable(),
  angle: z.string().nullable(),
  hook: z.string().nullable(),
  copy: CopywriterOutput.nullable(),
  humanEditCount: z.int().nonnegative(),
  /**
   * Whether PATCH /posts/:id/copy would take an edit now: the post has copy in a
   * COPY_EDITABLE_STATUSES status, no agent work is pending on it and its campaign isn't archived.
   * The API answers 409 otherwise.
   */
  editable: z.boolean(),
  revision: z.int().nonnegative(),
  needsAttention: z.boolean(),
  attentionReason: z.string().nullable(),
  qaNotes: z.string().nullable(),
  approvedAt: IsoDateTime.nullable(),
  liveAt: IsoDateTime.nullable(),
  currentApproval: ApprovalSummary.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PostDto = z.infer<typeof PostDto>;

/** GET /v1/posts */
export const PostListQuery = z.object({
  clientId: Id.optional(),
  campaignId: Id.optional(),
  status: PostStatus.optional(),
  platform: Platform.optional(),
});
export type PostListQuery = z.infer<typeof PostListQuery>;

export const PostListResponse = listResponse(PostDto);
export type PostListResponse = z.infer<typeof PostListResponse>;

/**
 * Hard bounds on a human copy edit, on top of the CopywriterOutput shape. The caption and hashtag
 * limits are the Copywriter contract's own; the rest keep any one field, and the whole body, small
 * enough to check cheaply. The contract rules that depend on the post (its type and platforms)
 * are checked by the API and answered with a 422.
 */
export const EDITED_COPY_BOUNDS = {
  /** Any other text field: no longer than a caption. */
  textMaxChars: COPY_LIMITS.captionMaxChars,
  hashtagMaxChars: 100,
  platformCaptionsMax: 10,
  /** 90s of script at 1.5s a scene. */
  scenesMax: 60,
  /** PATCH /posts/:id/copy body limit, in bytes. */
  bodyMaxBytes: 128 * 1024,
} as const;

const EditedText = z.string().max(EDITED_COPY_BOUNDS.textMaxChars);
const EditedCaption = z.string().max(COPY_LIMITS.captionMaxChars);

/** CopywriterOutput as a human may send it (PATCH /posts/:id/copy). */
export const EditedCopy = CopywriterOutput.extend({
  caption: EditedCaption,
  hashtags: z
    .array(z.string().max(EDITED_COPY_BOUNDS.hashtagMaxChars))
    .max(COPY_LIMITS.hashtagsMax),
  cta: EditedText,
  altText: EditedText,
  platformCaptions: z
    .array(PlatformCaption.extend({ caption: EditedCaption }))
    .max(EDITED_COPY_BOUNDS.platformCaptionsMax),
  script: Script.extend({
    hookText: EditedText,
    scenes: z
      .array(
        Scene.extend({ voiceover: EditedText, overlayText: EditedText, visualNote: EditedText }),
      )
      .min(1)
      .max(EDITED_COPY_BOUNDS.scenesMax),
  }).nullable(),
  slides: z
    .array(Slide.extend({ headline: EditedText, body: EditedText }))
    .max(COPY_LIMITS.slidesMax)
    .nullable(),
  onScreenText: EditedText.nullable(),
});
export type EditedCopy = z.infer<typeof EditedCopy>;

/**
 * PATCH /v1/posts/:id/copy → PostDto. Replaces Post.copy with the edited copy; increments
 * humanEditCount; after approval it reopens approval. Banned words → 422 with
 * BannedWordsErrorDetails as `error.details`; copy that breaks the Copywriter contract for this
 * post (DESIGN §C: its shape, script timing, slides, one caption per platform, hashtags) → 422
 * with CopyRuleErrorDetails. A post that isn't PostDto.editable → 409.
 */
export const UpdatePostCopyRequest = z.object({
  copy: EditedCopy,
});
export type UpdatePostCopyRequest = z.infer<typeof UpdatePostCopyRequest>;

/** The broken Copywriter contract rules, each at the JSON path of its field ("" for the copy). */
export const CopyRuleErrorDetails = z.object({
  issues: z.array(Issue).min(1),
});
export type CopyRuleErrorDetails = z.infer<typeof CopyRuleErrorDetails>;

/** A banned-word hit as returned in 422 error details (see banned-words.ts BannedWordHit). */
export const BannedWordHitDto = z.object({
  path: z.string(),
  term: z.string(),
  index: z.int().nonnegative(),
  length: z.int().nonnegative(),
  match: z.string(),
});
export type BannedWordHitDto = z.infer<typeof BannedWordHitDto>;

export const BannedWordsErrorDetails = z.object({
  bannedWords: z.array(BannedWordHitDto).min(1),
});
export type BannedWordsErrorDetails = z.infer<typeof BannedWordsErrorDetails>;
