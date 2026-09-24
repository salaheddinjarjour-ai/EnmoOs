import { z } from "zod";
import { AgentName, PipelineAction, TaskStatus } from "../enums";
import { Feedback } from "../contracts/common";
import { Id, IsoDateTime, listResponse } from "./common";

export const AgentTaskDto = z.object({
  id: Id,
  graphId: Id,
  /** "n7", or "n7.r1" for a revision node. */
  nodeKey: z.string(),
  agent: AgentName,
  action: PipelineAction,
  postId: Id.nullable(),
  postRef: z.string().nullable(),
  dependsOn: z.array(Id),
  status: TaskStatus,
  revision: z.int().nonnegative(),
  contractAttempts: z.int().nonnegative(),
  feedback: Feedback.nullable(),
  error: z.string().nullable(),
  queuedAt: IsoDateTime.nullable(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentTaskDto = z.infer<typeof AgentTaskDto>;

/** GET /v1/campaigns/:id/tasks — every task of the campaign's graphs, in graph then node order. */
export const AgentTaskListResponse = listResponse(AgentTaskDto);
export type AgentTaskListResponse = z.infer<typeof AgentTaskListResponse>;

/**
 * POST /v1/agent-tasks/:id/resolve → AgentTaskDto, for ESCALATED/FAILED tasks. `retry` re-runs it
 * with fresh contract attempts; `accept_best` (visual review escalations, Phase 3) keeps the best
 * take so far.
 */
export const ResolveAgentTaskRequest = z.object({
  action: z.enum(["retry", "accept_best"]),
});
export type ResolveAgentTaskRequest = z.infer<typeof ResolveAgentTaskRequest>;
