import { defineConfig } from "vitest/config";

/*
 * unit:        src/**\/*.test.ts, no services needed.
 * integration: test/integration + test/e2e against real Postgres (TEST_DATABASE_URL, default the
 *              local enmo_test; see test/helpers/databases.ts) and Redis. Migrated once by the
 *              global setup; test/setup.ts truncates every table before each test. One file at a
 *              time because they share the database.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          env: { NODE_ENV: "test" },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "test/e2e/**/*.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          setupFiles: ["./test/setup.ts"],
          fileParallelism: false,
          env: { NODE_ENV: "test" },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
