import {
  chainShortfalls,
  describeShortfall,
  type ApprovalChain,
  type ClientDto,
  type TeamMember,
} from "@enmo/shared";

/*
 * What the team as it stands means for an approval chain: steps too few active teammates can
 * decide (they would hold every post forever), and named approvers who were deactivated or left.
 * The API refuses to save a chain with either; a chain can also fall into this state later, when
 * someone is deactivated or changes role, so the editor and the Team screen both flag it.
 */

export const DEPARTED_APPROVERS =
  "Remove the named approvers who are deactivated or no longer on the team.";

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Team-dependent problems by step index; empty when the team can complete every step. */
export function chainTeamIssues(
  chain: ApprovalChain,
  team: readonly TeamMember[],
): Map<number, string[]> {
  const issues = new Map<number, string[]>();
  const add = (step: number, message: string) => {
    issues.set(step, [...(issues.get(step) ?? []), message]);
  };

  const activeIds = new Set(team.filter((member) => member.isActive).map((member) => member.id));
  chain.steps.forEach((step, index) => {
    if (step.approverUserIds.some((id) => !activeIds.has(id))) add(index, DEPARTED_APPROVERS);
  });
  for (const shortfall of chainShortfalls(chain, team)) {
    add(
      shortfall.step,
      `${capitalize(describeShortfall(shortfall))}. Add approvers or ask for fewer approvals.`,
    );
  }
  return issues;
}

export interface ChainAttention<T> {
  client: T;
  /** One line per affected step, e.g. `Step 2 "Brand lead": needs 2 approvals, but …`. */
  steps: string[];
}

/** The clients whose approval chain the current team can't complete, in the order given. */
export function chainsNeedingAttention<T extends Pick<ClientDto, "approvalChain">>(
  clients: readonly T[],
  team: readonly TeamMember[],
): ChainAttention<T>[] {
  return clients.flatMap((client) => {
    const { steps } = client.approvalChain;
    const shortfalls = new Map(chainShortfalls(client.approvalChain, team).map((s) => [s.step, s]));
    const lines = [...chainTeamIssues(client.approvalChain, team).keys()]
      .sort((a, b) => a - b)
      .map((index) => {
        const shortfall = shortfalls.get(index);
        const problem = shortfall
          ? describeShortfall(shortfall)
          : "names an approver who is deactivated or no longer on the team";
        return `Step ${index + 1} "${steps[index]?.name ?? ""}": ${problem}`;
      });
    return lines.length > 0 ? [{ client, steps: lines }] : [];
  });
}
