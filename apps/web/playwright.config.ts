import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, API_URL, E2E_ADMIN, PIPELINE_ACTIONS, WEB_PORT, WEB_URL } from "./e2e/env";

/*
 * Browser e2e (DESIGN §H): `pnpm --filter @enmo/web test:e2e [-- phase1]`.
 * Starts the API with tsx (embedded worker, mock LLM, dry-run publishing) against a freshly
 * migrated and emptied enmo_e2e database, and the web app with `next build && next start`.
 * Browsers come from PLAYWRIGHT_BROWSERS_PATH (locally /opt/pw-browsers); never `playwright install`
 * outside CI.
 *
 * Every run gets its own servers: the database reset lives in the API command and the login rate
 * limits are counted in the API's memory, so a server left over from another run (stale rows,
 * spent sign-in budget, an old web build) is refused with "port already used" rather than reused.
 */

const PREINSTALLED_BROWSERS = "/opt/pw-browsers";
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(PREINSTALLED_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = PREINSTALLED_BROWSERS;
}

const CI = Boolean(process.env.CI);
const API_DIR = path.resolve(import.meta.dirname, "../api");

function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:54329/enmo_test",
  );
  url.pathname = "/enmo_e2e";
  return url.toString();
}

// A fixed, test-only key: the e2e database holds nothing worth encrypting.
const E2E_TOKEN_ENC_KEY = Buffer.alloc(32, 0x2e).toString("base64");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  // The specs are serial stories over one database: a retry would replay a group against the rows
  // (and the sign-in budget) its first attempt left behind, so it could never pass.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "api",
      cwd: API_DIR,
      command: "pnpm exec tsx test/helpers/prepare-e2e-db.ts && pnpm exec tsx src/server.ts",
      url: `${API_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      // Explicit values override anything inherited from the shell (Playwright merges process.env).
      env: {
        NODE_ENV: "development",
        LOG_LEVEL: "warn",
        PORT: String(API_PORT),
        APP_ORIGINS: WEB_URL,
        COOKIE_SECURE: "false",
        COOKIE_DOMAIN: "",
        DATABASE_URL: e2eDatabaseUrl(),
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:63799",
        BULLMQ_PREFIX: "enmo-e2e",
        EMBEDDED_WORKER: "true",
        LLM_PROVIDER: "mock",
        ANTHROPIC_API_KEY: "",
        MOCK_LLM_FAULTS: "",
        // A little latency per mock call, so drafting progress streams in over SSE as it would live.
        MOCK_LLM_DELAY_MS: "150",
        PIPELINE_ACTIONS,
        VISUAL_PROVIDER: "mock",
        // MockProvider settles on its second poll: about 2.5s of rendering per take, quick enough
        // for the cards and long enough for phase3.spec to see a card shimmer while it renders.
        RENDER_POLL_DELAY_MS: "1000",
        PUBLISH_MODE: "dry-run",
        // Test-only hooks (apps/api/src/routes/e2e-hooks.ts): phase4.spec runs tick.publish at a
        // post's slot instead of waiting the half hour a slot is at least away.
        ENMO_E2E: "1",
        STORAGE_DRIVER: "local",
        STORAGE_LOCAL_DIR: ".data/e2e-storage",
        TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY,
        SEED_ADMIN_EMAIL: E2E_ADMIN.email,
        SEED_ADMIN_PASSWORD: E2E_ADMIN.password,
      },
    },
    {
      name: "web",
      command: `pnpm exec next build && pnpm exec next start -p ${WEB_PORT}`,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 300_000,
      env: { NEXT_PUBLIC_API_URL: API_URL },
    },
  ],
});
