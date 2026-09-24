import { BudgetDto } from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { getBudget } from "../services/budget";
import type { RouteModule } from "../types";

/*
 * Budget (DESIGN §E "system"): today's (UTC) token spend against DAILY_TOKEN_CAP, which the
 * PlanCard compares its estimate with.
 *   GET /budget   budget.read
 */
export const budgetRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/budget",
    { onRequest: requireCap("budget.read"), schema: { response: { 200: BudgetDto } } },
    () => getBudget(deps),
  );
};
