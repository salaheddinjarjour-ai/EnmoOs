import { z } from "zod";
import { Role, type ApprovalStatus, type Decision } from "./enums";
import { Id } from "./dto/common";
import { deepFreeze, hasUniqueItems } from "./internal";

export const APPROVAL_CHAIN_MAX_STEPS = 5;
export const APPROVAL_STEP_MAX_APPROVALS = 3;

export const ApprovalStep = z
  .object({
    name: z.string().trim().min(1).max(80),
    approverRoles: z
      .array(Role)
      .max(Role.options.length)
      .refine(hasUniqueItems, "Roles must be unique"),
    approverUserIds: z.array(Id).max(50).refine(hasUniqueItems, "Users must be unique"),
    minApprovals: z.number().int().min(1).max(APPROVAL_STEP_MAX_APPROVALS),
  })
  .refine((step) => step.approverRoles.length + step.approverUserIds.length > 0, {
    message: "A step needs at least one approver role or user",
    path: ["approverRoles"],
  })
  // With only named users, the step could never collect more approvals than there are users.
  .refine(
    (step) => step.approverRoles.length > 0 || step.minApprovals <= step.approverUserIds.length,
    { message: "minApprovals exceeds the number of named approvers", path: ["minApprovals"] },
  );
export type ApprovalStep = z.infer<typeof ApprovalStep>;

export const ApprovalChain = z.object({
  steps: z.array(ApprovalStep).min(1).max(APPROVAL_CHAIN_MAX_STEPS),
});
export type ApprovalChain = z.infer<typeof ApprovalChain>;

/** A fresh, mutable copy of the default chain (safe to hand to Prisma or a form). */
export function defaultApprovalChain(): ApprovalChain {
  return {
    steps: [
      {
        name: "Manager review",
        approverRoles: ["ADMIN", "MANAGER"],
        approverUserIds: [],
        minApprovals: 1,
      },
    ],
  };
}

export const DEFAULT_APPROVAL_CHAIN: Readonly<ApprovalChain> = deepFreeze(defaultApprovalChain());

export interface ChainActor {
  id: string;
  role: Role;
}

export function canDecideStep(user: ChainActor, chain: ApprovalChain, stepIndex: number): boolean {
  const step = chain.steps[stepIndex];
  if (!step) return false;
  return isStepApprover(user, step);
}

function isStepApprover(user: ChainActor, step: ApprovalStep): boolean {
  return step.approverRoles.includes(user.role) || step.approverUserIds.includes(user.id);
}

/** A teammate as the chain sees them; deactivated accounts can't sign in, so can't decide. */
export interface ChainTeamMember extends ChainActor {
  isActive: boolean;
}

/** The active teammates who may decide `step`, by role or by name (each person once). */
export function eligibleApprovers<T extends ChainTeamMember>(
  step: ApprovalStep,
  team: readonly T[],
): T[] {
  return team.filter((member) => member.isActive && isStepApprover(member, step));
}

/** A step the team, as it stands, can't complete. `step` is the 0-based index. */
export interface ChainShortfall {
  step: number;
  name: string;
  eligible: number;
  required: number;
}

/**
 * Steps with fewer eligible active teammates than their minApprovals. chainRejection() never lets
 * one person decide a step twice, so every post would wait at such a step forever.
 */
export function chainShortfalls(
  chain: ApprovalChain,
  team: readonly ChainTeamMember[],
): ChainShortfall[] {
  return chain.steps.flatMap((step, index) => {
    const eligible = eligibleApprovers(step, team).length;
    return eligible < step.minApprovals
      ? [{ step: index, name: step.name, eligible, required: step.minApprovals }]
      : [];
  });
}

/** "needs 2 approvals, but only 1 active teammate can approve it" */
export function describeShortfall({ eligible, required }: ChainShortfall): string {
  const needs = `needs ${required} ${required === 1 ? "approval" : "approvals"}`;
  const who =
    eligible === 0
      ? "no active teammate"
      : `only ${eligible} active ${eligible === 1 ? "teammate" : "teammates"}`;
  return `${needs}, but ${who} can approve it`;
}

