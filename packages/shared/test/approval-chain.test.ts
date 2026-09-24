import { describe, expect, it } from "vitest";
import {
  ApprovalChain,
  DEFAULT_APPROVAL_CHAIN,
  canDecideRequest,
  canDecideStep,
  chainShortfalls,
  defaultApprovalChain,
  describeShortfall,
  eligibleApprovers,
  nextStateAfterDecision,
  type ChainActor,
  type ChainRequestState,
  type ChainTeamMember,
  type RecordedDecision,
} from "../src";

const admin: ChainActor = { id: "u-admin", role: "ADMIN" };
const manager1: ChainActor = { id: "u-m1", role: "MANAGER" };
const manager2: ChainActor = { id: "u-m2", role: "MANAGER" };
const editor: ChainActor = { id: "u-ed", role: "EDITOR" };
const namedEditor: ChainActor = { id: "u-ed-named", role: "EDITOR" };

const twoStepChain = ApprovalChain.parse({
  steps: [
    { name: "Managers", approverRoles: ["MANAGER"], approverUserIds: [], minApprovals: 2 },
    {
      name: "Sign-off",
      approverRoles: [],
      approverUserIds: [admin.id, namedEditor.id],
      minApprovals: 1,
    },
  ],
});

function pending(
  chain: ApprovalChain,
  currentStep = 0,
  decisions: RecordedDecision[] = [],
): ChainRequestState {
  return { chain, status: "PENDING", currentStep, decisions };
}

