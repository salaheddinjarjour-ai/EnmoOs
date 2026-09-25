import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    env: { NODE_ENV: "test" },
    // sharp renders on libvips' own thread pool; the first text render also builds the font cache.
    testTimeout: 20_000,
  },
});
