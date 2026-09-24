import { z } from "zod";
import type { PostStatus } from "./enums";

/** The seven Command Center kanban columns, in board order. */
export const KanbanColumn = z.enum([
  "IDEA",
  "DRAFT",
  "VISUAL",
  "APPROVAL",
  "SCHEDULED",
  "LIVE",
  "SCORED",
]);
export type KanbanColumn = z.infer<typeof KanbanColumn>;

export const KANBAN_COLUMN_LABEL: Readonly<Record<KanbanColumn, string>> = {
  IDEA: "Idea",
  DRAFT: "Draft",
  VISUAL: "Visual",
  APPROVAL: "Approval",
  SCHEDULED: "Scheduled",
  LIVE: "Live",
  SCORED: "Scored",
};

export const StatusPill = z.enum(["PLANNING", "PENDING_APPROVAL", "SCHEDULED", "LIVE", "LEARNED"]);
export type StatusPill = z.infer<typeof StatusPill>;

/** Every status except FAILED, which has no board position of its own. */
export type ActivePostStatus = Exclude<PostStatus, "FAILED">;

export interface BoardPlacement {
  column: KanbanColumn;
  pill: StatusPill;
  /** Past human approval: the post card gets the green border. */
  approved: boolean;
}

/** DESIGN §B status mapping. */
export const POST_STATUS_BOARD: Readonly<Record<ActivePostStatus, BoardPlacement>> = {
  IDEA: { column: "IDEA", pill: "PLANNING", approved: false },
  DRAFTING: { column: "DRAFT", pill: "PLANNING", approved: false },
  CHANGES_REQUESTED: { column: "DRAFT", pill: "PLANNING", approved: false },
  VISUALIZING: { column: "VISUAL", pill: "PLANNING", approved: false },
  ADAPTING: { column: "VISUAL", pill: "PLANNING", approved: false },
  QA: { column: "VISUAL", pill: "PLANNING", approved: false },
  PENDING_APPROVAL: { column: "APPROVAL", pill: "PENDING_APPROVAL", approved: false },
  APPROVED: { column: "SCHEDULED", pill: "SCHEDULED", approved: true },
  SCHEDULED: { column: "SCHEDULED", pill: "SCHEDULED", approved: true },
  PUBLISHING: { column: "SCHEDULED", pill: "SCHEDULED", approved: true },
  LIVE: { column: "LIVE", pill: "LIVE", approved: true },
  SCORED: { column: "SCORED", pill: "LEARNED", approved: true },
};

export interface PostPlacement extends BoardPlacement {
  failed: boolean;
}

/**
 * Where a post sits on the board. A FAILED post stays in the column (and keeps the pill) of the
 * stage it failed in; pass that stage as `failedFrom`, or derive it with `inferFailedStage`.
 */
export function postPlacement(
  status: PostStatus,
  failedFrom?: ActivePostStatus | null,
): PostPlacement {
  if (status === "FAILED") {
    return { ...POST_STATUS_BOARD[failedFrom ?? "DRAFTING"], failed: true };
  }
  return { ...POST_STATUS_BOARD[status], failed: false };
}

/**
 * Best-effort stage for a FAILED post from fields every Post row carries: published posts fail
 * in Live, approved ones while scheduling/publishing, drafted ones in production, the rest while
 * drafting.
 */
export function inferFailedStage(post: {
  liveAt: unknown;
  approvedAt: unknown;
  copy: unknown;
}): ActivePostStatus {
  if (post.liveAt != null) return "LIVE";
  if (post.approvedAt != null) return "PUBLISHING";
  if (post.copy != null) return "QA";
  return "DRAFTING";
}
