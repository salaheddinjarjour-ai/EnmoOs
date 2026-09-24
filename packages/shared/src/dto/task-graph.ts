import { z } from "zod";
import { TaskGraphStatus } from "../enums";
import { PlannedPost, TaskNode } from "../contracts/manager";
import { PlanEstimate } from "../task-graph";
import { Id, IsoDateTime, NamedRef, VerbatimText } from "./common";

/**
 * GET /v1/task-graphs/:id — the PlanCard. Also the response of POST /task-graphs/:id/approve and
 * POST /task-graphs/:id/request-changes (the graph acted on, with its new status).
 */
export const TaskGraphDto = z.object({
  id: Id,
  campaignId: Id,
  version: z.int().positive(),
  status: TaskGraphStatus,
  /** Plain-language plan summary. */
  summary: z.string(),
  posts: z.array(PlannedPost),
  nodes: z.array(TaskNode),
  /** Code-computed; compare against GET /budget's `remaining`. */
  estimate: PlanEstimate,
  /** The feedback this version answers, verbatim (null for version 1). */
  changeRequest: z.string().nullable(),
  approvedBy: NamedRef.nullable(),
  approvedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type TaskGraphDto = z.infer<typeof TaskGraphDto>;

/** POST /v1/task-graphs/:id/request-changes: re-plans as version n+1 with `feedback` verbatim. */
export const RequestPlanChangesRequest = z.object({
  feedback: VerbatimText,
});
export type RequestPlanChangesRequest = z.infer<typeof RequestPlanChangesRequest>;
