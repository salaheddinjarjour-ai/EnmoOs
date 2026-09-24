import { z } from "zod";
import {
  AgentName,
  ApprovalStatus,
  AssetStatus,
  Platform,
  PostStatus,
  PublishStatus,
} from "./enums";
import { KanbanColumn, StatusPill } from "./status";
import { BudgetDto } from "./dto/budget";
import { Id, IsoDateTime } from "./dto/common";
import { ChatMessageDto } from "./dto/thread";

/*
 * Realtime events (DESIGN §D). The worker/API inserts a RealtimeEvent row, then PUBLISHes
 * {id, channel, type, payload} on realtimeRedisChannel(BULLMQ_PREFIX); the API hub fans it out as
 * SSE frames (`id:` row id, `event:` type, `data:` JSON payload).
 */

export const GLOBAL_CHANNEL = "global";

/**
 * The Redis pub/sub channel of one deployment: `<BULLMQ_PREFIX>:rt`, "enmo:rt" by default. Envelope
 * ids are RealtimeEvent rows of one database, so environments (or test runs) sharing a Redis must
 * never receive each other's envelopes; the prefix already tells them apart.
 */
export function realtimeRedisChannel(prefix: string): string {
  return `${prefix}:rt`;
}

/** SSE timing and replay limits shared by the hub, the client and the tests. */
export const SSE_RETRY_MS = 3000;
export const SSE_HEARTBEAT_MS = 15_000;
/** Replaying more missed events than this sends `resync` instead. */
export const SSE_REPLAY_LIMIT = 500;

export type ThreadChannel = `thread:${string}`;
export type RealtimeChannel = typeof GLOBAL_CHANNEL | ThreadChannel;

export function threadChannel(threadId: string): ThreadChannel {
  return `thread:${threadId}`;
}

/** The thread id of a `thread:<id>` channel, or null. */
export function threadIdOfChannel(channel: string): string | null {
  return channel.startsWith("thread:") && channel.length > 7 ? channel.slice(7) : null;
}

export function isRealtimeChannel(channel: string): channel is RealtimeChannel {
  return channel === GLOBAL_CHANNEL || threadIdOfChannel(channel) !== null;
}

/* ─── payloads ───────────────────────────────────────────────────────────────────────────────── */

export const MessageEventPayload = z.object({
  threadId: Id,
  message: ChatMessageDto,
});
export type MessageEventPayload = z.infer<typeof MessageEventPayload>;

export const AgentState = z.enum(["queued", "running", "done", "waiting", "escalated"]);
export type AgentState = z.infer<typeof AgentState>;

export const AgentStatusPayload = z.object({
  campaignId: Id,
  taskId: Id,
  agent: AgentName,
  postRef: z.string().nullable(),
  state: AgentState,
  /** formatProgress() for the whole graph after this transition. */
  line: z.string(),
});
export type AgentStatusPayload = z.infer<typeof AgentStatusPayload>;

export const PlanProposedPayload = z.object({
  campaignId: Id,
  threadId: Id,
  graphId: Id,
  version: z.int().positive(),
});
export type PlanProposedPayload = z.infer<typeof PlanProposedPayload>;

export const PostUpdatedPayload = z.object({
  postId: Id,
  campaignId: Id,
  clientId: Id,
  status: PostStatus,
  column: KanbanColumn,
  pill: StatusPill,
  needsAttention: z.boolean(),
});
export type PostUpdatedPayload = z.infer<typeof PostUpdatedPayload>;

export const AssetUpdatedPayload = z.object({
  assetId: Id,
  clientId: Id,
  campaignId: Id.nullable(),
  postId: Id.nullable(),
  status: AssetStatus,
  version: z.int().positive(),
  isCurrent: z.boolean(),
});
export type AssetUpdatedPayload = z.infer<typeof AssetUpdatedPayload>;

export const ApprovalCreatedPayload = z.object({
  requestId: Id,
  postId: Id,
  campaignId: Id,
  clientId: Id,
  round: z.int().positive(),
});
export type ApprovalCreatedPayload = z.infer<typeof ApprovalCreatedPayload>;

export const ApprovalResolvedPayload = ApprovalCreatedPayload.extend({
  status: ApprovalStatus,
});
export type ApprovalResolvedPayload = z.infer<typeof ApprovalResolvedPayload>;

