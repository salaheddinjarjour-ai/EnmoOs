#!/usr/bin/env node
// @ts-check
/*
 * Boots the bundled API exactly as Render starts it (`node --enable-source-maps
 * apps/api/dist/server.js`) and checks GET /healthz, then GET /readyz (Postgres + Redis), then a
 * clean SIGTERM shutdown. It catches what the test suites cannot: a runtime dependency missing
 * from apps/api/package.json, a bundling mistake, or a crash at boot.
 *
 *   pnpm --filter @enmo/api build && node scripts/smoke-api.mjs
 *
 * Needs Postgres and Redis (`scripts/services.sh up` locally, the service containers in CI).
 * Database: SMOKE_DATABASE_URL, else TEST_DATABASE_URL, else DATABASE_URL, else the local
 * enmo_test. Redis: REDIS_URL, else the local one. The server only runs read-only probes (no seed
 * admin, no embedded worker), so any migrated or even empty database will do.
 *
 * The child gets a fixed, minimal environment rather than this shell's: a developer's
 * ANTHROPIC_API_KEY, SEED_ADMIN_* or MOCK_LLM_FAULTS must never change what the smoke test boots.
 *
 * Exit code 0 when all three checks pass, 1 otherwise. SMOKE_TIMEOUT_MS (default 30000) bounds
 * the wait for /healthz + /readyz.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_ENTRY = path.join(ROOT, "apps/api/dist/server.js");
const HOST = "127.0.0.1";

const LOCAL_DATABASE_URL = "postgresql://postgres@127.0.0.1:54329/enmo_test";
const LOCAL_REDIS_URL = "redis://127.0.0.1:63799";
// Throwaway AES key: the smoke server never encrypts anything that outlives it.
const SMOKE_TOKEN_ENC_KEY = Buffer.alloc(32, 0x53).toString("base64");

const READY_TIMEOUT_MS = positiveInt(process.env.SMOKE_TIMEOUT_MS, 30_000);
// The server force-exits 15s after SIGTERM (apps/api/src/lib/shutdown.ts); allow a margin.
const SHUTDOWN_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 2_500;
const POLL_INTERVAL_MS = 250;
const OUTPUT_TAIL_LINES = 80;

// Only what node itself needs; everything the API reads is set explicitly below.
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SYSTEMROOT",
];

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** @param {string} message */
function log(message) {
  console.log(`[smoke] ${message}`);
}

