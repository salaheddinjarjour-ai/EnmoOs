// @ts-check
import path from "node:path";
import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const WEB_ROOT = "apps/web";
const TS_FILES = ["**/*.{ts,tsx,mts,cts}"];
const JS_FILES = ["**/*.{js,jsx,mjs,cjs}"];

// The web app is a thin API client; server packages must never end up in the browser bundle.
const SERVER_ONLY_PACKAGES = ["@enmo/db", "@enmo/agents", "@enmo/providers"];
const SERVER_ONLY_MESSAGE =
  "apps/web talks to the API only; import shared types from @enmo/shared.";

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "**/.next/",
    "**/.open-next/",
    "**/.turbo/",
    "**/.wrangler/",
    "**/src/generated/",
    "**/coverage/",
    "**/playwright-report/",
    "**/test-results/",
    "**/next-env.d.ts",
  ]),

  js.configs.recommended,
  {
    files: TS_FILES,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: JS_FILES,
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // Behind Render and Cloudflare, request.ip is the edge that reached Render (lib/trusted-proxies.ts).
    files: ["apps/api/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["ip", "ips"].map((property) => ({
          object: "request",
          property,
          message: "Use request.clientIp: in production request.ip is a proxy hop, not the client.",
        })),
      ],
    },
  },

  // Next.js rules, scoped to the web app (ESLint resolves their globs against basePath).
  ...nextCoreWebVitals.map((config) => ({ ...config, basePath: WEB_ROOT })),
  {
    basePath: WEB_ROOT,
    // Absolute, so @next/next rules find src/app whether ESLint runs from the root or apps/web.
    settings: { next: { rootDir: path.join(import.meta.dirname, WEB_ROOT) } },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: SERVER_ONLY_PACKAGES.map((name) => ({ name, message: SERVER_ONLY_MESSAGE })),
          patterns: [
            {
              group: SERVER_ONLY_PACKAGES.map((name) => `${name}/*`),
              message: SERVER_ONLY_MESSAGE,
            },
          ],
        },
      ],
    },
  },
);
