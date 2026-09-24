import type { ChainActor, Role } from "@enmo/shared";

/**
 * The signed-in teammate a service acts for. `id` and `role` decide approval-chain eligibility
 * (ChainActor), `name` labels what they wrote, `ip` goes on AuditLog rows; it also satisfies the
 * `Actor` that services/clients.ts auditChange() takes. Routes build it with serviceUserOf().
 */
export interface ServiceUser extends ChainActor {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly ip: string | null;
}

export function toServiceUser(
  user: { id: string; name: string; role: Role },
  ip: string | null,
): ServiceUser {
  return { id: user.id, name: user.name, role: user.role, ip };
}
