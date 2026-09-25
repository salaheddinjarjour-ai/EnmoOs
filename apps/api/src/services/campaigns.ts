import type { Prisma } from "@enmo/db";
import {
  Brief,
  VERBATIM_TEXT_MAX_LENGTH,
  VerbatimText,
  type CampaignDto,
  type CampaignListQuery,
  type ChatMessageDto,
  type CreateCampaignRequest,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueManagerIntake, type ManagerPlanJob } from "../jobs/queues";
import { AppError, conflict, notFound } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { approvalResolved } from "../orchestrator/approval-round";
import { EventBatch } from "../orchestrator/events";
import { lockCampaignRounds } from "../orchestrator/locks";
import {
  CHAT_MESSAGE_SELECT,
  createMessage,
  messageCreated,
  toChatMessageDto,
} from "../orchestrator/messages";
import { enqueuePlanDraft, isPlanBeingDrafted } from "../orchestrator/plan";
import { postUpdated } from "../orchestrator/post-status";
import { reportProgress } from "../orchestrator/progress";
import { cancelScheduledWhere } from "../orchestrator/publishing";
import { UNFINISHED_STATUSES } from "../orchestrator/tasks";
import type { ServiceUser } from "./actor";

/*
 * Campaigns and their chat thread (DESIGN §B "Campaigns and chat", §D, §E). Every stored message
 * is emitted as message.created on the thread channel. A user message is stored before its job is
 * queued; when Redis refuses the job the message (or the new campaign) is removed again, so a
 * retry by the user doesn't leave a duplicate turn behind.
 */

const CAMPAIGN_INCLUDE = {
  client: { select: { id: true, name: true } },
  thread: { select: { id: true } },
  taskGraphs: {
    orderBy: { version: "desc" },
    take: 1,
    select: { id: true, version: true, status: true },
  },
} as const satisfies Prisma.CampaignInclude;

type CampaignRow = Prisma.CampaignGetPayload<{ include: typeof CAMPAIGN_INCLUDE }>;

export const CAMPAIGN_NAME_MAX = 80;

/** A working title from the first brief turn, until the brief names the campaign. */
export function campaignNameFrom(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (firstLine.length <= CAMPAIGN_NAME_MAX) return firstLine || "New campaign";
  return `${firstLine.slice(0, CAMPAIGN_NAME_MAX - 1).trimEnd()}…`;
}

export function toCampaignDto(row: CampaignRow): CampaignDto {
  if (!row.thread) throw new Error(`Campaign ${row.id} has no chat thread`);
  const latest = row.taskGraphs[0];
  return {
    id: row.id,
    client: row.client,
    name: row.name,
    status: row.status,
    brief: row.brief === null ? null : parseStored(Brief, row.brief, `Campaign ${row.id}.brief`),
    clarifyCount: row.clarifyCount,
    threadId: row.thread.id,
    briefAt: row.briefAt.toISOString(),
    briefLockedAt: row.briefLockedAt?.toISOString() ?? null,
    createdById: row.createdById,
    latestGraph: latest ? { id: latest.id, version: latest.version, status: latest.status } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * POST /campaigns. Creates the Campaign (BRIEFING; clientId from the request, else null until the
 * brief resolves one; briefAt = clock.now()), its ChatThread and the USER TEXT message holding
 * `message` verbatim, then enqueues manager.intake for that message. NOT_FOUND when `clientId` is
 * unknown or archived.
 */
export async function createCampaignFromMessage(
  deps: Deps,
  user: ServiceUser,
  input: CreateCampaignRequest,
): Promise<CampaignDto> {
  if (input.clientId) {
    const client = await deps.prisma.client.findUnique({
      where: { id: input.clientId },
      select: { archivedAt: true },
    });
    if (!client || client.archivedAt) throw notFound("Client");
  }

  const { campaign, message } = await deps.prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        clientId: input.clientId ?? null,
        name: campaignNameFrom(input.message),
        status: "BRIEFING",
        briefAt: deps.clock.now(),
        createdById: user.id,
        thread: { create: {} },
      },
      // One relation only: a transaction runs one query at a time (the DTO is read after commit).
      select: { id: true, thread: { select: { id: true } } },
    });
    if (!campaign.thread) throw new Error("Campaign thread was not created");
    const message = await createMessage(tx, {
      threadId: campaign.thread.id,
      role: "USER",
      kind: "TEXT",
      userId: user.id,
      content: input.message,
      payload: null,
    });
    return { campaign, message };
  });

  try {
    await enqueueManagerIntake(deps.queues, { campaignId: campaign.id, messageId: message.id });
  } catch (error) {
    await deps.prisma.campaign.delete({ where: { id: campaign.id } });
    throw error;
  }
  await messageCreated(new EventBatch(), message).publish(deps);
  return getCampaign(deps, campaign.id);
}

