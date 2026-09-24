/*
 * The orchestration layer (DESIGN §D "Graph lifecycle"): processors in jobs/processors and the
 * services call into these modules; they take Deps and never import routes. Later phases add
 * visuals, variants and strategy beside them.
 *
 *   intake        manager.intake: the one clarifying question, then the locked brief
 *   plan          manager.plan: the proposed TaskGraph (code-priced), re-plans on feedback
 *   graph         approvePlan's rows, advance() of ready tasks
 *   run-task      task.run: Copywriter drafts and Manager QA into approval rounds
 *   feedback      revision subgraphs for human and QA feedback, routed verbatim
 *   post-status   the only way a Post changes status
 *   progress      the thread's PROGRESS line, agent.status and batch announcements
 *   escalation    ESCALATED / FAILED / BLOCKED_BUDGET hand-offs to humans
 *   sweeper       tick.sweeper: stuck tasks, budget roll-over, ready tasks nothing queued
 *   after-commit  follow-ups of a committed change that must not fail it
 */
export { runIntake } from "./intake";
export { runPlan } from "./plan";
export { advance, advanceOrRecount, approveGraph } from "./graph";
export { runTask } from "./run-task";
export { appendRevision, revisionActions, routeHumanFeedback } from "./feedback";
export { POST_TRANSITIONS, requireTransition, transitionPost } from "./post-status";
export { reportProgress } from "./progress";
export { blockTaskOnBudget, escalateTask, failTask } from "./escalation";
export { requeueTask, sweep } from "./sweeper";
