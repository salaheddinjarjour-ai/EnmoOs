import { EFFORT_LEVELS, parseMockFaults, type Effort } from "@enmo/agents";
import {
  AgentName,
  DEFAULT_LLM_MODEL,
  Email,
  LlmProviderName,
  MAX_QA_REVISIONS as DEFAULT_MAX_QA_REVISIONS,
  MAX_VISUAL_REGENERATIONS as DEFAULT_MAX_VISUAL_REGENERATIONS,
  NewPassword,
  orderPipelineActions,
  PipelineAction,
  PublishMode,
  StorageDriver,
  VisualProviderName,
} from "@enmo/shared";
import { z } from "zod";
import { LOG_LEVELS } from "./lib/logger";
import { isTrustedProxyEntry, TRUSTED_PROXY_NAMES } from "./lib/trusted-proxies";

/*
 * The API's whole runtime configuration (DESIGN §H). Parsed once at boot by server.ts / worker.ts
 * and handed around through Deps; nothing else reads process.env.
 */

/** Used when NODE_ENV=test and TOKEN_ENC_KEY is unset. Never accepted in any other mode. */
export const TEST_TOKEN_ENC_KEY = Buffer.alloc(32, 0x5a).toString("base64");

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Every plan drafts copy and ends in Manager QA, which opens the approval round. */
export const REQUIRED_PIPELINE_ACTIONS: readonly PipelineAction[] = ["write", "qa"];

/** The per-post actions whose agents exist so far (Phase 3: the Visual Director's direct). */
export const DEFAULT_PIPELINE_ACTIONS: readonly PipelineAction[] = ["write", "direct", "qa"];

/**
 * Where the API serves STORAGE_DRIVER=local files: unversioned, because the URL is stored on every
 * Asset row (and handed to Meta/TikTok), so it must not change when the API's version does.
 */
export const LOCAL_FILES_PATH = "/files";

/** Public base of the R2 bucket's custom domain (DESIGN §F). */
export const DEFAULT_R2_PUBLIC_BASE_URL = "https://assets.enmo.marketing";

const bool = (fallback: boolean) => z.stringbool().default(fallback);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const secret = z.string().trim().min(1);

const EffortLevel = z.enum(EFFORT_LEVELS);

const HttpUrl = z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, ""));

const Origin = z.string().refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, "Expected an exact origin such as https://app.enmo.marketing (no path or trailing slash)");

function commaList<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).min(1));
}

/*
 * Who the client is (lib/trusted-proxies.ts): proxy addresses/CIDRs and names, a hop count, or
 * true/false. Production lists Render's own hops and names Cloudflare
 * (`loopback,uniquelocal,cloudflare`): X-Forwarded-For is believed only from our own hops, and
 * CF-Connecting-IP only from a Cloudflare edge. `true` believes the left-most X-Forwarded-For entry,
 * which the client writes itself, so it would let anyone pick their IP and dodge the per-IP login
 * limit; production refuses it.
 */
