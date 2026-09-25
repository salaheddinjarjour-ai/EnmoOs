/* Constants shared by playwright.config.ts and the specs (e.g. `import { E2E_ADMIN } from "./env"`). */

export const API_PORT = 4100;
export const WEB_PORT = 3100;
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Created on API boot from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (the database starts empty). */
export const E2E_ADMIN = { email: "admin@enmo.test", password: "enmo-admin-pass-123" } as const;

/**
 * The API's PIPELINE_ACTIONS: the whole Phase 3 pipeline (copy, the Visual Director's shots, then
 * Manager QA). E2E_PIPELINE_ACTIONS narrows it, e.g. write,qa to replay the Phase 2 story alone.
 */
export const PIPELINE_ACTIONS = process.env.E2E_PIPELINE_ACTIONS ?? "write,direct,qa";
