import { defineConfig } from "vitest/config";

/*
 * Unit tests for the web app's pure modules (src/**\/*.test.ts). The Playwright specs in e2e/ are
 * run by `test:e2e`, so they are kept out of vitest's default *.spec.ts pattern.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
