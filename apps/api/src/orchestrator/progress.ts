import type { DbTransaction } from "@enmo/db";
import {
  AGENT_LABEL,
  aggregateProgress,
  formatProgress,
  PostCardPayload,
  ProgressPayload,
  type AgentName,
  type AgentState,
  type ChatMessageDto,
  type ProgressEntry,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { parseStored } from "../lib/stored";
import { EventBatch } from "./events";
import {
  CHAT_MESSAGE_SELECT,
  createAgentMessage,
  messageCreated,
  messageUpdated,
  toChatMessageDto,
} from "./messages";

/*
 * Live progress in the thread (DESIGN §D "Progress"). Every task transition re-counts the graph's
 * tasks and upserts the graph's single PROGRESS message (formatProgress line), then emits one
 * agent.status per changed task carrying that line. When an agent's share of the graph settles
 * (every task done, escalated, or blocked behind an escalated one) the agent signs a message saying
 * so; for the Manager's QA batch that message is the POST_CARD listing the posts that just landed
 * in approval. Blocked tasks count as settled so one escalated post doesn't keep every other
 * post's card out of the thread until a human resolves it.
 *
 * The recount runs under a row lock on the TaskGraph, so concurrent transitions serialise: the
 * PROGRESS message is created once, and each settled batch is announced once.
 */

export interface TaskTransition {
  taskId: string;
  agent: AgentName;
  postRef: string | null;
  state: AgentState;
}

const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/** What an agent finished, for the message it signs when its batch settles. */
const BATCH_DONE: Readonly<Record<AgentName, string>> = {
  STRATEGIST: "angles and hooks are set",
  COPYWRITER: "copy drafted",
  VISUAL_DIRECTOR: "visuals rendered",
  ADAPTER: "platform variants ready",
  MANAGER: "QA complete",
  ANALYST: "analysis complete",
  PUBLISHER: "slots scheduled",
};

/** Nothing of the agent's share is left that can run without a human. */
export function isSettled(entry: ProgressEntry): boolean {
  return entry.total > 0 && entry.done + entry.escalated + entry.blocked === entry.total;
}

/** Agents whose batch settled with this recount (and wasn't settled at the previous one). */
export function newlySettled(
  previous: readonly ProgressEntry[],
  current: readonly ProgressEntry[],
): ProgressEntry[] {
  return current.filter((entry) => {
    if (!isSettled(entry)) return false;
    const before = previous.find((candidate) => candidate.agent === entry.agent);
    return !before || !isSettled(before);
  });
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** What of the batch still needs a human, as sentences after the batch line. */
function attentionNote(entry: ProgressEntry): string {
  const escalated =
    entry.escalated > 0 ? ` ${plural(entry.escalated, "task")} escalated to a human.` : "";
  const blocked =
    entry.blocked > 0
      ? ` ${plural(entry.blocked, "task")} on hold until an escalated task is resolved.`
      : "";
  return escalated + blocked;
}

export function batchLine(entry: ProgressEntry): string {
  return `${AGENT_LABEL[entry.agent]} ✓ ${entry.done}/${entry.total} — ${BATCH_DONE[entry.agent]}.${attentionNote(entry)}`;
}

/** Recounts the graph after `transitions`, upserts its PROGRESS message and emits the events. */
export async function reportProgress(
  deps: Deps,
  graphId: string,
  transitions: readonly TaskTransition[],
): Promise<void> {
  const events = new EventBatch();
  const outcome = await deps.prisma.$transaction(
    (tx) => recount(tx, graphId, events),
    TRANSACTION_OPTIONS,
  );
  if (!outcome) return;
  for (const transition of transitions) {
    events.thread(outcome.threadId, "agent.status", {
      campaignId: outcome.campaignId,
      taskId: transition.taskId,
      agent: transition.agent,
      postRef: transition.postRef,
      state: transition.state,
      line: outcome.line,
    });
  }
  await events.publish(deps);
}

async function recount(tx: DbTransaction, graphId: string, events: EventBatch) {
  await tx.$queryRaw`SELECT id FROM "TaskGraph" WHERE id = ${graphId} FOR NO KEY UPDATE`;
  const graph = await tx.taskGraph.findUnique({
    where: { id: graphId },
    select: {
      id: true,
      campaignId: true,
      campaign: { select: { thread: { select: { id: true } } } },
    },
  });
  const threadId = graph?.campaign.thread?.id;
  if (!graph || !threadId) return null;

  const tasks = await tx.agentTask.findMany({
    where: { graphId },
    select: { id: true, agent: true, status: true, dependsOn: true },
  });
  const aggregate = aggregateProgress(tasks);
  const line = formatProgress(aggregate);
  const payload = { graphId, aggregate, line };

  const existing = await tx.chatMessage.findFirst({
    where: { threadId, kind: "PROGRESS", payload: { path: ["graphId"], equals: graphId } },
    orderBy: { createdAt: "asc" },
    select: CHAT_MESSAGE_SELECT,
  });

  let previous: ProgressEntry[] = [];
  if (existing) {
    previous = parseStored(
      ProgressPayload,
      existing.payload,
      `ChatMessage ${existing.id}.payload`,
    ).aggregate;
    const updated = await tx.chatMessage.update({
      where: { id: existing.id },
      data: { content: line, payload },
      select: CHAT_MESSAGE_SELECT,
    });
    messageUpdated(events, toChatMessageDto(updated));
  } else {
    const created = await createAgentMessage(tx, {
      threadId,
      agent: "MANAGER",
      kind: "PROGRESS",
      content: line,
      payload,
    });
    messageCreated(events, created);
  }

  for (const entry of newlySettled(previous, aggregate)) {
    const message = await announceBatch(tx, { threadId, campaignId: graph.campaignId, entry });
    if (message) messageCreated(events, message);
  }

  return { threadId, campaignId: graph.campaignId, line };
}

interface BatchContext {
  threadId: string;
  campaignId: string;
  entry: ProgressEntry;
}

async function announceBatch(
  tx: DbTransaction,
  { threadId, campaignId, entry }: BatchContext,
): Promise<ChatMessageDto | null> {
  if (entry.agent !== "MANAGER") {
    return createAgentMessage(tx, {
      threadId,
      agent: entry.agent,
      kind: "TEXT",
      content: batchLine(entry),
      payload: null,
    });
  }

  const postIds = await postsNewInApproval(tx, threadId, campaignId);
  if (postIds.length === 0) {
    return createAgentMessage(tx, {
      threadId,
      agent: "MANAGER",
      kind: "TEXT",
      content: batchLine(entry),
      payload: null,
    });
  }
  return createAgentMessage(tx, {
    threadId,
    agent: "MANAGER",
    kind: "POST_CARD",
    content: `${plural(postIds.length, "post")} passed QA and ${postIds.length === 1 ? "is" : "are"} waiting for approval.${attentionNote(entry)}`,
    payload: { postIds },
  });
}

/**
 * Posts whose open approval round started after the thread's last POST_CARD message (all open
 * rounds of the campaign for the first card). Timestamps have millisecond precision, so a round
 * stamped in the same millisecond as the last card counts as new unless that card listed it.
 */
async function postsNewInApproval(
  tx: DbTransaction,
  threadId: string,
  campaignId: string,
): Promise<string[]> {
  const lastCard = await tx.chatMessage.findFirst({
    where: { threadId, kind: "POST_CARD" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true, payload: true },
  });
  const announced = lastCard
    ? new Set(
        parseStored(PostCardPayload, lastCard.payload, `ChatMessage ${lastCard.id}.payload`)
          .postIds,
      )
    : new Set<string>();
  const requests = await tx.approvalRequest.findMany({
    where: {
      status: "PENDING",
      post: { campaignId },
      ...(lastCard ? { createdAt: { gte: lastCard.createdAt } } : {}),
    },
    select: { postId: true, createdAt: true, post: { select: { ref: true } } },
  });
  return requests
    .filter(
      (request) =>
        !lastCard || request.createdAt > lastCard.createdAt || !announced.has(request.postId),
    )
    .sort((a, b) => refNumber(a.post.ref) - refNumber(b.post.ref))
    .map((request) => request.postId);
}

/** "p12" → 12, so posts list in plan order. */
export function refNumber(ref: string): number {
  const match = /^p(\d+)$/.exec(ref);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