export const PublishUpdatedPayload = z.object({
  jobId: Id,
  variantId: Id,
  postId: Id,
  platform: Platform,
  status: PublishStatus,
  scheduledFor: IsoDateTime,
  liveUrl: z.string().nullable(),
});
export type PublishUpdatedPayload = z.infer<typeof PublishUpdatedPayload>;

export const AlertKind = z.enum(["stuck", "failed", "escalated", "budget", "token_expiring"]);
export type AlertKind = z.infer<typeof AlertKind>;

export const AlertPayload = z.object({
  kind: AlertKind,
  /** e.g. "AgentTask", "Post", "SocialAccount". */
  entityType: z.string(),
  entityId: Id.nullable(),
  message: z.string(),
  clientId: Id.nullable(),
  campaignId: Id.nullable(),
});
export type AlertPayload = z.infer<typeof AlertPayload>;

export const LearningCreatedPayload = z.object({
  learningId: Id,
  clientId: Id,
  takeaway: z.string(),
});
export type LearningCreatedPayload = z.infer<typeof LearningCreatedPayload>;

export const ResyncPayload = z.object({
  reason: z.string(),
});
export type ResyncPayload = z.infer<typeof ResyncPayload>;

/** Payload schema per event type. */
export const REALTIME_PAYLOADS = {
  "message.created": MessageEventPayload,
  "message.updated": MessageEventPayload,
  "agent.status": AgentStatusPayload,
  "plan.proposed": PlanProposedPayload,
  "post.updated": PostUpdatedPayload,
  "asset.updated": AssetUpdatedPayload,
  "approval.created": ApprovalCreatedPayload,
  "approval.resolved": ApprovalResolvedPayload,
  "publish.updated": PublishUpdatedPayload,
  alert: AlertPayload,
  "learning.created": LearningCreatedPayload,
  "budget.updated": BudgetDto,
  resync: ResyncPayload,
} as const;

export type RealtimeEventType = keyof typeof REALTIME_PAYLOADS;
export type RealtimePayload<T extends RealtimeEventType> = z.infer<(typeof REALTIME_PAYLOADS)[T]>;

export const RealtimeEventType = z.enum(
  Object.keys(REALTIME_PAYLOADS) as [RealtimeEventType, ...RealtimeEventType[]],
);

/**
 * Thread-scoped types go to `thread:<id>`; everything else to `global`. The SSE endpoint always
 * subscribes to global, plus the thread when the page names one.
 */
export const REALTIME_EVENT_SCOPE: Readonly<Record<RealtimeEventType, "thread" | "global">> = {
  "message.created": "thread",
  "message.updated": "thread",
  "agent.status": "thread",
  "plan.proposed": "thread",
  "post.updated": "global",
  "asset.updated": "global",
  "approval.created": "global",
  "approval.resolved": "global",
  "publish.updated": "global",
  alert: "global",
  "learning.created": "global",
  "budget.updated": "global",
  resync: "global",
};

function eventSchema<T extends RealtimeEventType, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), payload });
}

/** `{type, payload}`, discriminated on type. */
export const RealtimeEvent = z.discriminatedUnion("type", [
  eventSchema("message.created", MessageEventPayload),
  eventSchema("message.updated", MessageEventPayload),
  eventSchema("agent.status", AgentStatusPayload),
  eventSchema("plan.proposed", PlanProposedPayload),
  eventSchema("post.updated", PostUpdatedPayload),
  eventSchema("asset.updated", AssetUpdatedPayload),
  eventSchema("approval.created", ApprovalCreatedPayload),
  eventSchema("approval.resolved", ApprovalResolvedPayload),
  eventSchema("publish.updated", PublishUpdatedPayload),
  eventSchema("alert", AlertPayload),
  eventSchema("learning.created", LearningCreatedPayload),
  eventSchema("budget.updated", BudgetDto),
  eventSchema("resync", ResyncPayload),
]);
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

/** What travels over Redis and is replayed from the RealtimeEvent table (id = row id as a string). */
export type RealtimeEnvelope = RealtimeEvent & { id: string; channel: string };

/** Validates an SSE frame (`event:` type + parsed `data:`) into a typed event. */
export function parseRealtimeEvent(type: string, payload: unknown) {
  return RealtimeEvent.safeParse({ type, payload });
}

/** One SSE frame. JSON.stringify never emits a raw newline, so `data:` stays one line. */
export function formatSseFrame(event: { id: string; type: string; payload: unknown }): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}
