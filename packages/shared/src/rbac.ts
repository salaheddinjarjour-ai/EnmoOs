import { z } from "zod";
import type { Role } from "./enums";

export const CAPABILITIES = [
  "users.manage",
  "invites.manage",
  "audit.read",
  "clients.read",
  "campaigns.read",
  "posts.read",
  "assets.read",
  "calendar.read",
  "dashboard.read",
  "budget.read",
  "clients.write",
  "clients.archive",
  "socialAccounts.manage",
  "campaigns.create",
  "chat.post",
  "plan.requestChanges",
  "posts.editCopy",
  "assets.regenerate",
  "plan.approve",
  "tasks.resolveEscalation",
  "campaigns.archive",
  "approvals.decide",
  "approvals.approveAll",
  "publish.reschedule",
  "publish.cancel",
  "publish.retry",
  "analyst.run",
] as const;

export const Capability = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof Capability>;

const EVERYONE = [
  "clients.read",
  "campaigns.read",
  "posts.read",
  "assets.read",
  "calendar.read",
  "dashboard.read",
  "budget.read",
  "campaigns.create",
  "chat.post",
  "plan.requestChanges",
  "posts.editCopy",
  "assets.regenerate",
  // Holding this only lets a user attempt a decision; the approval chain decides per step
  // (see canDecideStep in approval-chain.ts).
  "approvals.decide",
] as const satisfies readonly Capability[];

const MANAGER_AND_UP = [
  "clients.write",
  "plan.approve",
  "tasks.resolveEscalation",
  "campaigns.archive",
  // Still limited to the chain steps the user is eligible for.
  "approvals.approveAll",
  "publish.reschedule",
  "publish.cancel",
  "publish.retry",
  "analyst.run",
] as const satisfies readonly Capability[];

const ADMIN_ONLY = [
  "users.manage",
  "invites.manage",
  "audit.read",
  "clients.archive",
  "socialAccounts.manage",
] as const satisfies readonly Capability[];

/** The RBAC matrix from DESIGN §E. */
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  ADMIN: [...EVERYONE, ...MANAGER_AND_UP, ...ADMIN_ONLY],
  MANAGER: [...EVERYONE, ...MANAGER_AND_UP],
  EDITOR: [...EVERYONE],
};

const ROLE_CAPABILITY_SETS: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  ADMIN: new Set(ROLE_CAPABILITIES.ADMIN),
  MANAGER: new Set(ROLE_CAPABILITIES.MANAGER),
  EDITOR: new Set(ROLE_CAPABILITIES.EDITOR),
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITY_SETS[role].has(capability);
}

/** Capabilities in canonical CAPABILITIES order, for session payloads. */
export function capabilitiesFor(role: Role): Capability[] {
  return CAPABILITIES.filter((capability) => can(role, capability));
}
