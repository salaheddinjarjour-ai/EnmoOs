import { AgentEscalation, BudgetExceeded, InvalidAgentInput } from "@enmo/agents";
import type { Campaign, Client, DbTransaction } from "@enmo/db";
import type { IntakeBrief, IntakeClarify, IntakeMessage, ManagerIntakeInput } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueManagerPlan, type ManagerIntakeJob } from "../jobs/queues";
import type { RunAttempt } from "../jobs/types";
import { calendarDay } from "../lib/clock";
import { runAgentFor } from "./agent-run";
import {
  deferForBudget,
  INTAKE_UNAVAILABLE_REPLY,
  INVALID_INPUT_REPLY,
  reportAgentFailure,
  reportJobFailure,
} from "./agent-failure";
import { brandContextOf } from "./context";
import { EventBatch } from "./events";
import { lockCampaign } from "./locks";
import { createAgentMessage, messageCreated } from "./messages";

/*
 * manager.intake (DESIGN §C "Manager intake"): the Manager reads the whole thread and either asks
 * its ONE consolidated clarifying question or locks the brief. Campaign.clarifyCount enforces the
 * single question: once it is 1 the no-clarify contract is used, so any remaining gaps become
 * written assumptions on the brief.
 *
 * Every team message queues its own intake, but only the newest open turn is answered: a job whose
 * message is no longer the newest USER message, or already has a CLARIFY or BRIEF after it, does
 * nothing, because the newer turn's job reads the same thread. The reply is only written while the
 * turn is still current (checked under the campaign's row lock), so two messages sent close
 * together (two teammates, two tabs, budget-parked jobs firing at once) get one question that
 * waits for its answer, not a question followed at once by a brief locked on guesses.
 *
 * Until the brief locks, Campaign.clientId is only ever the client the team picked when starting
 * the campaign: it binds the brief (selectedClientId). The client the Manager guessed for its
 * question stays in the CLARIFY draft, so the team's answer can still name another one.
 */

type CampaignWithClient = Campaign & { client: Client | null };

/** The turn a job answers, as it stood when the thread was read. */
interface IntakeTurn {
  /** The USER message the job answers: the newest one when the thread was read. */
  messageId: string;
  /** Campaign.clarifyCount when the thread was read. */
  clarifyCount: number;
}

interface ThreadMessage extends IntakeMessage {
  id: string;
}

export async function runIntake(
  deps: Deps,
  job: ManagerIntakeJob,
  attempt: RunAttempt,
): Promise<void> {
  try {
    await readThread(deps, job);
  } catch (error) {
    // An InvalidAgentInput was reported already, and runtime.ts fails it for good on any attempt.
    if (attempt.isLast && !(error instanceof InvalidAgentInput)) {
      await reportJobFailure(deps, {
        campaignId: job.campaignId,
        action: "intake",
        error,
        content: INTAKE_UNAVAILABLE_REPLY,
      });
    }
    throw error;
  }
}

/**
 * Whether `messageId` is the turn the Manager owes an answer: the newest USER message, with no
 * CLARIFY or BRIEF after it. `thread` is oldest first.
 */
export function isOpenTurn(thread: readonly ThreadMessage[], messageId: string): boolean {
  const index = thread.findIndex((message) => message.id === messageId);
  if (index < 0 || thread[index]?.role !== "USER") return false;
  return !thread
    .slice(index + 1)
    .some(
      (message) =>
        message.role === "USER" ||
        (message.role === "AGENT" && (message.kind === "CLARIFY" || message.kind === "BRIEF")),
    );
}

