import type { Deps } from "../deps";
import { createFirstAdmin } from "./users";

/**
 * Boot hook (DESIGN §E "Bootstrap"): when the users table is empty and SEED_ADMIN_EMAIL /
 * SEED_ADMIN_PASSWORD are set, create that ADMIN (with a `user.create` audit row). Idempotent and
 * safe under concurrent boots; once any user exists it does nothing, so a later change to the seed
 * variables never resets a password.
 */
export async function bootstrapSeedAdmin(
  deps: Pick<Deps, "config" | "prisma" | "logger">,
): Promise<void> {
  const {
    SEED_ADMIN_EMAIL: email,
    SEED_ADMIN_PASSWORD: password,
    SEED_ADMIN_NAME: name,
  } = deps.config;
  if (!email || !password) return;

  const admin = await createFirstAdmin(deps.prisma, { email, password, name });
  if (admin) deps.logger.info({ userId: admin.id, email: admin.email }, "created seed admin");
}
