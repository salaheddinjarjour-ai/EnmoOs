import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/*
 * Unit tests for the web app's pure modules (src/**\/*.test.ts). The Playwright specs in e2e/ are
 * run by `test:e2e`, so they are kept out of vitest's default *.spec.ts pattern. `@/` resolves as
 * in tsconfig.json, so tested modules can import the way the rest of the app does.
 */
export default defineConfig({
  resolve: {
    alias: { "@/": fileURLToPath(new URL("./src/", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