/**
 * POST /threads/:id/messages. Stores the USER TEXT message (trimmed) and, while the brief is not
 * locked yet, enqueues manager.intake for it (the answer to the clarifying question). After a
 * failed planning attempt (the brief is locked but no plan was proposed) the message is the
 * adjustment the Manager asked for: it is stored and passed on byte-for-byte as the change request
 * the plan is drafted again with, so it must be VerbatimText (VALIDATION_FAILED when longer).
 * Returns the stored message. NOT_FOUND for an unknown thread; CONFLICT when the campaign is
 * archived.
 */
export async function postUserMessage(
  deps: Deps,
  user: ServiceUser,
  threadId: string,
  content: string,
): Promise<ChatMessageDto> {
  const thread = await deps.prisma.chatThread.findUnique({
    where: { id: threadId },
    select: {
      campaign: {
        select: {
          id: true,
          status: true,
          briefLockedAt: true,
          taskGraphs: {
            orderBy: { version: "desc" },
            select: { id: true, version: true, status: true },
          },
        },
      },
    },
  });
  if (!thread) throw notFound("Thread");
  const { campaign } = thread;
  if (campaign.status === "ARCHIVED") throw conflict("The campaign is archived");
  const replan =
    campaign.briefLockedAt !== null && needsReplan(campaign.status, campaign.taskGraphs);
  if (replan) assertChangeRequest(content);

  const message = await createMessage(deps.prisma, {
    threadId,
    role: "USER",
    kind: "TEXT",
    userId: user.id,
    content: replan ? content : content.trim(),
    payload: null,
  });

  try {
    if (!campaign.briefLockedAt) {
      await enqueueManagerIntake(deps.queues, { campaignId: campaign.id, messageId: message.id });
    } else if (replan) {
      await enqueueReplan(deps, campaign.id, campaign.taskGraphs, message);
    }
  } catch (error) {
    await deps.prisma.chatMessage.delete({ where: { id: message.id } });
    throw error;
  }
  await messageCreated(new EventBatch(), message).publish(deps);
  return message;
}

/** A chat message that becomes a plan's change request must fit ManagerPlanJob.changeRequest. */
function assertChangeRequest(content: string): void {
  if (VerbatimText.safeParse(content).success) return;
  throw new AppError("VALIDATION_FAILED", "The change request is too long", {
    details: {
      issues: [
        {
          path: "content",
          message: `A change to the plan can be up to ${VERBATIM_TEXT_MAX_LENGTH.toLocaleString("en-US")} characters; this one has ${content.length.toLocaleString("en-US")}.`,
        },
      ],
    },
  });
}

/** Planning, but no plan on the table: the last planning attempt failed. */
function needsReplan(status: string, graphs: readonly { status: string }[]): boolean {
  return (
    status === "PLANNING" &&
    !graphs.some((graph) => graph.status === "PROPOSED" || graph.status === "APPROVED")
  );
}

async function enqueueReplan(
  deps: Deps,
  campaignId: string,
  graphs: readonly { id: string; version: number }[],
  message: ChatMessageDto,
): Promise<void> {
  const latest = graphs[0];
  const data: ManagerPlanJob = {
    campaignId,
    version: (latest?.version ?? 0) + 1,
    changeRequest: message.content,
    previousGraphId: latest?.id ?? null,
  };
  // While that version is still being drafted, this message is just part of the conversation.
  if (await isPlanBeingDrafted(deps, campaignId, data.version)) return;
  await enqueuePlanDraft(deps, data, message.id);
}

