import { AgentEscalation, BudgetExceeded, InvalidAgentInput } from "@enmo/agents";
import { Prisma } from "@enmo/db";
import {
  estimatePlan,
  validateTaskGraph,
  type Brief,
  type ManagerPlanInput,
  type ManagerPlanOutput,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { JOB, jobIds, type ManagerPlanJob } from "../jobs/queues";
import type { RunAttempt } from "../jobs/types";
import { calendarDay } from "../lib/clock";
import {
  deferForBudget,
  INVALID_INPUT_REPLY,
  PLAN_UNAVAILABLE_REPLY,
  reportAgentFailure,
  reportJobFailure,
} from "./agent-failure";
import { runAgentFor } from "./agent-run";
import { brandContextOf, dateFromIsoDate, isoDate, storedBrief, storedPlan } from "./context";
import { EventBatch } from "./events";
import { lockCampaign } from "./locks";
import { createAgentMessage, messageCreated } from "./messages";

/*
 * manager.plan (DESIGN §C "Manager plan", §D): the Manager turns the locked brief into a task
 * graph for the enabled pipeline, code validates it and prices it, and the plan is PROPOSED in the
 * thread. Nothing is generated until a human approves it. A change request re-plans as version
 * n+1 with the reviewer's words verbatim, superseding version n.
 */

/** Job states in which a queued draft will still run (or is running). */
const LIVE_STATES = ["active", "waiting", "delayed", "prioritized", "waiting-children"] as const;

/** Whether a manager.plan job for this campaign version is still waiting or running. */
export async function isPlanBeingDrafted(
  deps: Deps,
  campaignId: string,
  version: number,
): Promise<boolean> {
  const jobs = await deps.queues.queue("agents").getJobs([...LIVE_STATES]);
  return jobs.some((job) => {
    if (job?.name !== JOB.managerPlan) return false;
    const data = job.data as Partial<ManagerPlanJob> | undefined;
    return data?.campaignId === campaignId && data.version === version;
  });
}

/**
 * Queues a re-plan. Unlike the first plan (jobIds.managerPlan, queued once per campaign), a
 * version may need drafting again after a failed attempt, so the job id carries `suffix` (the
 * message that asked for it).
 */
export async function enqueuePlanDraft(
  deps: Deps,
  data: ManagerPlanJob,
  suffix: string,
): Promise<void> {
  await deps.queues.add(JOB.managerPlan, data, { jobId: `${jobIds.managerPlan(data)}-${suffix}` });
}

export async function runPlan(deps: Deps, job: ManagerPlanJob, attempt: RunAttempt): Promise<void> {
  try {
    await draftPlan(deps, job);
  } catch (error) {
    // An InvalidAgentInput was reported already, and runtime.ts fails it for good on any attempt.
    if (attempt.isLast && !(error instanceof InvalidAgentInput)) {
      await reportJobFailure(deps, {
        campaignId: job.campaignId,
        action: "plan",
        error,
        content: PLAN_UNAVAILABLE_REPLY,
      });
    }
    throw error;
  }
}

async function draftPlan(deps: Deps, job: ManagerPlanJob): Promise<void> {
  const campaign = await deps.prisma.campaign.findUnique({
    where: { id: job.campaignId },
    include: {
      client: true,
      thread: { select: { id: true } },
      taskGraphs: { select: { id: true, version: true, status: true, graph: true } },
    },
  });
  if (!campaign?.thread || campaign.status === "ARCHIVED") return;
  if (!isStillWanted(campaign.taskGraphs, job.version)) return;

  const brief = storedBrief(campaign);
  const client =
    campaign.client ??
    (await deps.prisma.client.findUniqueOrThrow({ where: { id: brief.clientId } }));
  const previous = job.previousGraphId
    ? campaign.taskGraphs.find((graph) => graph.id === job.previousGraphId)
    : undefined;
  const enabledActions = [...deps.config.PIPELINE_ACTIONS];

  const input: ManagerPlanInput = {
    brief,
    brand: brandContextOf(client),
    // Post dates are days in the client's calendar (brand.timezone), like the brief's window.
    today: calendarDay(deps.clock.now(), client.timezone),
    enabledActions,
    busyDates: await busyDates(deps, client.id, campaign.id, brief),
    changeRequest: job.changeRequest,
    previousGraph: previous ? storedPlan(previous) : null,
  };

  let plan: ManagerPlanOutput;
  try {
    const result = await runAgentFor(deps, "MANAGER.plan", input, {
      taskId: null,
      campaignId: campaign.id,
      clientId: client.id,
    });
    plan = result.output;
  } catch (error) {
    if (error instanceof AgentEscalation) {
      await reportAgentFailure(deps, {
        threadId: campaign.thread.id,
        campaign,
        error,
        content:
          "I couldn't put together a valid plan for this brief. Reply with what to adjust (fewer posts, other dates, a different mix) and I'll plan it again.",
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
        job: { name: "manager.plan", data: job },
      });
      return;
    }
    throw error;
  }

  // The definition validates too; this keeps an unvalidated graph out of the database regardless.
  const issues = validateTaskGraph(plan, brief, enabledActions);
  if (issues.length > 0) {
    await reportAgentFailure(deps, {
      threadId: campaign.thread.id,
      campaign,
      error: new AgentEscalation({
        agent: "MANAGER",
        action: "plan",
        issues,
        reason: "INVALID_OUTPUT",
      }),
      content:
        "The plan I drafted doesn't fit the brief. Reply with what to adjust and I'll plan it again.",
    });
    return;
  }

  await proposePlan(deps, {
    campaignId: campaign.id,
    threadId: campaign.thread.id,
    version: job.version,
    changeRequest: job.changeRequest,
    plan,
  });
}

/** False once this version exists or the campaign already approved a plan. */
function isStillWanted(graphs: readonly { version: number; status: string }[], version: number) {
  return !graphs.some(
    (graph) =>
      graph.version === version || graph.status === "APPROVED" || graph.status === "COMPLETED",
  );
}

/** Dates in the brief window the client already has posts on (other campaigns). */
async function busyDates(
  deps: Deps,
  clientId: string,
  campaignId: string,
  brief: Brief,
): Promise<string[]> {
  const posts = await deps.prisma.post.findMany({
    where: {
      clientId,
      campaignId: { not: campaignId },
      targetDate: {
        gte: dateFromIsoDate(brief.window.start),
        lte: dateFromIsoDate(brief.window.end),
      },
    },
    select: { targetDate: true },
    distinct: ["targetDate"],
    orderBy: { targetDate: "asc" },
  });
  return posts.flatMap((post) => (post.targetDate ? [isoDate(post.targetDate)] : []));
}

interface Proposal {
  campaignId: string;
  threadId: string;
  version: number;
  changeRequest: string | null;
  plan: ManagerPlanOutput;
}

/** Stores the graph PROPOSED, supersedes older proposals and posts the PLAN message. */
async function proposePlan(deps: Deps, proposal: Proposal): Promise<void> {
  const events = new EventBatch();
  const estimate = estimatePlan(proposal.plan);
  let graphId: string | null;
  try {
    graphId = await deps.prisma.$transaction(async (tx) => {
      await lockCampaign(tx, proposal.campaignId);
      const graphs = await tx.taskGraph.findMany({
        where: { campaignId: proposal.campaignId },
        select: { version: true, status: true },
      });
      if (!isStillWanted(graphs, proposal.version)) return null;

      const graph = await tx.taskGraph.create({
        data: {
          campaignId: proposal.campaignId,
          version: proposal.version,
          status: "PROPOSED",
          summary: proposal.plan.summary,
          graph: proposal.plan,
          estimate,
          changeRequest: proposal.changeRequest,
        },
        select: { id: true },
      });
      await tx.taskGraph.updateMany({
        where: {
          campaignId: proposal.campaignId,
          status: "PROPOSED",
          version: { lt: proposal.version },
        },
        data: { status: "SUPERSEDED" },
      });
      const message = await createAgentMessage(tx, {
        threadId: proposal.threadId,
        agent: "MANAGER",
        kind: "PLAN",
        content: proposal.plan.summary,
        payload: { graphId: graph.id, version: proposal.version },
      });
      messageCreated(events, message);
      return graph.id;
    });
  } catch (error) {
    // The same version was proposed concurrently: that one stands.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
  if (!graphId) return;

  events.thread(proposal.threadId, "plan.proposed", {
    campaignId: proposal.campaignId,
    threadId: proposal.threadId,
    graphId,
    version: proposal.version,
  });
  await events.publish(deps);
}