/** Applies a decision and returns the next state, failing the test on rejection. */
function decide(
  state: ChainRequestState,
  actor: ChainActor,
  decision: "APPROVE" | "REQUEST_CHANGES",
) {
  const result = nextStateAfterDecision(state, actor, decision);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.reason}`);
  const { outcome } = result;
  const next: ChainRequestState = {
    chain: state.chain,
    status: outcome.status,
    currentStep: outcome.currentStep,
    decisions: [...state.decisions, { step: outcome.decidedStep, userId: actor.id, decision }],
  };
  return { outcome, next };
}

describe("ApprovalChain schema", () => {
  it("accepts the default chain", () => {
    expect(ApprovalChain.parse(DEFAULT_APPROVAL_CHAIN)).toEqual(DEFAULT_APPROVAL_CHAIN);
    expect(DEFAULT_APPROVAL_CHAIN.steps).toEqual([
      {
        name: "Manager review",
        approverRoles: ["ADMIN", "MANAGER"],
        approverUserIds: [],
        minApprovals: 1,
      },
    ]);
  });

  it("hands out fresh copies of the default and keeps the constant frozen", () => {
    const copy = defaultApprovalChain();
    copy.steps[0]!.approverRoles.push("EDITOR");
    expect(DEFAULT_APPROVAL_CHAIN.steps[0]!.approverRoles).toEqual(["ADMIN", "MANAGER"]);
    expect(Object.isFrozen(DEFAULT_APPROVAL_CHAIN.steps[0]!.approverRoles)).toBe(true);
  });

  const step = { name: "S", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 };
  it.each([
    ["no steps", { steps: [] }],
    ["six steps", { steps: Array.from({ length: 6 }, () => step) }],
    ["minApprovals 0", { steps: [{ ...step, minApprovals: 0 }] }],
    ["minApprovals 4", { steps: [{ ...step, minApprovals: 4 }] }],
    ["no approvers", { steps: [{ ...step, approverRoles: [] }] }],
    ["duplicate roles", { steps: [{ ...step, approverRoles: ["ADMIN", "ADMIN"] }] }],
    ["blank name", { steps: [{ ...step, name: "  " }] }],
    [
      "more approvals than named users",
      { steps: [{ ...step, approverRoles: [], approverUserIds: ["u1"], minApprovals: 2 }] },
    ],
  ])("rejects %s", (_label, input) => {
    expect(ApprovalChain.safeParse(input).success).toBe(false);
  });

  it("allows up to five steps and three approvals", () => {
    const chain = { steps: Array.from({ length: 5 }, () => ({ ...step, minApprovals: 3 })) };
    expect(ApprovalChain.safeParse(chain).success).toBe(true);
  });
});

describe("canDecideStep", () => {
  it("matches by role or by named user", () => {
    expect(canDecideStep(manager1, twoStepChain, 0)).toBe(true);
    expect(canDecideStep(admin, twoStepChain, 0)).toBe(false);
    expect(canDecideStep(admin, twoStepChain, 1)).toBe(true);
    expect(canDecideStep(namedEditor, twoStepChain, 1)).toBe(true);
    expect(canDecideStep(editor, twoStepChain, 1)).toBe(false);
  });

  it("is false for a step that does not exist", () => {
    expect(canDecideStep(admin, twoStepChain, 2)).toBe(false);
    expect(canDecideStep(admin, twoStepChain, -1)).toBe(false);
  });
});

describe("nextStateAfterDecision", () => {
  it("approves a single-step default chain with one eligible approval", () => {
    const result = nextStateAfterDecision(pending(defaultApprovalChain()), manager1, "APPROVE");
    expect(result).toEqual({
      ok: true,
      outcome: {
        status: "APPROVED",
        decidedStep: 0,
        currentStep: 0,
        stepCompleted: true,
        approvals: 1,
        required: 1,
      },
    });
  });

  it("walks a multi-step chain, honouring minApprovals and named approvers", () => {
    let state = pending(twoStepChain);

    const first = decide(state, manager1, "APPROVE");
    expect(first.outcome).toMatchObject({
      status: "PENDING",
      currentStep: 0,
      approvals: 1,
      required: 2,
    });
    expect(first.outcome.stepCompleted).toBe(false);
    state = first.next;

    expect(nextStateAfterDecision(state, manager1, "APPROVE")).toEqual({
      ok: false,
      reason: "ALREADY_DECIDED",
    });
    expect(nextStateAfterDecision(state, editor, "APPROVE")).toEqual({
      ok: false,
      reason: "NOT_ELIGIBLE",
    });
    expect(nextStateAfterDecision(state, admin, "APPROVE")).toEqual({
      ok: false,
      reason: "NOT_ELIGIBLE",
    });

    const second = decide(state, manager2, "APPROVE");
    expect(second.outcome).toMatchObject({
      status: "PENDING",
      decidedStep: 0,
      currentStep: 1,
      stepCompleted: true,
      approvals: 2,
    });
    state = second.next;

    // Step 1 only accepts its named users, whatever their role.
    expect(nextStateAfterDecision(state, manager1, "APPROVE")).toEqual({
      ok: false,
      reason: "NOT_ELIGIBLE",
    });
    expect(canDecideRequest(state, namedEditor)).toBe(true);

    const last = decide(state, namedEditor, "APPROVE");
    expect(last.outcome).toMatchObject({
      status: "APPROVED",
      decidedStep: 1,
      currentStep: 1,
      stepCompleted: true,
    });
    expect(nextStateAfterDecision(last.next, admin, "APPROVE")).toEqual({
      ok: false,
      reason: "NOT_PENDING",
    });
  });

  it("only counts approvals recorded on the current step", () => {
    const chain = ApprovalChain.parse({
      steps: [
        { name: "A", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 },
        { name: "B", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 2 },
      ],
    });
    const other: ChainActor = { id: "u-admin-2", role: "ADMIN" };
    const afterA = decide(pending(chain), admin, "APPROVE");
    expect(afterA.outcome).toMatchObject({ status: "PENDING", currentStep: 1 });

    // The same admin may approve the next step too, but that is a fresh count.
    const firstB = decide(afterA.next, admin, "APPROVE");
    expect(firstB.outcome).toMatchObject({
      status: "PENDING",
      currentStep: 1,
      approvals: 1,
      required: 2,
    });
    const secondB = decide(firstB.next, other, "APPROVE");
    expect(secondB.outcome.status).toBe("APPROVED");
  });

  it("resolves as CHANGES_REQUESTED at any step without moving the step", () => {
    const atStepOne = pending(twoStepChain, 1, [
      { step: 0, userId: manager1.id, decision: "APPROVE" },
      { step: 0, userId: manager2.id, decision: "APPROVE" },
    ]);
    const result = nextStateAfterDecision(atStepOne, admin, "REQUEST_CHANGES");
    expect(result).toEqual({
      ok: true,
      outcome: {
        status: "CHANGES_REQUESTED",
        decidedStep: 1,
        currentStep: 1,
        stepCompleted: false,
        approvals: 0,
        required: 1,
      },
    });

    const early = nextStateAfterDecision(pending(twoStepChain), manager1, "REQUEST_CHANGES");
    expect(early.ok && early.outcome.status).toBe("CHANGES_REQUESTED");
  });

  it("rejects decisions on resolved requests and out-of-range steps", () => {
    for (const status of ["APPROVED", "CHANGES_REQUESTED", "CANCELLED"] as const) {
      const state = { ...pending(twoStepChain), status };
      expect(nextStateAfterDecision(state, manager1, "APPROVE")).toEqual({
        ok: false,
        reason: "NOT_PENDING",
      });
      expect(canDecideRequest(state, manager1)).toBe(false);
    }
    expect(nextStateAfterDecision(pending(twoStepChain, 5), admin, "APPROVE")).toEqual({
      ok: false,
      reason: "INVALID_STEP",
    });
  });
});

describe("chain completability", () => {
  const team: ChainTeamMember[] = [
    { ...admin, isActive: true },
    { ...manager1, isActive: true },
    { ...manager2, isActive: false },
    { ...editor, isActive: true },
    { ...namedEditor, isActive: true },
  ];

  it("counts active teammates eligible by role or by name, each once", () => {
    const [managers, signOff] = twoStepChain.steps;
    expect(eligibleApprovers(managers!, team).map(({ id }) => id)).toEqual([manager1.id]);
    expect(eligibleApprovers(signOff!, team).map(({ id }) => id)).toEqual([
      admin.id,
      namedEditor.id,
    ]);

    const overlapping = ApprovalChain.parse({
      steps: [
        {
          name: "Admins, plus the admin by name",
          approverRoles: ["ADMIN"],
          approverUserIds: [admin.id],
          minApprovals: 1,
        },
      ],
    });
    expect(eligibleApprovers(overlapping.steps[0]!, team)).toHaveLength(1);
  });

  it("reports the steps the team can't complete", () => {
    // Two managers are named in the role, but one is deactivated.
    expect(chainShortfalls(twoStepChain, team)).toEqual([
      { step: 0, name: "Managers", eligible: 1, required: 2 },
    ]);
    expect(chainShortfalls(defaultApprovalChain(), team)).toEqual([]);

    const soloAdmin = ApprovalChain.parse({
      steps: [
        { name: "Manager review", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 },
        { name: "Brand lead", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 2 },
      ],
    });
    expect(chainShortfalls(soloAdmin, [{ ...admin, isActive: true }])).toEqual([
      { step: 1, name: "Brand lead", eligible: 1, required: 2 },
    ]);
    expect(chainShortfalls(soloAdmin, [])).toEqual([
      { step: 0, name: "Manager review", eligible: 0, required: 1 },
      { step: 1, name: "Brand lead", eligible: 0, required: 2 },
    ]);
  });

  it("agrees with the chain walk: a reported step really can't complete", () => {
    const chain = ApprovalChain.parse({
      steps: [{ name: "Admins", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 2 }],
    });
    expect(chainShortfalls(chain, [{ ...admin, isActive: true }])).toHaveLength(1);
    const once = decide(pending(chain), admin, "APPROVE");
    expect(once.outcome.stepCompleted).toBe(false);
    expect(nextStateAfterDecision(once.next, admin, "APPROVE")).toEqual({
      ok: false,
      reason: "ALREADY_DECIDED",
    });
  });

  it("describes a shortfall in words", () => {
    expect(describeShortfall({ step: 1, name: "B", eligible: 1, required: 2 })).toBe(
      "needs 2 approvals, but only 1 active teammate can approve it",
    );
    expect(describeShortfall({ step: 0, name: "A", eligible: 0, required: 1 })).toBe(
      "needs 1 approval, but no active teammate can approve it",
    );
    expect(describeShortfall({ step: 0, name: "A", eligible: 2, required: 3 })).toBe(
      "needs 3 approvals, but only 2 active teammates can approve it",
    );
  });
});
