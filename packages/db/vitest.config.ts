import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // One file at a time: the DB-backed suites share a database.
    fileParallelism: false,
  },
});