const TrustProxy = z.union([
  z
    .string()
    .regex(/^\d{1,2}$/)
    .transform(Number),
  z.enum(["true", "false"]).transform((value) => value === "true"),
  commaList(
    z
      .string()
      .refine(
        isTrustedProxyEntry,
        `Expected an IP address, a CIDR range or one of ${TRUSTED_PROXY_NAMES.join(", ")}`,
      ),
  ),
]);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Defaults to "silent" under test, "info" otherwise. */
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),

  // ── Server ──
  HOST: z.string().default("0.0.0.0"),
  PORT: int(1, 65_535).default(4000),
  /** Public base URL of this API (OAuth callbacks, local file URLs). Defaults to localhost:PORT. */
  API_PUBLIC_URL: HttpUrl.optional(),
  /** Proxies to believe about the client's IP, so rate limits and audit rows see clients. */
  TRUST_PROXY: TrustProxy.default(false),
  /** Exact web origins allowed by CORS and the CSRF origin check. The first is the web app URL. */
  APP_ORIGINS: commaList(Origin).default(["http://localhost:3000"]),
  /** e.g. ".enmo.marketing"; unset → host-only cookie (local dev). */
  COOKIE_DOMAIN: z.string().trim().min(1).optional(),
  /** Defaults to true in production. */
  COOKIE_SECURE: z.stringbool().optional(),
  SESSION_TTL_DAYS: int(1, 365).default(30),

  // ── Data ──
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "Expected a postgresql:// URL")
    .default("postgresql://postgres@127.0.0.1:54329/enmo_dev"),
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, "Expected a redis:// or rediss:// URL")
    .default("redis://127.0.0.1:63799"),
  BULLMQ_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,64}$/)
    .default("enmo"),
  /**
   * Seconds an idle BullMQ worker blocks waiting for jobs. Defaults to 20 in production, which
   * keeps Upstash command costs down, and 5 elsewhere.
   */
  BULLMQ_DRAIN_DELAY_SEC: int(1, 300).optional(),
  /** Run the queue consumers inside the API process (dev, Render free tier). */
  EMBEDDED_WORKER: bool(false),
  SCHEDULERS_ENABLED: bool(true),

  // ── LLM ──
  /** Defaults to "anthropic" when ANTHROPIC_API_KEY is set, else "mock". */
  LLM_PROVIDER: LlmProviderName.optional(),
  ANTHROPIC_API_KEY: secret.optional(),
  /** Deliberately not ANTHROPIC_BASE_URL, so a developer shell's value is never picked up. */
  ENMO_ANTHROPIC_BASE_URL: HttpUrl.default("https://api.anthropic.com"),
  ANTHROPIC_MODEL: z.string().trim().min(1).default(DEFAULT_LLM_MODEL),
  /** Daily input+output token budget across all agents (UTC day). */
  DAILY_TOKEN_CAP: int(0, Number.MAX_SAFE_INTEGER).default(2_000_000),
  AGENT_CONCURRENCY: int(1, 64).default(4),
  MEDIA_CONCURRENCY: int(1, 64).default(4),
  /**
   * Per-post actions the Manager may plan, in any order; widened phase by phase as their agents
   * arrive (Phase 3 adds direct, Phase 5 adapt, Phase 6 strategy).
   */
  PIPELINE_ACTIONS: commaList(PipelineAction).default([...DEFAULT_PIPELINE_ACTIONS]),
  /** Automatic QA → revision loops per post before it goes to humans with qaNotes anyway. */
  MAX_QA_REVISIONS: int(0, 3).default(DEFAULT_MAX_QA_REVISIONS),
  /** MockLlm fault injection, e.g. "COPYWRITER.write:invalid*2,VISUAL_DIRECTOR.review:weak*3". */
  MOCK_LLM_FAULTS: z.string().trim().min(1).optional(),
  /** MockLlm latency per call, so local demos show progress arriving live instead of at once. */
  MOCK_LLM_DELAY_MS: int(0, 60_000).default(0),
  /** `output_config.effort` for every action of one agent, over the DESIGN §C defaults. */
  AGENT_EFFORT_MANAGER: EffortLevel.optional(),
  AGENT_EFFORT_STRATEGIST: EffortLevel.optional(),
  AGENT_EFFORT_COPYWRITER: EffortLevel.optional(),
  AGENT_EFFORT_VISUAL_DIRECTOR: EffortLevel.optional(),
  AGENT_EFFORT_ADAPTER: EffortLevel.optional(),
  AGENT_EFFORT_ANALYST: EffortLevel.optional(),
  AGENT_EFFORT_PUBLISHER: EffortLevel.optional(),

  // ── Visuals ──
  VISUAL_PROVIDER: VisualProviderName.default("mock"),
  /** The pair as Higgsfield hands it out, "<key id>:<key secret>"; or set the two keys below. */
  HIGGSFIELD_CREDENTIALS: secret
    .regex(/^[^:\s]+:[^:\s]+$/, 'Expected "<key id>:<key secret>"')
    .optional(),
  HIGGSFIELD_KEY_ID: secret.optional(),
  HIGGSFIELD_KEY_SECRET: secret.optional(),
  HIGGSFIELD_BASE_URL: HttpUrl.default("https://api.higgsfield.ai"),
  HIGGSFIELD_IMAGE_MODEL: z.string().trim().min(1).optional(),
  HIGGSFIELD_VIDEO_MODEL: z.string().trim().min(1).optional(),
  /** Multi-scene video assembly; without it the NoopAssembler keeps the first clip. */
  FFMPEG_PATH: z.string().trim().min(1).optional(),
  /**
   * Weak takes of one shot the Visual Director may regenerate before it escalates. The spec's cost
   * guard is at most 2 (MASTER_PLAN §02), so this may only lower it; the review is told the value.
   */
  MAX_VISUAL_REGENERATIONS: int(0, DEFAULT_MAX_VISUAL_REGENERATIONS).default(
    DEFAULT_MAX_VISUAL_REGENERATIONS,
  ),
  /**
   * Delay before the first render.poll of a job; later polls back off to at most 10 seconds
   * (DESIGN §D: 3-10s). Tests shorten it so MockProvider's two polls take milliseconds.
   */
  RENDER_POLL_DELAY_MS: int(10, 10_000).default(3_000),

  // ── Storage ──
  STORAGE_DRIVER: StorageDriver.default("local"),
  /** The local driver's directory, relative to the process's working directory. */
  STORAGE_LOCAL_DIR: z.string().trim().min(1).default(".data/assets"),
  /**
   * Render's disk is ephemeral (every deploy and restart wipes it) and Meta/TikTok fetch media by
   * public URL, so production refuses the local driver unless this says the disk is durable.
   */
  ALLOW_LOCAL_STORAGE_IN_PRODUCTION: bool(false),
  /** The local driver's public base; defaults to API_PUBLIC_URL + /files (served by this API). */
  PUBLIC_ASSET_BASE_URL: HttpUrl.optional(),
  R2_ACCOUNT_ID: secret.optional(),
  R2_ACCESS_KEY_ID: secret.optional(),
  R2_SECRET_ACCESS_KEY: secret.optional(),
  R2_BUCKET: z.string().trim().min(1).optional(),
  /** Overrides https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com (tests, S3-compatible stores). */
  R2_ENDPOINT: HttpUrl.optional(),
  /** The bucket's public domain, which every R2 asset URL starts with. */
  R2_PUBLIC_BASE_URL: HttpUrl.default(DEFAULT_R2_PUBLIC_BASE_URL),

  // ── Publishing ──
  PUBLISH_MODE: PublishMode.default("dry-run"),
  META_APP_ID: secret.optional(),
  META_APP_SECRET: secret.optional(),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default("v26.0"),
  META_GRAPH_BASE_URL: HttpUrl.default("https://graph.facebook.com"),
  TIKTOK_CLIENT_KEY: secret.optional(),
  TIKTOK_CLIENT_SECRET: secret.optional(),
  TIKTOK_API_BASE_URL: HttpUrl.default("https://open.tiktokapis.com"),
  /** Unaudited TikTok apps may only post SELF_ONLY. */
  TIKTOK_APP_AUDITED: bool(false),

  // ── Secrets and seed ──
  /** 32 random bytes as base64 (`openssl rand -base64 32`) or 64 hex chars; AES-256-GCM key. */
  TOKEN_ENC_KEY: z.string().trim().min(1).optional(),
  SEED_ADMIN_EMAIL: Email.optional(),
  SEED_ADMIN_PASSWORD: NewPassword.optional(),
  SEED_ADMIN_NAME: z.string().trim().min(1).max(120).optional(),
});

