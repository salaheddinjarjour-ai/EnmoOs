import {
  AgentEscalation,
  automatedCopyChecks,
  automatedShotCheck,
  BudgetExceeded,
  COPY_BANNED_SCAN_IGNORE,
  InvalidAgentInput,
  shotCoverageIssues,
} from "@enmo/agents";
import type { DbTransaction } from "@enmo/db";
import {
  CopywriterOutput,
  Feedback,
  QA_STILL_OPEN_HEADING,
  scanForBannedWords,
  type AutomatedCheck,
  type BannedWordHit,
  type CopywriterInput,
  type Issue,
  type ManagerQaInput,
  type ManagerQaOutput,
  type QaIssue,
  type QaVisual,
} from "@enmo/shared";
import type { Deps } from "../deps";
import type { TaskRunJob } from "../jobs/queues";
import type { RunAttempt } from "../jobs/types";
import { parseStored } from "../lib/stored";
import { runAgentFor, type RunContext } from "./agent-run";
import { approvalCreated, openApprovalRound } from "./approval-round";
import { baseNodeId, brandContextOf, postContextOf, storedBrief, storedPlan } from "./context";
import {
  blockTaskOnBudget,
  escalateTask,
  failTask,
  handOffFromEscalation,
  handOffFromInvalidInput,
  type HandOff,
} from "./escalation";
import { EventBatch } from "./events";
import {
  appendRevision,
  bannedWordIssues,
  qaFeedbackText,
  qaRevisionCount,
  qaRevisionTarget,
  spliceDirectAfter,
} from "./feedback";
import { advance, advanceOrRecount } from "./graph";
import { jsonOrDbNull } from "./messages";
import { ACTION_POST_STATUS, postUpdated, requireTransition, transitionPost } from "./post-status";
import { reportProgress } from "./progress";
import {
  RUNNABLE_STATUSES,
  describeTask,
  loadTask,
  taskAction,
  type TaskWithContext,
} from "./tasks";
import { shotGaps, visualCopyOf } from "./takes";
import { planShots, qaVisualsOf } from "./visuals";

/*
 * task.run (DESIGN §D "Graph lifecycle"): one AgentTask of an approved graph. The task goes
 * RUNNING and its post into the action's status, the agent input is built from the database
 * (brief, brand, post, upstream output, revision feedback), the agent runs, and its output is
 * stored before the graph advances. The Visual Director's `direct` lives in visuals.ts: its task
 * waits (WAITING) on the renders it queued, and the visual loop finishes it. Only QUEUED and
 * RUNNING tasks are acted on, so duplicate and stale jobs are no-ops; a RUNNING task is picked up
 * again when BullMQ retries after a transport error.
 */

