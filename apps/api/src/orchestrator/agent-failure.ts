import { InvalidAgentInput, type AgentEscalation, type BudgetExceeded } from "@enmo/agents";
import type { AlertKind } from "@enmo/shared";
import type { Deps } from "../deps";
import {
  JOB,
  jobIds,
  RequeueToken,
  type ManagerIntakeJob,
  type ManagerPlanJob,
} from "../jobs/queues";
import { getBudget, nextUtcMidnight, utcDay } from "../services/budget";
import { EventBatch } from "./events";
import { asSentence, handOffFromEscalation, handOffFromInvalidInput } from "./escalation";
import { createAgentMessage, messageCreated } from "./messages";

/*
 * Failures of the campaign-level Manager calls (intake, plan), which have no AgentTask to park:
 * the Manager says what happened in the thread, an alert goes out, and a budget stop re-queues
 * the same job for just after UTC midnight. A job that fails its last attempt (the provider or our
 * infrastructure stayed down through every retry) is reported the same way: the thread shows the
 * Manager thinking until an agent message follows the team's turn, and nothing else would come.
 */

interface CampaignRef {
  id: string;
  clientId: string | null;
}

export interface AgentFailureReport {
  threadId: string;
  campaign: CampaignRef;
  /** An InvalidAgentInput is an orchestrator bug; the caller still fails its job for good. */
  error: AgentEscalation | InvalidAgentInput;
  /** What the Manager tells the user to do next. */
  content: string;
}

/** What the Manager says when it could not even build its own input. */
export const INVALID_INPUT_REPLY =
  "Something went wrong on my side before I could work on this, and the team has been alerted. Nothing was spent.";

export async function reportAgentFailure(deps: Deps, report: AgentFailureReport): Promise<void> {
  const handOff =
    report.error instanceof InvalidAgentInput
      ? handOffFromInvalidInput(report.error)
      : handOffFromEscalation(report.error);
  await tellThread(deps, {
    threadId: report.threadId,
    campaign: report.campaign,
    content: report.content,
    alert: { kind: "escalated", message: `Manager ${report.error.action} ${handOff.message}` },
  });
}

interface ThreadNotice {
  threadId: string;
  campaign: CampaignRef;
  content: string;
  alert: { kind: Extract<AlertKind, "escalated" | "failed">; message: string };
}

/** The Manager's TEXT message in the thread plus an alert about the campaign. */
async function tellThread(deps: Deps, notice: ThreadNotice): Promise<void> {
  const events = new EventBatch();
  const message = await createAgentMessage(deps.prisma, {
    threadId: notice.threadId,
    agent: "MANAGER",
    kind: "TEXT",
    content: notice.content,
    payload: null,
  });
  messageCreated(events, message);
  events.alert({
    kind: notice.alert.kind,
    entityType: "Campaign",
    entityId: notice.campaign.id,
    message: notice.alert.message,
    clientId: notice.campaign.clientId,
    campaignId: notice.campaign.id,
  });
  await events.publish(deps);
}

/** What the Manager says when an intake job failed every attempt. */
export const INTAKE_UNAVAILABLE_REPLY =
  "I couldn't work on this just now: the model or our systems were unavailable, even after a few retries. Send your message again and I'll pick it up.";

/** What the Manager says when a plan job failed every attempt. */
export const PLAN_UNAVAILABLE_REPLY =
  "I couldn't draft the plan just now: the model or our systems were unavailable, even after a few retries. Send your request again and I'll plan it.";

export interface JobFailure {
  campaignId: string;
  action: "intake" | "plan";
  error: unknown;
  content: string;
}

/**
 * A manager.intake or manager.plan job failed its last attempt. Reporting is best-effort: when
 * the database is what's down it can't be written either, and the job's own error is what BullMQ
 * records.
 */
export async function reportJobFailure(deps: Deps, failure: JobFailure): Promise<void> {
  try {
    const campaign = await deps.prisma.campaign.findUnique({
      where: { id: failure.campaignId },
      select: { id: true, clientId: true, status: true, thread: { select: { id: true } } },
    });
    if (!campaign?.thread || campaign.status === "ARCHIVED") return;
    const reason = (
      failure.error instanceof Error ? failure.error.message : String(failure.error)
    ).slice(0, 300);
    await tellThread(deps, {
      threadId: campaign.thread.id,
      campaign,
      content: failure.content,
      alert: {
        kind: "failed",
        message: asSentence(`Manager ${failure.action} failed after every retry: ${reason}`),
      },
    });
  } catch (error) {
    deps.logger.error(
      { err: error, campaignId: failure.campaignId, action: failure.action },
      "could not report a failed Manager job",
    );
  }
}

type DeferredJob =
  | { name: typeof JOB.managerIntake; data: ManagerIntakeJob }
  | { name: typeof JOB.managerPlan; data: ManagerPlanJob };

export interface BudgetDeferral {
  threadId: string;
  campaign: CampaignRef;
  error: BudgetExceeded;
  job: DeferredJob;
}

/** Posts the budget notice and re-queues the job to run right after the next UTC midnight. */
export async function deferForBudget(deps: Deps, deferral: BudgetDeferral): Promise<void> {
  const now = deps.clock.now();
  const resumeAt = nextUtcMidnight(now);
  const token = RequeueToken.parse(`budget-${utcDay(resumeAt)}`);
  const { job } = deferral;
  const delayMs = Math.max(0, resumeAt.getTime() - now.getTime()) + 5_000;
  if (job.name === JOB.managerIntake) {
    await deps.queues.add(job.name, job.data, {
      jobId: `${jobIds.managerIntake(job.data)}-${token}`,
      delayMs,
    });
  } else {
    await deps.queues.add(job.name, job.data, {
      jobId: `${jobIds.managerPlan(job.data)}-${token}`,
      delayMs,
    });
  }

  const events = new EventBatch();
  const message = await createAgentMessage(deps.prisma, {
    threadId: deferral.threadId,
    agent: "MANAGER",
    kind: "TEXT",
    content: `Today's token budget is spent (${deferral.error.used.toLocaleString("en-US")}/${deferral.error.cap.toLocaleString("en-US")} tokens). I'll pick this up after UTC midnight.`,
    payload: null,
  });
  messageCreated(events, message);
  events.alert({
    kind: "budget",
    entityType: "Campaign",
    entityId: deferral.campaign.id,
    message: `Daily token budget reached on ${deferral.error.day}; the Manager resumes after UTC midnight.`,
    clientId: deferral.campaign.clientId,
    campaignId: deferral.campaign.id,
  });
  events.global("budget.updated", await getBudget(deps));
  await events.publish(deps);
}
