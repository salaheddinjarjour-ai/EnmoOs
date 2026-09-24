import { defineConfig } from "tsup";

/*
 * Workspace packages (@enmo/*) are TypeScript source, so they are bundled in; every npm dependency
 * stays external and must therefore be listed in apps/api/package.json (scripts/smoke-api.mjs boots
 * dist/server.js to catch a missing one).
 */
export default defineConfig({
  entry: {
    server: "src/server.ts",
    worker: "src/worker.ts",
    "create-admin": "src/scripts/create-admin.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  noExternal: [/^@enmo\//],
  sourcemap: true,
  clean: true,
  splitting: true,
});