export async function runTask(deps: Deps, job: TaskRunJob, attempt: RunAttempt): Promise<void> {
  const task = await loadTask(deps.prisma, job.taskId);
  if (!task) return;
  if (!RUNNABLE_STATUSES.includes(task.status)) {
    // A retry of a job whose task finished: make sure the graph moved on and the thread knows.
    if (task.status === "SUCCEEDED") await advanceOrRecount(deps, task.graphId);
    return;
  }
  if (task.graph.campaign.status === "ARCHIVED" || task.graph.status !== "APPROVED") return;

  const { count } = await deps.prisma.agentTask.updateMany({
    where: { id: task.id, status: { in: [...RUNNABLE_STATUSES] } },
    data: { status: "RUNNING", startedAt: deps.clock.now() },
  });
  if (count === 0) return;

  try {
    await enterPostStatus(deps, task);
    const action = taskAction(task);
    switch (action) {
      case "write":
        await runWrite(deps, task);
        break;
      case "direct":
        await planShots(deps, task);
        break;
      case "qa":
        await runQa(deps, task);
        break;
      case "strategy":
      case "adapt":
        await failTask(deps, task.id, {
          reason: "UNSUPPORTED",
          issues: [],
          message: `has no runner yet: "${action}" is not part of this phase's pipeline.`,
        });
        return;
    }
  } catch (error) {
    if (error instanceof AgentEscalation) {
      await escalateTask(deps, task.id, handOffFromEscalation(error));
      return;
    }
    if (error instanceof BudgetExceeded) {
      await blockTaskOnBudget(deps, task.id, error);
      return;
    }
    if (error instanceof InvalidAgentInput) {
      // Built from the same rows, a retry would fail the same way; runtime.ts won't retry it.
      await failTask(deps, task.id, handOffFromInvalidInput(error));
      throw error;
    }
    if (attempt.isLast) {
      await failTask(deps, task.id, {
        reason: "FAILED",
        issues: [],
        message: `failed after every retry: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    throw error;
  }
}

async function enterPostStatus(deps: Deps, task: TaskWithContext): Promise<void> {
  const target = ACTION_POST_STATUS[taskAction(task)];
  const events = new EventBatch();
  if (task.postId && target && task.post?.status !== target) {
    const post = await transitionPost(deps.prisma, task.postId, target);
    if (post) postUpdated(events, post);
  }
  await events.publish(deps);
  await reportProgress(deps, task.graphId, [
    { taskId: task.id, agent: task.agent, postRef: task.post?.ref ?? null, state: "running" },
  ]);
}

function runContext(task: TaskWithContext): RunContext {
  return {
    taskId: task.id,
    campaignId: task.graph.campaignId,
    clientId: task.graph.campaign.clientId,
  };
}

/** The pieces every per-post agent input shares. */
function postInputs(task: TaskWithContext) {
  const { post } = task;
  const client = task.graph.campaign.client;
  if (!post || !client) {
    throw new Error(`AgentTask ${task.id} is not attached to a post of a client`);
  }
  const node = storedPlan(task.graph).nodes.find((n) => n.id === baseNodeId(task.nodeKey));
  return {
    post,
    client,
    brief: storedBrief(task.graph.campaign),
    brand: brandContextOf(client),
    postContext: postContextOf(post, node?.instructions ?? null),
  };
}

function storedCopy(post: { id: string; copy: unknown }): CopywriterOutput | null {
  return post.copy === null
    ? null
    : parseStored(CopywriterOutput, post.copy, `Post ${post.id}.copy`);
}

/** Marks the task SUCCEEDED unless it left RUNNING meanwhile (e.g. its campaign was archived). */
async function succeed(
  deps: Deps,
  tx: DbTransaction,
  taskId: string,
  output: unknown,
): Promise<boolean> {
  const { count } = await tx.agentTask.updateMany({
    where: { id: taskId, status: "RUNNING" },
    data: {
      status: "SUCCEEDED",
      output: jsonOrDbNull(output),
      error: null,
      finishedAt: deps.clock.now(),
    },
  });
  return count === 1;
}

/**
 * After the task's result committed: tell the thread, then queue what became ready. The graph
 * moves on whatever happens to the events; a failed recount still fails the job, so BullMQ's retry
 * recounts (it finds the task SUCCEEDED) and a settled batch is still announced.
 */
async function finish(deps: Deps, task: TaskWithContext, events: EventBatch): Promise<void> {
  try {
    await events.publish(deps);
    await reportProgress(deps, task.graphId, [
      { taskId: task.id, agent: task.agent, postRef: task.post?.ref ?? null, state: "done" },
    ]);
  } finally {
    await advance(deps, task.graphId);
  }
}

/* ─── write (Copywriter) ─────────────────────────────────────────────────────────────────────── */

async function runWrite(deps: Deps, task: TaskWithContext): Promise<void> {
  const { post, brief, brand, postContext } = postInputs(task);
  const feedback =
    task.feedback === null
      ? null
      : parseStored(Feedback, task.feedback, `AgentTask ${task.id}.feedback`);
  const previous = storedCopy(post);
  const input: CopywriterInput = {
    brief,
    brand,
    post: postContext,
    // The reviewer's words go to the Copywriter exactly as stored, next to the copy they judged.
    revision: feedback && previous ? { feedback, previous } : null,
  };
  if (feedback && !previous) {
    deps.logger.warn(
      { taskId: task.id },
      "revision feedback without previous copy; drafting fresh",
    );
  }
  await deps.prisma.agentTask.update({ where: { id: task.id }, data: { input } });

  const result = await runAgentFor(deps, "COPYWRITER.write", input, runContext(task));

  const events = new EventBatch();
  const stored = await deps.prisma.$transaction(async (tx) => {
    if (!(await succeed(deps, tx, task.id, result.output))) return false;
    const updated = await tx.post.update({
      where: { id: post.id },
      data: { copy: result.output },
    });
    postUpdated(events, updated);
    // A rewrite that adds or drops a scene or slide re-plans the shots before anything else runs.
    if ((await shotGaps(tx, post, result.output)).length > 0) {
      await spliceDirectAfter(tx, task, post);
    }
    return true;
  });
  if (stored) await finish(deps, task, events);
}

/* ─── qa (Manager) ───────────────────────────────────────────────────────────────────────────── */

/**
 * Code-run checks the Manager reviews alongside the copy. Two also gate approval: banned words,
 * and the post's current takes filling exactly its scenes or slides (with visuals only).
 */
export function automatedChecks(
  copy: CopywriterOutput,
  context: Pick<CopywriterInput, "post" | "brand">,
  visuals: readonly QaVisual[] | null,
): { checks: AutomatedCheck[]; bannedWords: BannedWordHit[]; shotGaps: Issue[] } {
  const gaps =
    visuals === null ? [] : shotCoverageIssues(context.post, visualCopyOf(copy), visuals);
  return {
    checks: [
      ...automatedCopyChecks(copy, context),
      ...(visuals === null ? [] : [automatedShotCheck(gaps)]),
    ],
    bannedWords: scanForBannedWords(copy, context.brand.bannedWords, {
      ignoreKeys: COPY_BANNED_SCAN_IGNORE,
    }),
    shotGaps: gaps,
  };
}

/** The gates' findings as QA issues for the specialist that fixes each. */
function gateIssues(bannedWords: readonly BannedWordHit[], gaps: readonly Issue[]): QaIssue[] {
  return [
    ...bannedWordIssues(bannedWords),
    ...gaps.map((gap) => ({
      target: "VISUAL_DIRECTOR" as const,
      field: gap.path || "shots",
      problem: gap.message,
      instruction: "Plan exactly one shot for each scene or slide the copy has now.",
    })),
  ];
}

async function runQa(deps: Deps, task: TaskWithContext): Promise<void> {
  const { post, client, brief, brand, postContext } = postInputs(task);
  const copy = storedCopy(post);
  if (!copy) {
    await failTask(deps, task.id, {
      reason: "FAILED",
      issues: [],
      message: "has no copy to review.",
    });
    return;
  }
  const visuals = await qaVisualsOf(deps, post.id);
  const {
    checks,
    bannedWords,
    shotGaps: gaps,
  } = automatedChecks(copy, { brand, post: postContext }, visuals);
  const input: ManagerQaInput = {
    brief,
    brand,
    post: postContext,
    copy,
    visuals,
    variants: null,
    automatedChecks: checks,
  };
  await deps.prisma.agentTask.update({ where: { id: task.id }, data: { input } });

  const { output: qa } = await runAgentFor(deps, "MANAGER.qa", input, runContext(task));

  const revisionsUsed = await qaRevisionCount(deps.prisma, post.id);
  const canRevise = revisionsUsed < deps.config.MAX_QA_REVISIONS;

  if (qa.verdict === "revise" && canRevise) {
    await reviseAfterQa(deps, task, qa, qa.issues);
    return;
  }
  const issues = gateIssues(bannedWords, gaps);
  if (issues.length > 0) {
    // The gates: no approval round opens while the copy still breaks the banned-words list, or on
    // takes that don't fill exactly the post's scenes or slides.
    if (canRevise) {
      await reviseAfterQa(deps, task, qa, issues);
      return;
    }
    await deps.prisma.agentTask.update({ where: { id: task.id }, data: { output: qa } });
    await escalateTask(deps, task.id, gateHandOff(post.ref, bannedWords, gaps));
    return;
  }
  await sendForApproval(deps, task, qa, client.id);
}

/** Why QA can't send the post for approval, out of revisions. */
function gateHandOff(
  ref: string,
  bannedWords: readonly BannedWordHit[],
  gaps: readonly Issue[],
): HandOff {
  const reasons: string[] = [];
  if (bannedWords.length > 0) {
    const terms = [...new Set(bannedWords.map((hit) => hit.term))].join(", ");
    reasons.push(`the copy still uses banned words (${terms})`);
  }
  if (gaps.length > 0) {
    reasons.push(`its takes don't match the copy's scenes or slides (${gaps[0]!.message})`);
  }
  return {
    reason: bannedWords.length > 0 ? "BANNED_WORDS" : "SHOTS_OUT_OF_STEP",
    issues: [
      ...bannedWords.map((hit) => ({ path: hit.path, message: `Banned term "${hit.term}"` })),
      ...gaps,
    ],
    message: `can't send ${ref} for approval: ${reasons.join(", and ")}.`,
  };
}

/** QA pass (or out of revisions): the post goes to humans with the Manager's notes. */
async function sendForApproval(
  deps: Deps,
  task: TaskWithContext,
  qa: ManagerQaOutput,
  clientId: string,
): Promise<void> {
  const postId = task.postId;
  if (!postId) throw new Error(`QA task ${task.id} has no post`);
  const qaNotes =
    qa.verdict === "pass" || qa.issues.length === 0
      ? qa.summaryForReviewer
      : `${qa.summaryForReviewer}\n\n${QA_STILL_OPEN_HEADING}\n${qaFeedbackText(qa.issues, "")}`;

  const events = new EventBatch();
  const stored = await deps.prisma.$transaction(async (tx) => {
    if (!(await succeed(deps, tx, task.id, qa))) return false;
    const post = await requireTransition(tx, postId, "PENDING_APPROVAL", {
      qaNotes: qaNotes.slice(0, 4000),
      needsAttention: false,
      attentionReason: null,
    });
    const request = await openApprovalRound(tx, post);
    postUpdated(events, post);
    approvalCreated(events, request, { campaignId: post.campaignId, clientId });
    return true;
  });
  if (stored) await finish(deps, task, events);
}

/** QA "revise": append the revision chain with QA's instructions as the feedback. */
async function reviseAfterQa(
  deps: Deps,
  task: TaskWithContext,
  qa: ManagerQaOutput,
  issues: ManagerQaOutput["issues"],
): Promise<void> {
  const postId = task.postId;
  if (!postId) throw new Error(`QA task ${task.id} has no post`);
  const events = new EventBatch();
  const stored = await deps.prisma.$transaction(async (tx) => {
    if (!(await succeed(deps, tx, task.id, qa))) return false;
    const post = await tx.post.update({
      where: { id: postId },
      data: { revision: { increment: 1 }, qaNotes: qa.summaryForReviewer.slice(0, 4000) },
    });
    await appendRevision(tx, {
      graphId: task.graphId,
      post,
      revision: post.revision,
      target: qaRevisionTarget(issues),
      feedback: {
        verbatim: qaFeedbackText(issues, qa.summaryForReviewer),
        source: "QA",
        decisionId: null,
      },
      enabledActions: deps.config.PIPELINE_ACTIONS,
    });
    postUpdated(events, post);
    return true;
  });
  if (stored) {
    deps.logger.info(
      { taskId: task.id, post: task.post?.ref },
      `${describeTask(task)} sent the post back for a revision`,
    );
    await finish(deps, task, events);
  }
}