/** GET /campaigns: newest first, filtered by client and status. */
export async function listCampaigns(deps: Deps, query: CampaignListQuery): Promise<CampaignDto[]> {
  const rows = await deps.prisma.campaign.findMany({
    where: { clientId: query.clientId, status: query.status },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: CAMPAIGN_INCLUDE,
  });
  return rows.map(toCampaignDto);
}

/** GET /campaigns/:id. NOT_FOUND when missing. */
export async function getCampaign(deps: Deps, campaignId: string): Promise<CampaignDto> {
  const row = await deps.prisma.campaign.findUnique({
    where: { id: campaignId },
    include: CAMPAIGN_INCLUDE,
  });
  if (!row) throw notFound("Campaign");
  return toCampaignDto(row);
}

/**
 * POST /campaigns/:id/archive. Moves the campaign to ARCHIVED and cancels its unfinished
 * AgentTasks so no further spend happens; a proposed plan is rejected and open approval rounds are
 * cancelled, so nothing of it waits on a human, and every PublishJob still waiting for its slot is
 * cancelled, so nothing of it goes out (a SCHEDULED post is APPROVED again). Its posts otherwise
 * keep their status (and stay readable in the thread) but leave the pipeline: GET /posts drops them
 * unless asked for the campaign, and post.updated tells open boards to refetch. Idempotent.
 * NOT_FOUND when missing.
 */
export async function archiveCampaign(
  deps: Deps,
  _user: ServiceUser,
  campaignId: string,
): Promise<CampaignDto> {
  const existing = await deps.prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, clientId: true },
  });
  if (!existing) throw notFound("Campaign");
  if (existing.status === "ARCHIVED") return getCampaign(deps, campaignId);

  const now = deps.clock.now();
  const events = new EventBatch();
  const graphIds = await deps.prisma.$transaction(async (tx) => {
    // The campaign row first, then rounds, then posts (locks.ts): a copy edit takes them in the
    // same order, so it either lands before the archive (and its new round is cancelled here) or
    // sees the campaign archived.
    await tx.campaign.update({ where: { id: campaignId }, data: { status: "ARCHIVED" } });
    await tx.taskGraph.updateMany({
      where: { campaignId, status: "PROPOSED" },
      data: { status: "REJECTED" },
    });
    const cancelled = await tx.agentTask.updateManyAndReturn({
      where: { graph: { campaignId }, status: { in: [...UNFINISHED_STATUSES] } },
      data: { status: "CANCELLED", finishedAt: now },
      select: { graphId: true },
    });
    await lockCampaignRounds(tx, campaignId, ["PENDING"]);
    const rounds = await tx.approvalRequest.updateManyAndReturn({
      where: { post: { campaignId }, status: "PENDING" },
      data: { status: "CANCELLED", resolvedAt: now },
      include: { post: { select: { campaignId: true, clientId: true } } },
    });
    for (const round of rounds) {
      approvalResolved(events, round, {
        campaignId: round.post.campaignId,
        clientId: round.post.clientId,
      });
    }
    await cancelScheduledWhere(tx, events, { campaignId }, "campaignArchived");
    return [...new Set(cancelled.map((task) => task.graphId))];
  });

  const posts = await deps.prisma.post.findMany({ where: { campaignId } });
  for (const post of posts) postUpdated(events, post);
  await events.publish(deps);
  for (const graphId of graphIds) await reportProgress(deps, graphId, []);
  return getCampaign(deps, campaignId);
}

/**
 * GET /threads/:id/messages. Oldest first; `after` is a message id (exclusive cursor), so a client
 * catching up passes the last id it has. NOT_FOUND for an unknown thread or cursor.
 */
export async function listMessages(
  deps: Deps,
  threadId: string,
  after?: string,
): Promise<ChatMessageDto[]> {
  const thread = await deps.prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { id: true },
  });
  if (!thread) throw notFound("Thread");

  let where: Prisma.ChatMessageWhereInput = { threadId };
  if (after) {
    const cursor = await deps.prisma.chatMessage.findFirst({
      where: { id: after, threadId },
      select: { id: true, createdAt: true },
    });
    if (!cursor) throw notFound("Message");
    where = {
      threadId,
      OR: [
        { createdAt: { gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { gt: cursor.id } },
      ],
    };
  }
  const rows = await deps.prisma.chatMessage.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: CHAT_MESSAGE_SELECT,
  });
  return rows.map(toChatMessageDto);
}
