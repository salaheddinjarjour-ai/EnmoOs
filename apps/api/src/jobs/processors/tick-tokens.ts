import { checkAccountTokens } from "../../publishing/tokens";
import type { JobProcessor } from "../types";

/**
 * tick.tokens, hourly (DESIGN §D, §F "Meta OAuth"): checks each ACTIVE Meta account's token once a
 * day (deps.oauth.meta.debugToken), records lastCheckedAt, marks invalid or expired ones EXPIRED
 * or REVOKED and raises a `token_expiring` alert for those and for tokens about to lapse
 * (publishing/tokens.ts).
 */
export const tickTokensProcessor: JobProcessor = (_job, deps) => checkAccountTokens(deps);