type Env = z.output<typeof EnvSchema>;

function decodeKey(value: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 ? bytes : null;
}

/** PIPELINE_ACTIONS de-duplicated in pipeline order, plus what is wrong with the combination. */
function resolvePipelineActions(listed: readonly PipelineAction[]) {
  const actions = orderPipelineActions(listed);
  const problems: string[] = [];
  const missing = REQUIRED_PIPELINE_ACTIONS.filter((action) => !actions.includes(action));
  if (missing.length > 0) {
    problems.push(`PIPELINE_ACTIONS must include ${missing.join(" and ")}`);
  }
  if (actions.includes("adapt") && !actions.includes("direct")) {
    problems.push(
      "PIPELINE_ACTIONS: adapt reframes the Visual Director's masters, so it needs direct",
    );
  }
  return { actions, problems };
}

/**
 * HIGGSFIELD_CREDENTIALS ("<id>:<secret>") or the HIGGSFIELD_KEY_ID + HIGGSFIELD_KEY_SECRET pair;
 * setting both forms would leave it unclear which key is live.
 */
function resolveHiggsfieldKeys(env: Env) {
  const problems: string[] = [];
  const pairSet = Boolean(env.HIGGSFIELD_KEY_ID ?? env.HIGGSFIELD_KEY_SECRET);
  if (env.HIGGSFIELD_CREDENTIALS && pairSet) {
    problems.push(
      "Set HIGGSFIELD_CREDENTIALS or HIGGSFIELD_KEY_ID + HIGGSFIELD_KEY_SECRET, not both",
    );
  }
  if (env.HIGGSFIELD_CREDENTIALS) {
    const [keyId, keySecret] = env.HIGGSFIELD_CREDENTIALS.split(":") as [string, string];
    return { keyId, keySecret, problems };
  }
  return {
    keyId: env.HIGGSFIELD_KEY_ID,
    keySecret: env.HIGGSFIELD_KEY_SECRET,
    problems,
  };
}

