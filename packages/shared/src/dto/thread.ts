import { z } from "zod";
import { AgentName, MessageRole } from "../enums";
import { Brief } from "../contracts/common";
import { Issue } from "../contracts/issues";
import { IntakeClarify } from "../contracts/manager";
import { ProgressAggregate } from "../progress";
import { Id, IsoDateTime, NamedRef, listResponse } from "./common";

/* ChatMessage.payload by kind. The worker writes them with these schemas, the web renders them. */

/** The one consolidated question (ClarifyCard). */
export const ClarifyPayload = IntakeClarify.omit({ kind: true });
export type ClarifyPayload = z.infer<typeof ClarifyPayload>;

/** The resolved brief, read back to the user. */
export const BriefPayload = z.object({
  brief: Brief,
  confirmation: z.string(),
});
export type BriefPayload = z.infer<typeof BriefPayload>;

/** A proposed plan (PlanCard); the card loads GET /task-graphs/:graphId. */
export const PlanPayload = z.object({
  graphId: Id,
  version: z.int().positive(),
});
export type PlanPayload = z.infer<typeof PlanPayload>;

/** The single live progress line per graph (upserted, so it arrives as message.updated). */
export const ProgressPayload = z.object({
  graphId: Id,
  aggregate: ProgressAggregate,
  line: z.string(),
});
export type ProgressPayload = z.infer<typeof ProgressPayload>;

/** Posts that just landed in approval (PostCards + ApproveAllBar). */
export const PostCardPayload = z.object({
  postIds: z.array(Id).min(1),
});
export type PostCardPayload = z.infer<typeof PostCardPayload>;

/** A task the Arsenal gave up on (the Manager signs it). */
export const EscalationPayload = z.object({
  taskId: Id,
  agent: AgentName,
  action: z.string(),
  postId: Id.nullable(),
  postRef: z.string().nullable(),
  /** AgentEscalation.reason, e.g. INVALID_OUTPUT or REFUSED. */
  reason: z.string(),
  issues: z.array(Issue),
});
export type EscalationPayload = z.infer<typeof EscalationPayload>;

const ChatMessageBase = z.object({
  id: Id,
  threadId: Id,
  role: MessageRole,
  /** The signing agent (role AGENT). */
  agent: AgentName.nullable(),
  /** The teammate who wrote it (role USER). */
  author: NamedRef.nullable(),
  content: z.string(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ChatMessageDto = z.discriminatedUnion("kind", [
  ChatMessageBase.extend({ kind: z.literal("TEXT"), payload: z.null() }),
  ChatMessageBase.extend({ kind: z.literal("CLARIFY"), payload: ClarifyPayload }),
  ChatMessageBase.extend({ kind: z.literal("BRIEF"), payload: BriefPayload }),
  ChatMessageBase.extend({ kind: z.literal("PLAN"), payload: PlanPayload }),
  ChatMessageBase.extend({ kind: z.literal("PROGRESS"), payload: ProgressPayload }),
  ChatMessageBase.extend({ kind: z.literal("POST_CARD"), payload: PostCardPayload }),
  ChatMessageBase.extend({ kind: z.literal("ESCALATION"), payload: EscalationPayload }),
]);
export type ChatMessageDto = z.infer<typeof ChatMessageDto>;

/** The payload schema per MessageKind, for writers that build a message before storing it. */
export const CHAT_MESSAGE_PAYLOAD = {
  TEXT: z.null(),
  CLARIFY: ClarifyPayload,
  BRIEF: BriefPayload,
  PLAN: PlanPayload,
  PROGRESS: ProgressPayload,
  POST_CARD: PostCardPayload,
  ESCALATION: EscalationPayload,
} as const;
export type ChatMessagePayload<K extends ChatMessageDto["kind"]> = z.infer<
  (typeof CHAT_MESSAGE_PAYLOAD)[K]
>;

/** GET /v1/threads/:id/messages — oldest first; `after` is a message id (exclusive cursor). */
export const ThreadMessagesQuery = z.object({
  after: Id.optional(),
});
export type ThreadMessagesQuery = z.infer<typeof ThreadMessagesQuery>;

export const ThreadMessagesResponse = listResponse(ChatMessageDto);
export type ThreadMessagesResponse = z.infer<typeof ThreadMessagesResponse>;

export const CHAT_MESSAGE_MAX_LENGTH = 8000;

/**
 * POST /v1/threads/:id/messages → ChatMessageDto (the stored user message). Taken as sent: the API
 * trims a brief turn, but a message that re-plans after a failed planning attempt is the plan's
 * change request, which reaches the Manager byte-for-byte (VerbatimText, so at most
 * VERBATIM_TEXT_MAX_LENGTH characters).
 */
export const PostMessageRequest = z.object({
  content: z
    .string()
    .max(CHAT_MESSAGE_MAX_LENGTH)
    .refine((text) => text.trim().length > 0, "Can't be blank"),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;