/** `postgresql://user:secret@host:5432/db` → `host:5432/db`, so credentials never reach CI logs. */
function describeUrl(/** @type {string} */ url) {
  try {
    const { host, pathname } = new URL(url);
    return `${host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

/** Asks the OS for a free port; the tiny race until the child binds it is acceptable here. */
function freePort() {
  return /** @type {Promise<number>} */ (
    new Promise((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, HOST, () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === "object") resolve(address.port);
          else reject(new Error("could not determine a free port"));
        });
      });
    })
  );
}

/**
 * @param {number} port
 * @param {string} storageDir
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv(port, storageDir) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of INHERITED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    // Production mode, as on Render, with every external integration mocked or dry-run.
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    HOST,
    PORT: String(port),
    APP_ORIGINS: "http://localhost:3000",
    DATABASE_URL:
      process.env.SMOKE_DATABASE_URL ||
      process.env.TEST_DATABASE_URL ||
      process.env.DATABASE_URL ||
      LOCAL_DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL || LOCAL_REDIS_URL,
    BULLMQ_PREFIX: `smoke-${process.pid}`,
    EMBEDDED_WORKER: "false",
    SCHEDULERS_ENABLED: "false",
    LLM_PROVIDER: "mock",
    VISUAL_PROVIDER: "mock",
    PUBLISH_MODE: "dry-run",
    STORAGE_DRIVER: "local",
    // Production refuses the local driver (Render's disk is ephemeral); the smoke run's is a temp dir.
    ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true",
    STORAGE_LOCAL_DIR: storageDir,
    TOKEN_ENC_KEY: process.env.TOKEN_ENC_KEY || SMOKE_TOKEN_ENC_KEY,
  };
}

/** Keeps the last lines the server printed, to show them when a check fails. */
function createOutputTail() {
  /** @type {string[]} */
  const lines = [];
  let partial = "";
  return {
    /** @param {Buffer} chunk */
    push(chunk) {
      const parts = (partial + chunk.toString("utf8")).split("\n");
      partial = parts.pop() ?? "";
      lines.push(...parts);
      if (lines.length > OUTPUT_TAIL_LINES) lines.splice(0, lines.length - OUTPUT_TAIL_LINES);
    },
    text() {
      return [...lines, partial].filter(Boolean).join("\n");
    },
  };
}

/**
 * @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ExitInfo
 * @typedef {{ status: number, body: unknown, text: string }} HttpResult
 */

/** @param {ExitInfo} exit */
function describeExit(exit) {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
}

/**
 * @param {string} url
 * @returns {Promise<HttpResult>}
 */
async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  /** @type {unknown} */
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON; reported verbatim
  }
  return { status: response.status, body, text };
}

/** @param {unknown} error */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = /** @type {{ code?: unknown } | undefined} */ (error.cause);
  return typeof cause?.code === "string" ? cause.code : error.message;
}

/**
 * Polls `url` until `accept` passes, the deadline expires or the server exits.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {number} options.deadline
 * @param {(result: HttpResult) => boolean} options.accept
 * @param {() => ExitInfo | undefined} options.exited
 * @param {Promise<ExitInfo>} options.exit
 */
async function waitFor({ url, deadline, accept, exited, exit }) {
  const started = Date.now();
  let last = "no response yet";
  while (Date.now() < deadline) {
    const early = exited();
    if (early) throw new Error(`server exited before answering (${describeExit(early)})`);
    try {
      const result = await getJson(url);
      if (accept(result)) return { ...result, ms: Date.now() - started };
      last = `${result.status} ${result.text.slice(0, 300)}`;
    } catch (error) {
      last = describeError(error);
    }
    await Promise.race([sleep(POLL_INTERVAL_MS), exit]);
  }
  throw new Error(`timed out after ${READY_TIMEOUT_MS} ms waiting for ${url} (last: ${last})`);
}

/** @param {unknown} body */
function isHealthy(body) {
  return typeof body === "object" && body !== null && "status" in body && body.status === "ok";
}

/** @param {unknown} body */
function isReady(body) {
  if (!isHealthy(body) || typeof body !== "object" || body === null || !("checks" in body)) {
    return false;
  }
  const checks = body.checks;
  return (
    typeof checks === "object" &&
    checks !== null &&
    "database" in checks &&
    "redis" in checks &&
    checks.database === true &&
    checks.redis === true
  );
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    log(`FAIL: ${path.relative(ROOT, SERVER_ENTRY)} not found. Run: pnpm --filter @enmo/api build`);
    return 1;
  }

  const port = await freePort();
  const storageDir = await mkdtemp(path.join(tmpdir(), "enmo-smoke-"));
  const env = childEnv(port, storageDir);
  const baseUrl = `http://${HOST}:${port}`;
  log(
    `booting apps/api/dist/server.js on ${baseUrl} ` +
      `(database ${describeUrl(env.DATABASE_URL ?? "")}, redis ${describeUrl(env.REDIS_URL ?? "")})`,
  );

  const output = createOutputTail();
  const child = spawn(process.execPath, ["--enable-source-maps", SERVER_ENTRY], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", output.push);
  child.stderr.on("data", output.push);

  /** @type {ExitInfo | undefined} */
  let exitInfo;
  /** @type {Promise<ExitInfo>} */
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once("error", (error) => {
      output.push(Buffer.from(`spawn error: ${error.message}\n`));
      exitInfo = { code: null, signal: null };
      resolve(exitInfo);
    });
  });
  const exited = () => exitInfo;

  // Never leave the server behind, whatever happens to this script.
  const killChild = () => {
    if (!exitInfo) child.kill("SIGKILL");
  };
  process.once("exit", killChild);
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    process.once(signal, () => {
      killChild();
      process.exit(130);
    });
  }

  /** @type {string | undefined} */
  let failure;
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const health = await waitFor({
      url: `${baseUrl}/healthz`,
      deadline,
      accept: ({ status, body }) => status === 200 && isHealthy(body),
      exited,
      exit,
    });
    log(`GET /healthz → ${health.status} ${health.text} (${health.ms} ms)`);

    const ready = await waitFor({
      url: `${baseUrl}/readyz`,
      deadline,
      accept: ({ status, body }) => status === 200 && isReady(body),
      exited,
      exit,
    });
    log(`GET /readyz  → ${ready.status} ${ready.text} (${ready.ms} ms)`);
  } catch (error) {
    failure = describeError(error);
  }

  // Render sends SIGTERM on every deploy; a server that cannot stop cleanly stalls rollouts.
  if (!exitInfo) {
    const stopStarted = Date.now();
    child.kill("SIGTERM");
    const stopped = await Promise.race([exit, sleep(SHUTDOWN_TIMEOUT_MS).then(() => undefined)]);
    if (!stopped) {
      child.kill("SIGKILL");
      failure ??= `server did not exit within ${SHUTDOWN_TIMEOUT_MS} ms of SIGTERM`;
    } else if (stopped.code !== 0) {
      failure ??= `unclean shutdown (${describeExit(stopped)})`;
    } else {
      log(`SIGTERM     → exit 0 (${Date.now() - stopStarted} ms)`);
    }
  }
  await rm(storageDir, { recursive: true, force: true });

  if (failure) {
    log(`FAIL: ${failure}`);
    const tail = output.text();
    if (tail) console.log(`[smoke] server output (last ${OUTPUT_TAIL_LINES} lines):\n${tail}`);
    return 1;
  }
  log("PASS");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  },
);
