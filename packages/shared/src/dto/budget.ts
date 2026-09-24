import { z } from "zod";
import { IsoDate, IsoDateTime } from "./common";

/** GET /v1/budget — today's (UTC) token spend against DAILY_TOKEN_CAP; also the budget.updated event. */
export const BudgetDto = z.object({
  day: IsoDate,
  /** Input + output tokens spent today. */
  used: z.int().nonnegative(),
  cap: z.int().nonnegative(),
  remaining: z.int().nonnegative(),
  /** AgentTasks waiting in BLOCKED_BUDGET for the next UTC day. */
  blockedTasks: z.int().nonnegative(),
  /** Next UTC midnight, when blocked tasks are re-queued. */
  resetsAt: IsoDateTime,
});
export type BudgetDto = z.infer<typeof BudgetDto>;
