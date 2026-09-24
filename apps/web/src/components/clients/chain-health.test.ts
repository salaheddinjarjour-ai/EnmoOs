import { ApprovalChain, defaultApprovalChain, type TeamMember } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { DEPARTED_APPROVERS, chainTeamIssues, chainsNeedingAttention } from "./chain-health";

const admin: TeamMember = { id: "u-admin", name: "Admin", role: "ADMIN", isActive: true };
const layla: TeamMember = { id: "u-layla", name: "Layla", role: "MANAGER", isActive: true };
const former: TeamMember = { id: "u-former", name: "Former", role: "MANAGER", isActive: false };

const withBrandLead = (minApprovals: number, approverUserIds: string[] = []) =>
  ApprovalChain.parse({
    steps: [
      ...defaultApprovalChain().steps,
      { name: "Brand lead", approverRoles: ["ADMIN"], approverUserIds, minApprovals },
    ],
  });

describe("chainTeamIssues", () => {
  it("is empty when the team can complete every step", () => {
    expect(chainTeamIssues(defaultApprovalChain(), [admin]).size).toBe(0);
    expect(chainTeamIssues(withBrandLead(2, [layla.id]), [admin, layla]).size).toBe(0);
  });

  it("flags a step that asks for more approvals than there are eligible teammates", () => {
    expect(chainTeamIssues(withBrandLead(2), [admin, layla])).toEqual(
      new Map([
        [
          1,
          [
            "Needs 2 approvals, but only 1 active teammate can approve it. Add approvers or ask for fewer approvals.",
          ],
        ],
      ]),
    );
  });

  it("flags deactivated and unknown named approvers, who also stop counting", () => {
    const issues = chainTeamIssues(withBrandLead(2, [former.id]), [admin, former]);
    expect(issues.get(1)?.[0]).toBe(DEPARTED_APPROVERS);
    expect(issues.get(1)?.[1]).toMatch(/^Needs 2 approvals, but only 1 active teammate/);
    expect(chainTeamIssues(withBrandLead(1, ["u-gone"]), [admin]).get(1)).toEqual([
      DEPARTED_APPROVERS,
    ]);
  });
});

describe("chainsNeedingAttention", () => {
  it("lists only the clients whose chain can't complete, one line per step", () => {
    const fine = { id: "c1", name: "Fine Co", approvalChain: defaultApprovalChain() };
    const stuck = { id: "c2", name: "Qahwa Co", approvalChain: withBrandLead(2, [layla.id]) };
    const team = [admin, { ...layla, isActive: false }];

    expect(chainsNeedingAttention([fine, stuck], team)).toEqual([
      {
        client: stuck,
        steps: [
          'Step 2 "Brand lead": needs 2 approvals, but only 1 active teammate can approve it',
        ],
      },
    ]);
    expect(chainsNeedingAttention([fine, stuck], [admin, layla])).toEqual([]);
  });
});