async function readThread(deps: Deps, job: ManagerIntakeJob): Promise<void> {
  const campaign = await deps.prisma.campaign.findUnique({
    where: { id: job.campaignId },
    include: {
      client: true,
      thread: {
        select: {
          id: true,
          messages: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, role: true, kind: true, agent: true, content: true },
          },
        },
      },
    },
  });
  if (!campaign?.thread || campaign.status === "ARCHIVED") return;
  if (campaign.briefLockedAt) {
    // A retry after the brief was locked: make sure the first plan was queued.
    await ensureFirstPlanQueued(deps, campaign.id);
    return;
  }
  const { messages } = campaign.thread;
  if (!isOpenTurn(messages, job.messageId)) return;
  const turn: IntakeTurn = { messageId: job.messageId, clarifyCount: campaign.clarifyCount };

  const clients = await deps.prisma.client.findMany({
    where: { archivedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true, enabledPlatforms: true },
  });
  const input: ManagerIntakeInput = {
    thread: messages.map(({ role, kind, agent, content }) => ({ role, kind, agent, content })),
    clients,
    selectedClientId: campaign.clientId,
    // The brief's window is in the client's calendar; until a client is picked, UTC's.
    today: calendarDay(deps.clock.now(), campaign.client?.timezone ?? "UTC"),
    allowClarify: campaign.clarifyCount < 1,
    brand: campaign.client ? brandContextOf(campaign.client) : null,
  };

  let result;
  try {
    result = await runAgentFor(deps, "MANAGER.intake", input, {
      taskId: null,
      campaignId: campaign.id,
      clientId: campaign.clientId,
    });
  } catch (error) {
    if (error instanceof AgentEscalation) {
      await reportAgentFailure(deps, {
        threadId: campaign.thread.id,
        campaign,
        error,
        content:
          "I couldn't turn this into a brief. Tell me the client, the platforms, how many posts and the dates, and I'll take it from there.",
      });
      return;
    }
    if (error instanceof InvalidAgentInput) {
      await reportAgentFailure(deps, {
        threadId: campaign.thread.id,
        campaign,
        error,
        content: INVALID_INPUT_REPLY,
      });
      // Rebuilt from the same rows, the input would be just as wrong: runtime.ts won't retry it.
      throw error;
    }
    if (error instanceof BudgetExceeded) {
      await deferForBudget(deps, {
        threadId: campaign.thread.id,
        campaign,
        error,
        job: { name: "manager.intake", data: job },
      });
      return;
    }
    throw error;
  }

  const outcome = result.output.result;
  if (outcome.kind === "clarify") {
    if (!input.allowClarify) {
      // The no-clarify contract has no such branch; never ask a second question.
      await reportAgentFailure(deps, {
        threadId: campaign.thread.id,
        campaign,
        error: new AgentEscalation({
          agent: "MANAGER",
          action: "intake",
          issues: [
            { path: "result.kind", message: "A second clarifying question is not allowed." },
          ],
          reason: "INVALID_OUTPUT",
        }),
        content:
          "I still can't lock the brief. Tell me the client, the platforms, how many posts and the dates, and I'll take it from there.",
      });
      return;
    }
    // If the turn moved on meanwhile, the question isn't asked: the newer turn's job (or the reply
    // another job wrote) answers it, and the team's answer is read under the no-clarify contract.
    await askClarifyingQuestion(deps, campaign.id, campaign.thread.id, turn, outcome);
    return;
  }
  await lockBrief(deps, campaign, campaign.thread.id, turn, outcome);
}

/**
 * Locks the campaign and checks that `turn` is still the one to answer: the brief is open, no
 * reply was written since the thread was read, and no newer team message arrived.
 */
async function claimTurn(
  tx: DbTransaction,
  campaignId: string,
  threadId: string,
  turn: IntakeTurn,
): Promise<boolean> {
  await lockCampaign(tx, campaignId);
  const current = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, briefLockedAt: true, clarifyCount: true },
  });
  if (
    current?.status !== "BRIEFING" ||
    current.briefLockedAt !== null ||
    current.clarifyCount !== turn.clarifyCount
  ) {
    return false;
  }
  const newest = await tx.chatMessage.findFirst({
    where: { threadId, role: "USER" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return newest?.id === turn.messageId;
}

/**
 * Stores the one CLARIFY message, unless the turn moved on. The draft's client is a guess (the
 * question may well be asking for it), so it isn't stored on the campaign, where it would bind
 * the brief against the team's answer.
 */
async function askClarifyingQuestion(
  deps: Deps,
  campaignId: string,
  threadId: string,
  turn: IntakeTurn,
  clarify: IntakeClarify,
): Promise<void> {
  if (turn.clarifyCount > 0) return;
  const events = new EventBatch();
  const asked = await deps.prisma.$transaction(async (tx) => {
    if (!(await claimTurn(tx, campaignId, threadId, turn))) return false;
    await tx.campaign.update({
      where: { id: campaignId },
      data: { clarifyCount: { increment: 1 } },
    });
    const message = await createAgentMessage(tx, {
      threadId,
      agent: "MANAGER",
      kind: "CLARIFY",
      content: clarify.question,
      payload: { question: clarify.question, missing: clarify.missing, draft: clarify.draft },
    });
    messageCreated(events, message);
    return true;
  });
  if (asked) await events.publish(deps);
}

/** Locks the brief, reads it back to the user and queues the first plan, unless the turn moved on. */
async function lockBrief(
  deps: Deps,
  campaign: CampaignWithClient,
  threadId: string,
  turn: IntakeTurn,
  outcome: IntakeBrief,
): Promise<void> {
  const events = new EventBatch();
  const { brief, confirmation } = outcome;
  const locked = await deps.prisma.$transaction(async (tx) => {
    if (!(await claimTurn(tx, campaign.id, threadId, turn))) return false;
    await tx.campaign.update({
      where: { id: campaign.id },
      data: {
        brief,
        briefLockedAt: deps.clock.now(),
        status: "PLANNING",
        clientId: brief.clientId,
        name: brief.title.slice(0, 200),
      },
    });
    const message = await createAgentMessage(tx, {
      threadId,
      agent: "MANAGER",
      kind: "BRIEF",
      content: confirmation,
      payload: { brief, confirmation },
    });
    messageCreated(events, message);
    return true;
  });
  if (!locked) return;
  await events.publish(deps);
  await enqueueManagerPlan(deps.queues, {
    campaignId: campaign.id,
    version: 1,
    changeRequest: null,
    previousGraphId: null,
  });
}

async function ensureFirstPlanQueued(deps: Deps, campaignId: string): Promise<void> {
  const campaign = await deps.prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, _count: { select: { taskGraphs: true } } },
  });
  if (campaign?.status !== "PLANNING" || campaign._count.taskGraphs > 0) return;
  await enqueueManagerPlan(deps.queues, {
    campaignId,
    version: 1,
    changeRequest: null,
    previousGraphId: null,
  });
}