/** A decision already persisted on the request (ApprovalDecision row). */
export interface RecordedDecision {
  step: number;
  userId: string;
  decision: Decision;
}

export interface ChainRequestState {
  /** The snapshot stored on ApprovalRequest.chain, not the client's live chain. */
  chain: ApprovalChain;
  status: ApprovalStatus;
  currentStep: number;
  decisions: readonly RecordedDecision[];
}

export type ChainRejection = "NOT_PENDING" | "INVALID_STEP" | "NOT_ELIGIBLE" | "ALREADY_DECIDED";

/** Why `actor` may not decide the request's current step, or null when they may. */
export function chainRejection(state: ChainRequestState, actor: ChainActor): ChainRejection | null {
  if (state.status !== "PENDING") return "NOT_PENDING";
  if (!state.chain.steps[state.currentStep]) return "INVALID_STEP";
  if (!canDecideStep(actor, state.chain, state.currentStep)) return "NOT_ELIGIBLE";
  const alreadyDecided = state.decisions.some(
    (d) => d.step === state.currentStep && d.userId === actor.id,
  );
  return alreadyDecided ? "ALREADY_DECIDED" : null;
}

/** The `canDecide` flag on approval queue items. */
export function canDecideRequest(state: ChainRequestState, actor: ChainActor): boolean {
  return chainRejection(state, actor) === null;
}

export interface ChainOutcome {
  status: Extract<ApprovalStatus, "PENDING" | "APPROVED" | "CHANGES_REQUESTED">;
  /** The step the decision was recorded against (store this on ApprovalDecision.step). */
  decidedStep: number;
  /** The request's currentStep after the decision; unchanged once the request resolves. */
  currentStep: number;
  /** True when this decision completed `decidedStep`. */
  stepCompleted: boolean;
  /** Distinct approvals on `decidedStep`, including this one. */
  approvals: number;
  required: number;
}

export type ChainTransition =
  { ok: true; outcome: ChainOutcome } | { ok: false; reason: ChainRejection };

/**
 * Pure chain walk (DESIGN §E). REQUEST_CHANGES at any step resolves the request; APPROVE counts
 * towards the current step's minApprovals, then moves to the next step or resolves as APPROVED
 * after the last one. Steps are never skipped, including via approve-all.
 */
export function nextStateAfterDecision(
  state: ChainRequestState,
  actor: ChainActor,
  decision: Decision,
): ChainTransition {
  const rejection = chainRejection(state, actor);
  if (rejection) return { ok: false, reason: rejection };

  const decidedStep = state.currentStep;
  const step = state.chain.steps[decidedStep];
  if (!step) return { ok: false, reason: "INVALID_STEP" };

  if (decision === "REQUEST_CHANGES") {
    return {
      ok: true,
      outcome: {
        status: "CHANGES_REQUESTED",
        decidedStep,
        currentStep: decidedStep,
        stepCompleted: false,
        approvals: countApprovals(state.decisions, decidedStep),
        required: step.minApprovals,
      },
    };
  }

  const approvals = countApprovals(state.decisions, decidedStep) + 1;
  const stepCompleted = approvals >= step.minApprovals;
  const isLastStep = decidedStep === state.chain.steps.length - 1;

  let status: ChainOutcome["status"] = "PENDING";
  let currentStep = decidedStep;
  if (stepCompleted && isLastStep) status = "APPROVED";
  else if (stepCompleted) currentStep = decidedStep + 1;

  return {
    ok: true,
    outcome: {
      status,
      decidedStep,
      currentStep,
      stepCompleted,
      approvals,
      required: step.minApprovals,
    },
  };
}

function countApprovals(decisions: readonly RecordedDecision[], step: number): number {
  const approvers = new Set(
    decisions.filter((d) => d.step === step && d.decision === "APPROVE").map((d) => d.userId),
  );
  return approvers.size;
}
