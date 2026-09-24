import type { BriefGap, CampaignDto, ChatMessageDto } from "@enmo/shared";

/*
 * What the thread page derives from the campaign and its messages. Pure, so the rules are tested
 * in isolation:
 *   - the Manager is "thinking" while a job it owes an answer to is running (intake after a team
 *     message, the plan after the brief locks or after a change request);
 *   - the composer's target follows the campaign: brief turns while briefing, change requests
 *     while a plan waits for approval, nothing once the brief is locked and production runs.
 */

type ThreadCampaign = Pick<CampaignDto, "status" | "latestGraph">;

/** Statuses in which the Manager is still answering chat turns. */
const CONVERSING = new Set<CampaignDto["status"]>(["BRIEFING", "PLANNING"]);

export function managerThinking(
  campaign: ThreadCampaign,
  messages: readonly ChatMessageDto[],
): boolean {
  if (!CONVERSING.has(campaign.status)) return false;
  const last = messages.at(-1);
  if (!last) return false;
  // A team turn waits for intake or a re-plan; a locked brief waits for its first plan.
  return last.role === "USER" || last.kind === "BRIEF";
}

export type ComposerMode =
  | { kind: "message"; placeholder: string }
  | { kind: "plan-changes"; graphId: string; placeholder: string }
  | { kind: "closed"; reason: string };

export function composerMode(
  campaign: ThreadCampaign,
  messages: readonly ChatMessageDto[],
): ComposerMode {
  if (campaign.status === "ARCHIVED") {
    return { kind: "closed", reason: "This campaign is archived." };
  }
  if (managerThinking(campaign, messages)) {
    return { kind: "closed", reason: "The Manager is thinking…" };
  }
  if (campaign.status === "BRIEFING") {
    return { kind: "message", placeholder: "Answer the Manager, or add to the brief…" };
  }
  if (campaign.status === "PLANNING") {
    const graph = campaign.latestGraph;
    if (graph?.status === "PROPOSED") {
      return {
        kind: "plan-changes",
        graphId: graph.id,
        placeholder: "Tell the Manager what to change in the plan…",
      };
    }
    // The last planning attempt failed: the Manager asked what to adjust.
    return { kind: "message", placeholder: "Tell the Manager what to adjust…" };
  }
  return {
    kind: "closed",
    reason: "The brief is locked. Steer individual posts with Request changes.",
  };
}

/** The newest CLARIFY message, and whether the team has answered it yet. */
export function clarifyState(messages: readonly ChatMessageDto[], messageId: string) {
  const index = messages.findIndex((message) => message.id === messageId);
  const latestClarify = messages.findLastIndex((message) => message.kind === "CLARIFY");
  const answered = messages.slice(index + 1).some((message) => message.role === "USER");
  return { isLatest: index === latestClarify, answered };
}

export const GAP_LABEL: Readonly<Record<BriefGap, string>> = {
  client: "Client",
  platforms: "Platforms",
  postCount: "Post count",
  postMix: "Post mix",
  window: "Dates",
  objective: "Objective",
  productFocus: "Product focus",
};

/**
 * Where each post's card lives: a post that comes back for another round is announced again, and
 * only its newest POST_CARD message shows the live card (older ones point down the thread).
 */
export function latestCardMessage(messages: readonly ChatMessageDto[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const message of messages) {
    if (message.kind !== "POST_CARD") continue;
    for (const postId of message.payload.postIds) owner.set(postId, message.id);
  }
  return owner;
}

/**
 * The approval rounds whose post has a card in the thread. Cards land when a QA batch settles,
 * rounds as each post passes QA: approve-all only offers the posts the reviewer can see.
 */
export function requestsWithCards<T extends { postId: string }>(
  requests: readonly T[],
  messages: readonly ChatMessageDto[],
): T[] {
  const owners = latestCardMessage(messages);
  return requests.filter((request) => owners.has(request.postId));
}

/**
 * Whether agents are at work on the campaign right now: its live PROGRESS message counts tasks in
 * flight (queued, running or waiting on renders). A campaign stays PRODUCING long after its last
 * task settled, so the status alone can't say.
 */
export function agentsAtWork(messages: readonly ChatMessageDto[]): boolean {
  const progress = messages.findLast((message) => message.kind === "PROGRESS");
  if (progress?.kind !== "PROGRESS") return false;
  return progress.payload.aggregate.some((entry) => entry.running + entry.waiting > 0);
}

/** Whether the thread has reached production (posts exist to show and approve). */
export function hasPosts(campaign: ThreadCampaign): boolean {
  const graph = campaign.latestGraph;
  return graph?.status === "APPROVED" || graph?.status === "COMPLETED";
}