/** The AGENT_EFFORT_<AGENT> values that are set. */
function agentEffortOverrides(env: Env): Readonly<Partial<Record<AgentName, Effort>>> {
  const overrides: Partial<Record<AgentName, Effort>> = {};
  for (const agent of AgentName.options) {
    const effort = env[`AGENT_EFFORT_${agent}`];
    if (effort) overrides[agent] = effort;
  }
  return Object.freeze(overrides);
}

function resolveConfig(env: Env) {
  const problems: string[] = [];
  const isTest = env.NODE_ENV === "test";

  const pipeline = resolvePipelineActions(env.PIPELINE_ACTIONS);
  problems.push(...pipeline.problems);

  const llmProvider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "mock");
  if (llmProvider === "anthropic" && !env.ANTHROPIC_API_KEY) {
    problems.push("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
  }
  if (env.MOCK_LLM_FAULTS) {
    // createLlm never throws, so a typo would otherwise only surface on the first mock call.
    try {
      parseMockFaults(env.MOCK_LLM_FAULTS);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  const higgsfield = resolveHiggsfieldKeys(env);
  problems.push(...higgsfield.problems);
  if (env.VISUAL_PROVIDER === "higgsfield" && !(higgsfield.keyId && higgsfield.keySecret)) {
    problems.push(
      "VISUAL_PROVIDER=higgsfield requires HIGGSFIELD_CREDENTIALS (or HIGGSFIELD_KEY_ID and HIGGSFIELD_KEY_SECRET)",
    );
  }
  // Without an image model the provider renders no stills, and STATIC, STORY and CAROUSEL posts
  // are nothing but stills: every one of them would escalate. Video is optional (REEL and TIKTOK
  // shots fall back to stills).
  if (env.VISUAL_PROVIDER === "higgsfield" && !env.HIGGSFIELD_IMAGE_MODEL) {
    problems.push(
      "VISUAL_PROVIDER=higgsfield requires HIGGSFIELD_IMAGE_MODEL: every post type needs still images (HIGGSFIELD_VIDEO_MODEL is optional)",
    );
  }
  if (
    env.STORAGE_DRIVER === "r2" &&
    !(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET)
  ) {
    problems.push(
      "STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET",
    );
  }
  if (env.STORAGE_DRIVER === "r2" && env.PUBLIC_ASSET_BASE_URL) {
    problems.push(
      "PUBLIC_ASSET_BASE_URL only applies to STORAGE_DRIVER=local; R2 assets are served from R2_PUBLIC_BASE_URL",
    );
  }
  if (
    env.NODE_ENV === "production" &&
    env.STORAGE_DRIVER === "local" &&
    !env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION
  ) {
    problems.push(
      "STORAGE_DRIVER=local in production loses every asset on the next deploy (Render's disk is ephemeral) and Meta/TikTok can't fetch it; use r2, or set ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true on a durable disk",
    );
  }
  if (env.NODE_ENV === "production" && env.TRUST_PROXY === true) {
    problems.push(
      "TRUST_PROXY=true lets any client choose its IP; list the proxies instead (Render: loopback,uniquelocal,cloudflare)",
    );
  }
  if (Boolean(env.SEED_ADMIN_EMAIL) !== Boolean(env.SEED_ADMIN_PASSWORD)) {
    problems.push("Set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither");
  }

  const rawKey = env.TOKEN_ENC_KEY ?? (isTest ? TEST_TOKEN_ENC_KEY : undefined);
  const tokenEncKey = rawKey === undefined ? null : decodeKey(rawKey);
  if (rawKey === undefined) {
    problems.push("TOKEN_ENC_KEY is required (generate one with `openssl rand -base64 32`)");
  } else if (!tokenEncKey) {
    problems.push("TOKEN_ENC_KEY must be 32 bytes, as base64 or 64 hex characters");
  }

  if (problems.length > 0 || !tokenEncKey) {
    throw new ConfigError(`Invalid API configuration:\n  - ${problems.join("\n  - ")}`);
  }

  const apiPublicUrl = env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`;
  return Object.freeze({
    ...env,
    LOG_LEVEL: env.LOG_LEVEL ?? (isTest ? "silent" : "info"),
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === "production",
    BULLMQ_DRAIN_DELAY_SEC: env.BULLMQ_DRAIN_DELAY_SEC ?? (env.NODE_ENV === "production" ? 20 : 5),
    LLM_PROVIDER: llmProvider,
    /** In pipeline order, de-duplicated. */
    PIPELINE_ACTIONS: pipeline.actions,
    /** AGENT_EFFORT_<AGENT> overrides by agent; unset agents keep their definition's effort. */
    AGENT_EFFORT: agentEffortOverrides(env),
    API_PUBLIC_URL: apiPublicUrl,
    HIGGSFIELD_KEY_ID: higgsfield.keyId,
    HIGGSFIELD_KEY_SECRET: higgsfield.keySecret,
    PUBLIC_ASSET_BASE_URL: env.PUBLIC_ASSET_BASE_URL ?? `${apiPublicUrl}${LOCAL_FILES_PATH}`,
    /** Decoded 32-byte AES-256-GCM key. */
    TOKEN_ENC_KEY: tokenEncKey,
  });
}

export type Config = ReturnType<typeof resolveConfig>;
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Parses and validates the environment. Blank values count as unset (`KEY=` in a .env file). */
export function loadConfig(source: EnvSource = process.env): Config {
  const env = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid API configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return resolveConfig(parsed.data);
}

/** Which external integrations have credentials (GET /v1/capabilities). Never exposes values. */
export function configuredIntegrations(config: Config) {
  return {
    anthropic: Boolean(config.ANTHROPIC_API_KEY),
    meta: Boolean(config.META_APP_ID && config.META_APP_SECRET),
    tiktok: Boolean(config.TIKTOK_CLIENT_KEY && config.TIKTOK_CLIENT_SECRET),
    higgsfield: Boolean(config.HIGGSFIELD_KEY_ID && config.HIGGSFIELD_KEY_SECRET),
    r2: Boolean(
      config.R2_ACCOUNT_ID &&
      config.R2_ACCESS_KEY_ID &&
      config.R2_SECRET_ACCESS_KEY &&
      config.R2_BUCKET,
    ),
  };
}
