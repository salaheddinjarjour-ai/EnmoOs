# ENMO OS

**The autonomous marketing department behind Enmo** (internal platform, `app.enmo.marketing`).

ENMO OS takes over the repetitive 70% of content production: briefing, drafting, formatting,
scheduling and reporting. That leaves the team's hours for strategy and client relationships. Seven
Claude agents, **the Arsenal**, do the work. You chat a brief ("Ramadan campaign for the coffee
client, 12 posts, push the iced line"). The Manager asks one consolidated question and proposes a
plan. Once you approve the plan, the specialists write copy, direct visuals and adapt them for
Instagram, Facebook and TikTok. Every post goes through the client's approval chain, then publishes
at the best slot. After that, results are scored against the account's baseline, and what the
agents learn goes into the next brief.

- **Human-approved, always.** Nothing publishes without passing the configured approval chain. The
  only shortcut is a logged one-click "approve all".
- **Every client, one brain.** Brand voice, banned words, visual style and performance history are
  kept per client.
- **It gets smarter weekly.** Metrics come back from the platforms, every post is scored, and the
  learnings shape the next strategy call.

The team works in six screens: Command Center, The Brief (chat), Calendar, The Vault, Clients &
Admin, and the Approvals Queue. Roles are ADMIN, MANAGER and EDITOR. Clients never log in.

| Agent               | Job                                                                      |
| ------------------- | ------------------------------------------------------------------------ |
| **Manager**         | Clarifies the brief, emits the task graph, runs QA, routes approvals     |
| **Strategist**      | Goals → angles, pillars and hooks, informed by past learnings            |
| **Copywriter**      | Captions, scripts, on-screen text and CTAs, as strict JSON               |
| **Visual Director** | Shot lists and provider prompts; reviews renders, regenerates weak takes |
| **Adapter**         | One master asset → 9:16, 4:5, 1:1 and carousel frames                    |
| **Analyst**         | Weekly scoring against the baseline, and LearningLog takeaways           |
| **Publisher**       | Meta Graph and TikTok uploads at the best slots; confirms live URLs      |

Product spec: [`docs/MASTER_PLAN.md`](docs/MASTER_PLAN.md). Engineering design, phase plan and
version pins: [`docs/DESIGN.md`](docs/DESIGN.md).

## Status

The build goes one phase at a time, and each phase is verified against its exit criteria. Meta,
TikTok and Higgsfield are coded against their real APIs. Until credentials exist they run in
mock or dry-run mode.

| Phase              | Ships                                                                                                                                                                                  | Exit criteria                                          | Status   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------- |
| 1 · Foundation     | Monorepo, full Prisma schema, auth + RBAC, invites, client CRUD (brand voice, visual style, banned words, approval chain), Command Center shell, Render + Cloudflare deploy config, CI | Log in, create a client, see the dashboard             | **Done** |
| 2 · First words    | Brief chat, Manager intake/plan, task graph, BullMQ, Copywriter, approvals (text only)                                                                                                 | Brief → caption drafts → approve in the UI             | Planned  |
| 3 · Eyes           | Visual provider abstraction + MockProvider, Visual Director, Vault, asset versioning                                                                                                   | Brief → approvable post card with a placeholder visual | Planned  |
| 4 · Go live (Meta) | Meta Graph publishing, Publisher agent, Calendar + slot optimizer, Approvals Queue                                                                                                     | An approved post publishes itself to IG/FB             | Planned  |
| 5 · Everywhere     | TikTok publishing, Adapter agent, Higgsfield provider                                                                                                                                  | One brief → three platforms, in native formats         | Planned  |
| 6 · The loop       | Metrics pull, Analyst, LearningLog, Strategist, growth dashboard                                                                                                                       | Content visibly improves week over week                | Planned  |

Until live accounts are connected, Phase 6 can only show the loop closing on synthetic dry-run
metrics. Real improvement can only be measured with live accounts.

### Phase 1: what works today

- **Sign-in and sessions.** Email + password (argon2id). The API sets an httpOnly `enmo_session`
  cookie (SameSite=Lax; `Secure` and `Domain` from config) and stores only the token's sha256.
  Sessions roll forward while in use and expire after `SESSION_TTL_DAYS` idle. Sign-in is limited
  to 10 attempts per minute per IP and 5 per email. Every failure gets the same 401 and an audit
  row. Users can change their password, which signs out their other sessions.
- **Team and RBAC.** ADMIN, MANAGER and EDITOR follow the capability matrix in
  `packages/shared/src/rbac.ts`. Every API route declares its rule, and the API refuses to boot if
  one doesn't. The web app hides what a role can't do, but the API is what enforces it. ADMINs
  invite teammates with a one-time `/invite/<token>` link (7 days, no email is sent), change roles,
  and deactivate or reactivate accounts. Deactivating someone ends their sessions. Nobody can demote
  or deactivate themselves or the last active ADMIN. `GET /v1/audit` lists the audit trail.
- **Clients.** Create, edit and archive clients: name and slug, time zone, brand voice, visual
  style tokens (palette, typography, keywords, lighting, imagery, things to avoid, overlay
  placement), banned words, enabled platforms and the approval chain (1–5 steps, each with roles
  and/or named approvers and 1–3 approvals needed). The API refuses a chain with a step fewer
  active teammates can approve than it asks for (nobody decides a step twice, so it could never
  complete). Anyone who reads clients can list the team by name and role (`GET /v1/users/directory`)
  to pick or see named approvers. If a deactivation or role change later leaves a chain short, the
  change still goes through: the audit row lists the stalled chains, and the Team screen and the
  client's Approval chain tab flag them. ADMINs can connect social accounts by pasting a
  token. Tokens are stored AES-256-GCM encrypted (`TOKEN_ENC_KEY`) and never returned. "Check"
  confirms a token still decrypts and hasn't expired.
- **Web.** Login, invite accept, the Command Center shell (one tab per client over the "The Arsenal
  is idle. Give it a brief." empty state), the Clients roster and per-client settings tabs, and
  Admin → Users. The other four screens are labelled placeholders until their phases land.
- **Ops.** `GET /healthz` (liveness) and `/readyz` (Postgres + Redis). `render.yaml` defines the
  API, the worker and Postgres. `wrangler.jsonc` and `worker.ts` define the Cloudflare Worker with
  its keep-alive cron. CI runs lint, typecheck, test, build, `build:cf`, the smoke test and
  Playwright.

**Mocked, dry-run or not there yet in Phase 1.**

- No agent runs yet. The worker process starts idle, and queues arrive in Phase 2.
  `LLM_PROVIDER=mock`, `VISUAL_PROVIDER=mock` and `PUBLISH_MODE=dry-run` are the defaults, and the
  Topbar shows them as chips.
- Social accounts are connected only by pasting a token. Meta and TikTok OAuth arrive in Phases 4
  and 5. "Check" can't ask the platform yet, so it only verifies decryption and expiry.
- Nothing has been deployed: there are no Render, Cloudflare, Upstash or R2 credentials. The deploy
  config builds (`build:cf`, `turbo build`, and `smoke-api` boots the bundle) but hasn't been run
  against real accounts.
- The login limit counters are kept in memory by each API process. That's correct for the single
  `enmo-api` instance in `render.yaml`. If the API is ever scaled out, give `@fastify/rate-limit`
  the Redis client (`apps/api/src/plugins/security.ts`).

## Architecture

```
            Team browser
                 │  HTTPS · cookie enmo_session (Domain=.enmo.marketing, SameSite=Lax)
                 ▼
 ┌─────────────────────────────────────┐
 │ app.enmo.marketing                  │   Cloudflare Worker (OpenNext)
 │ apps/web · Next.js 16 App Router    │   cron */5 → GET api.enmo.marketing/healthz
 └─────────────────────────────────────┘
                 │  fetch(credentials: "include") · SSE GET /v1/events
                 ▼
 ┌─────────────────────────────────────┐          ┌──────────────────────────┐
 │ api.enmo.marketing                  │   SQL    │ enmo-db                  │
 │ enmo-api · apps/api dist/server.js  │─────────▶│ Render Postgres 16       │
 │ Fastify /v1 · auth · RBAC · SSE hub │          └──────────────────────────┘
 └─────────────────────────────────────┘                        ▲
     │ enqueue jobs       ▲ SUBSCRIBE enmo:rt                   │ SQL
     ▼                    │                                     │
 ┌─────────────────────────────────────┐          ┌─────────────┴────────────┐
 │ Upstash Redis (TLS, noeviction)     │   jobs   │ enmo-worker              │
 │ BullMQ: agents · media · ops queues │◀────────▶│ apps/api dist/worker.js  │
 │ realtime pub/sub (enmo:rt)          │          │ consumers + schedulers   │
 └─────────────────────────────────────┘          └─────────────┬────────────┘
                                                                │
              ┌─────────────────────┬───────────────────────────┼───────────────────────┐
              ▼                     ▼                           ▼                       ▼
        Anthropic API          Higgsfield              Meta Graph · TikTok        Cloudflare R2
        (the Arsenal)           (visuals)              (publish, metrics)     assets.enmo.marketing
```

- **One API package, two entrypoints.** `server.ts` serves HTTP and SSE, and `worker.ts` runs the
  queue consumers and schedulers. With `EMBEDDED_WORKER=true` (dev, Render free tier) one process
  runs both.
- **The web app is a thin client.** It never imports `@enmo/db`, `@enmo/agents` or
  `@enmo/providers` (ESLint enforces this). It shares types with the API only through
  `@enmo/shared`.
- **Realtime.** The worker writes a `RealtimeEvent` row, then publishes it on Redis. The API fans
  it out to SSE clients, and `Last-Event-ID` replays missed events from the table.
- **Every external call has a deterministic mock.** Those are `LLM_PROVIDER=mock`,
  `VISUAL_PROVIDER=mock` and `PUBLISH_MODE=dry-run`, so the whole pipeline runs in tests and CI
  without credentials.

## Monorepo map

```
apps/
  api/          @enmo/api     Fastify API + BullMQ worker (tsup bundle: server, worker, create-admin)
    src/        config.ts (all env), app.ts, deps.ts, plugins/, routes/, services/, jobs/, lib/
    test/       integration (real Postgres + Redis, app.inject), helpers
  web/          @enmo/web     Next.js 16 → Cloudflare Workers via @opennextjs/cloudflare
    src/        app/ (routes), components/, hooks/ (TanStack Query), lib/ (api client, auth)
    e2e/        Playwright specs, phase1.spec.ts …
    worker.ts   Worker entry: OpenNext handler + keep-alive cron
packages/
  shared/       @enmo/shared  zod enums + DTOs, RBAC matrix, approval-chain walk, status maps (no Node deps)
  db/           @enmo/db      Prisma 7 schema + migrations, createPrisma(), seed, test helpers
  agents/       (Phase 2)     agent runner, Anthropic + MockLlm clients, prompts, definitions
  providers/    (Phase 3+)    visual providers, storage (local / R2), imaging, publishers, OAuth, metrics
scripts/
  services.sh   local Postgres :54329 + Redis :63799 (up | down | status | env | createdb <name>)
  smoke-api.mjs boots the built API and checks /healthz, /readyz and a clean shutdown
docs/           MASTER_PLAN.md (product spec), DESIGN.md (engineering design)
render.yaml     Render Blueprint: enmo-api, enmo-worker, enmo-db, env group enmo-shared
docker-compose.dev.yml   Postgres 16 + Redis 7 for machines without native binaries
.github/workflows/ci.yml verify (lint → test → build → build:cf → smoke) and web-e2e (Playwright)
```

Internal packages are TypeScript source (`exports: ./src/index.ts`, ESM). tsup bundles them into
the API. The web app compiles `@enmo/shared` with `transpilePackages`.

## Local quickstart

You need Node 22.22.2 (see `.node-version`) and pnpm 10.33 (`corepack enable` provides it from
`package.json`). Use pnpm only. You also need Postgres 16 and Redis 7: either native binaries or
Docker.

```sh
corepack enable
pnpm install

# Postgres 16 on 127.0.0.1:54329 (databases enmo_dev + enmo_test) and Redis on 127.0.0.1:63799.
# Uses /usr/lib/postgresql/16/bin + redis-server when present, docker-compose.dev.yml otherwise.
scripts/services.sh up
eval "$(scripts/services.sh env)"   # exports DATABASE_URL, TEST_DATABASE_URL, REDIS_URL

# Local config files (all gitignored).
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cp packages/db/.env.example packages/db/.env
```

Edit `apps/api/.env`:

- `TOKEN_ENC_KEY`: paste the output of `openssl rand -base64 32`. The API refuses to start
  without it.
- `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (12+ characters): this first ADMIN is created on
  boot while the users table is empty.

Then migrate and run:

```sh
pnpm db:generate                    # prisma generate (turbo also does this before dev/build)
pnpm --filter @enmo/db db:deploy    # apply migrations to enmo_dev
pnpm dev                            # API :4000 (embedded worker, mock LLM) + web :3000
```

Open <http://localhost:3000> and sign in with the seed admin. The Command Center greets you with
"The Arsenal is idle. Give it a brief." Go to **Clients → New client** to set up a brand.

There are two other ways to create users:

- `pnpm --filter @enmo/api create-admin --email you@enmo.marketing --password '…' [--name …]`
  adds an ADMIN at any time.
- `pnpm db:seed` uses `SEED_ADMIN_*` from `packages/db/.env`. With `SEED_DEMO=true` it also creates
  the demo client "Qahwa Co".

Everyone else joins by invite. An ADMIN creates it under **Admin → Users** and shares the one-time
`/invite/<token>` link, which expires after 7 days. No email is sent.

`pnpm dev` runs under turbo, which passes only declared variables through to tasks. So put API
settings in `apps/api/.env` and web settings in `apps/web/.env.local`, not in your shell.
`scripts/services.sh down` stops the local services.

## Testing

```sh
eval "$(scripts/services.sh env)"                  # the suites need Postgres + Redis

pnpm turbo run lint typecheck
pnpm turbo run test                                # every package: unit + integration
pnpm --filter @enmo/api test:unit                  # no services needed
pnpm --filter @enmo/api test:integration           # app.inject against enmo_test, truncated per test
pnpm --filter @enmo/shared test
pnpm --filter @enmo/web test                       # web unit tests (pure modules, e.g. safe redirects)
pnpm --filter @enmo/db test                        # schema drift + seed, in enmo_test_dbpkg (needs services)

pnpm --filter @enmo/web test:e2e                   # Playwright, all specs
pnpm --filter @enmo/web test:e2e -- phase1         # one phase

pnpm --filter @enmo/api build && node scripts/smoke-api.mjs   # boot the bundle: /healthz, /readyz
pnpm --filter @enmo/web build:cf                   # OpenNext build for Cloudflare Workers
pnpm format:check
```

- **Test databases.** Integration tests use `TEST_DATABASE_URL` (default: local `enmo_test`). They
  run `prisma migrate deploy` once, then truncate every table before each test. They refuse any
  database whose name lacks `test` or `e2e`. `@enmo/db` uses its own `enmo_test_dbpkg`, so both
  suites can run in parallel under turbo.
- **Playwright.** The config starts the API from source on port 4100 (tsx, embedded worker, mock
  LLM, dry-run publishing) against a fresh `enmo_e2e` database. It starts the web app on port 3100
  with `next build && next start`. Every run starts its own servers: if port 4100 or 3100 is
  already taken, Playwright stops instead of reusing a server with stale rows and a spent sign-in
  budget. The specs are serial stories over one database, so they are never retried. Locally,
  browsers come from `PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers` when present). Only CI runs
  `playwright install`.
- **Smoke test.** `scripts/smoke-api.mjs` boots `apps/api/dist/server.js` exactly as Render does,
  on a random port, with a fixed mock/dry-run environment. It waits up to 30 s for `/healthz` and
  then `/readyz`, sends SIGTERM, and expects exit code 0. tsup keeps npm dependencies external, so
  this catches a runtime dependency missing from `apps/api/package.json`. It reads
  `SMOKE_DATABASE_URL`, then `TEST_DATABASE_URL`, then `DATABASE_URL`. `SMOKE_TIMEOUT_MS` changes
  the wait.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request. It uses Postgres 16 and
Redis 7 service containers, and the mock/dry-run environment above.

- `verify` runs install → lint + typecheck → `format:check` → `migrate deploy` on the test
  database → `turbo test` → `turbo build` → `build:cf` → `smoke-api`.
- `web-e2e` runs once `verify` passes. It installs Chromium and runs Playwright, and uploads the
  report if anything fails.

## Environment variables

Everything the API reads is parsed and validated once, in
[`apps/api/src/config.ts`](apps/api/src/config.ts). Blank values count as unset. An invalid
combination stops the process at boot with a list of the problems, for example
`LLM_PROVIDER=anthropic` without a key. Locally the values live in `apps/api/.env` (see
[`apps/api/.env.example`](apps/api/.env.example)). On Render they come from `render.yaml` and the
`enmo-secrets` group.

### API (`apps/api`)

**Server**

| Variable           | Default                            | Purpose                                                                                                                                                           |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`         | `development`                      | `development`, `test` or `production`. `production` makes `COOKIE_SECURE` default to true. `test` lets a built-in key stand in for `TOKEN_ENC_KEY`.               |
| `LOG_LEVEL`        | `info` (`silent` under test)       | pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.                                                                                         |
| `HOST`             | `0.0.0.0`                          | Bind address.                                                                                                                                                     |
| `PORT`             | `4000`                             | HTTP port. Render injects its own.                                                                                                                                |
| `API_PUBLIC_URL`   | `http://localhost:$PORT`           | Public base URL of the API, used for OAuth callbacks and local file URLs. Production: `https://api.enmo.marketing`.                                               |
| `TRUST_PROXY`      | `false`                            | Proxies to believe about the client IP, so rate limits and audit rows see client IPs. Render: `loopback,uniquelocal,cloudflare` (see _Client IPs_). Never `true`. |
| `APP_ORIGINS`      | `http://localhost:3000`            | Comma-separated exact origins (no path, no trailing slash) for CORS and the CSRF origin check. The first one is the web app.                                      |
| `COOKIE_DOMAIN`    | unset (host-only cookie)           | Session cookie domain. Production: `.enmo.marketing`.                                                                                                             |
| `COOKIE_SECURE`    | `true` in production, else `false` | `Secure` flag on the `enmo_session` cookie.                                                                                                                       |
| `SESSION_TTL_DAYS` | `30`                               | Session lifetime. Sessions roll forward while in use.                                                                                                             |

**Data**

| Variable                 | Default                                          | Purpose                                                                                                           |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | `postgresql://postgres@127.0.0.1:54329/enmo_dev` | Postgres connection string. On Render it comes from `enmo-db`.                                                    |
| `REDIS_URL`              | `redis://127.0.0.1:63799`                        | Redis for BullMQ, realtime pub/sub and OAuth state. `rediss://` enables TLS (Upstash).                            |
| `BULLMQ_PREFIX`          | `enmo`                                           | Key prefix for every queue. Tests use a unique one.                                                               |
| `BULLMQ_DRAIN_DELAY_SEC` | `5`                                              | Seconds an idle worker blocks waiting for jobs. Production uses `20`, which keeps Upstash command costs down.     |
| `EMBEDDED_WORKER`        | `false`                                          | Run the queue consumers inside the API process. `pnpm dev` and the Render free tier set it to `true`.             |
| `SCHEDULERS_ENABLED`     | `true`                                           | Register the repeatable ticks (publish, metrics, tokens, analyst, sweeper, prune). Tests call the ticks directly. |

**LLM**

| Variable                  | Default                                                | Purpose                                                                                                                              |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM_PROVIDER`            | `anthropic` if `ANTHROPIC_API_KEY` is set, else `mock` | `anthropic` or `mock` (deterministic MockLlm).                                                                                       |
| `ANTHROPIC_API_KEY`       | none                                                   | Anthropic API key. Required when `LLM_PROVIDER=anthropic`.                                                                           |
| `ENMO_ANTHROPIC_BASE_URL` | `https://api.anthropic.com`                            | Anthropic API base URL. It is deliberately not `ANTHROPIC_BASE_URL`, so a developer shell's value is never picked up.                |
| `ANTHROPIC_MODEL`         | `claude-sonnet-5`                                      | Model used by every agent.                                                                                                           |
| `DAILY_TOKEN_CAP`         | `2000000`                                              | Input + output token budget per UTC day. Once it is reached, tasks wait as `BLOCKED_BUDGET`.                                         |
| `AGENT_CONCURRENCY`       | `4`                                                    | Concurrency of the `agents` queue (LLM work).                                                                                        |
| `MEDIA_CONCURRENCY`       | `4`                                                    | Concurrency of the `media` queue (renders, adapting).                                                                                |
| `PIPELINE_ACTIONS`        | `write,qa`                                             | Comma list of per-post actions the Manager may plan, from `strategy`, `write`, `direct`, `adapt` and `qa`. It widens phase by phase. |
| `MOCK_LLM_FAULTS`         | none                                                   | MockLlm fault injection for tests, e.g. `COPYWRITER.write:invalid*2,VISUAL_DIRECTOR.review:weak*3`.                                  |

**Visuals**

| Variable                 | Default                     | Purpose                                                                                      |
| ------------------------ | --------------------------- | -------------------------------------------------------------------------------------------- |
| `VISUAL_PROVIDER`        | `mock`                      | `mock` (sharp-rendered branded placeholders) or `higgsfield`.                                |
| `HIGGSFIELD_KEY_ID`      | none                        | Higgsfield credentials. Both this and `HIGGSFIELD_KEY_SECRET` are required for `higgsfield`. |
| `HIGGSFIELD_KEY_SECRET`  | none                        | See above.                                                                                   |
| `HIGGSFIELD_BASE_URL`    | `https://api.higgsfield.ai` | API base URL. Tests override it with a fake server.                                          |
| `HIGGSFIELD_IMAGE_MODEL` | none                        | Higgsfield model id for stills.                                                              |
| `HIGGSFIELD_VIDEO_MODEL` | none                        | Higgsfield model id for video.                                                               |
| `FFMPEG_PATH`            | none                        | Enables multi-scene video assembly. Without it, the first clip is used.                      |

**Storage**

| Variable                | Default                                                                    | Purpose                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`        | `local`                                                                    | `local` (disk, served at `/v1/files/*`) or `r2`. Production needs `r2`: Render's disk is ephemeral, and Meta and TikTok fetch media by public URL. |
| `STORAGE_LOCAL_DIR`     | `.data/storage`                                                            | Directory for the local driver, relative to the API's working directory.                                                                           |
| `PUBLIC_ASSET_BASE_URL` | `$API_PUBLIC_URL/v1/files` (local) or `https://assets.enmo.marketing` (r2) | Public base URL of stored assets.                                                                                                                  |
| `R2_ACCOUNT_ID`         | none                                                                       | Cloudflare account id. All four `R2_*` credentials are required for `r2`.                                                                          |
| `R2_ACCESS_KEY_ID`      | none                                                                       | R2 API token access key.                                                                                                                           |
| `R2_SECRET_ACCESS_KEY`  | none                                                                       | R2 API token secret.                                                                                                                               |
| `R2_BUCKET`             | none                                                                       | Bucket name. Production: `enmo-assets`.                                                                                                            |
| `R2_ENDPOINT`           | `https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com`                          | Override for tests or another S3-compatible store.                                                                                                 |

**Publishing**

| Variable               | Default                       | Purpose                                                                                                 |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PUBLISH_MODE`         | `dry-run`                     | `dry-run` validates payloads and returns `https://dryrun.enmo.marketing/...` URLs. `live` really posts. |
| `META_APP_ID`          | none                          | Meta app id (OAuth, Graph API).                                                                         |
| `META_APP_SECRET`      | none                          | Meta app secret.                                                                                        |
| `META_GRAPH_VERSION`   | `v26.0`                       | Graph API version.                                                                                      |
| `META_GRAPH_BASE_URL`  | `https://graph.facebook.com`  | Graph base URL. Tests point it at a fake Graph server.                                                  |
| `TIKTOK_CLIENT_KEY`    | none                          | TikTok app client key.                                                                                  |
| `TIKTOK_CLIENT_SECRET` | none                          | TikTok app client secret.                                                                               |
| `TIKTOK_API_BASE_URL`  | `https://open.tiktokapis.com` | TikTok API base URL.                                                                                    |
| `TIKTOK_APP_AUDITED`   | `false`                       | Unaudited TikTok apps may only post `SELF_ONLY`. Set `true` once the audit passes.                      |

**Secrets and seed**

| Variable              | Default                           | Purpose                                                                                                                                                                    |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_ENC_KEY`       | none (**required** outside tests) | AES-256-GCM key for social tokens: 32 bytes as base64 (`openssl rand -base64 32`) or 64 hex characters. Back it up. If you lose or change it, stored tokens can't be read. |
| `SEED_ADMIN_EMAIL`    | none                              | First ADMIN, created on boot only while the users table is empty. Set it together with `SEED_ADMIN_PASSWORD`.                                                              |
| `SEED_ADMIN_PASSWORD` | none                              | 12+ characters. Changing it later never resets an existing password.                                                                                                       |
| `SEED_ADMIN_NAME`     | none                              | Optional display name for the seed admin.                                                                                                                                  |

### Web (`apps/web`)

| Variable              | Default                              | Purpose                                                                                                                                                                |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000`              | API base URL, **inlined at build time**. Production builds default to `https://api.enmo.marketing` (`apps/web/.env.production`); the environment or `.env.local` wins. |
| `KEEPALIVE_URL`       | `https://api.enmo.marketing/healthz` | Worker var in `wrangler.jsonc`. The every-5-minutes cron pings it.                                                                                                     |

### Database package (`packages/db`)

| Variable                                                     | Default | Purpose                                                         |
| ------------------------------------------------------------ | ------- | --------------------------------------------------------------- |
| `DATABASE_URL`                                               | none    | Used by the Prisma CLI (`prisma.config.ts`) and `pnpm db:seed`. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | none    | First ADMIN for `pnpm db:seed`.                                 |
| `SEED_DEMO`                                                  | `false` | `true` also seeds the demo client "Qahwa Co".                   |

### Tooling

| Variable                                       | Default                                                         | Purpose                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TEST_DATABASE_URL`                            | `postgresql://postgres@127.0.0.1:54329/enmo_test`               | Database for the integration suites. The `@enmo/db` suites and Playwright (`enmo_e2e`) use it as their base. |
| `E2E_DATABASE_URL`                             | `enmo_e2e` next to `TEST_DATABASE_URL`                          | Database for the Playwright API server.                                                                      |
| `PLAYWRIGHT_BROWSERS_PATH`                     | `/opt/pw-browsers` when present                                 | Preinstalled Chromium for local Playwright runs.                                                             |
| `SMOKE_DATABASE_URL`, `SMOKE_TIMEOUT_MS`       | see [Testing](#testing)                                         | Overrides for `scripts/smoke-api.mjs`.                                                                       |
| `ENMO_PG_BIN`, `ENMO_PG_DIR`, `ENMO_REDIS_DIR` | `/usr/lib/postgresql/16/bin`, `/tmp/enmo-pg`, `/tmp/enmo-redis` | Overrides for `scripts/services.sh`.                                                                         |

## Deploy

Production has three pieces, and all of them serve from subdomains of `enmo.marketing`:

- **The API and worker run on Render.** `render.yaml` defines `enmo-api`, `enmo-worker` and the
  `enmo-db` Postgres 16.
- **Redis is on Upstash.**
- **The web app runs on Cloudflare Workers through OpenNext.** Media lives in Cloudflare R2.

Nothing deploys automatically from this repository until those accounts exist. Once they do,
Render redeploys each commit after CI passes (`autoDeployTrigger: checksPass`).

**DNS and cookies.** Keep the `enmo.marketing` zone on Cloudflare DNS.

| Host                    | Points to                               | Created by                                                      |
| ----------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `app.enmo.marketing`    | Worker `enmo-web` (custom domain)       | `wrangler deploy` (`routes` in `apps/web/wrangler.jsonc`)       |
| `api.enmo.marketing`    | `CNAME enmo-api.onrender.com`           | You, after Render lists the domain (`domains` in `render.yaml`) |
| `assets.enmo.marketing` | R2 bucket `enmo-assets` (custom domain) | R2 → bucket → Settings → Custom Domains                         |

The API sets `enmo_session` as `HttpOnly; Secure; SameSite=Lax; Domain=.enmo.marketing`.
`app.` and `api.` are the same _site_, so the browser sends that cookie with the web app's
credentialed `fetch` and `EventSource` calls. The default hostnames (`*.onrender.com` and
`*.workers.dev`) are different sites, and there the cookie would be dropped. So always put both
behind `enmo.marketing`. `APP_ORIGINS` must be exactly `https://app.enmo.marketing`.

For `api.`, start with the record **DNS only** (grey cloud) until Render has issued its
certificate. If you proxy it afterwards, use SSL mode _Full (strict)_. The 15 s SSE heartbeat keeps
streams alive through the Cloudflare proxy.

**Client IPs.** Requests reach the API as `X-Forwarded-For: <client>, <Cloudflare edge>, <Render
10.x hop>` with `CF-Connecting-IP: <client>`, and one more Cloudflare entry once `api.` is proxied.
`TRUST_PROXY=loopback,uniquelocal,cloudflare` trusts two things. Render's own hops are trusted for
`X-Forwarded-For`. A Cloudflare edge is trusted only for `CF-Connecting-IP`, which Cloudflare
overwrites. Cloudflare addresses are never skipped in `X-Forwarded-For`: any Cloudflare customer's
Worker sends from them with a header it wrote itself, so trusting them would let anyone pick their
IP. Traffic from other people's Workers therefore shares one address. Don't switch to a hop count:
`1` would make every visitor share one Render or Cloudflare address, so the per-IP sign-in limit
would lock out whole offices and session and audit IPs would be useless. `true` is refused in
production. After the first deploy (and after changing the cloud colour), sign in and check that
`remoteAddress` in the API's request log is your own public IP. If it shows a `10.x` address, a
Render hop is missing from `TRUST_PROXY`. If it shows a Cloudflare address, `cloudflare` is missing
or `CF-Connecting-IP` is not reaching the API.

### 1. Upstash Redis

1. Create a Redis database in **eu-central-1 (Frankfurt)**, the same region as the Render services.
2. Keep TLS on and **turn eviction off**. BullMQ requires `noeviction`, and evicted keys mean lost
   jobs.
3. Copy the `rediss://default:<password>@<host>.upstash.io:6379` URL. It goes into `REDIS_URL`.
4. Pick a pay-as-you-go or fixed plan. Idle BullMQ workers poll continuously, which is why
   production sets `BULLMQ_DRAIN_DELAY_SEC=20`, and that polling can exhaust a free tier's monthly
   command quota.

### 2. Cloudflare R2

1. Create the bucket **`enmo-assets`**. That's the `R2_BUCKET` value in `render.yaml`.
2. Under bucket → Settings → Custom Domains, connect **`assets.enmo.marketing`**. Meta and TikTok
   download media from these public URLs.
3. Create an R2 API token with _Object Read & Write_ access, scoped to that bucket. It gives you
   `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. `R2_ACCOUNT_ID` is on the R2 overview page.

### 3. Render (API, worker, Postgres)

1. **Create the `enmo-secrets` environment group first** (Dashboard → Environment Groups → New).
   A group defined in `render.yaml` can't prompt for values (`sync: false`), and any value written
   there would be committed to git. So this group lives only in the Dashboard, and both services
   attach it with `fromGroup: enmo-secrets`. Paste the following, keeping comments on their own
   lines so none ends up inside a value:

   ```sh
   REDIS_URL=rediss://default:…@….upstash.io:6379
   # openssl rand -base64 32. Store a copy in your password manager.
   TOKEN_ENC_KEY=…
   ANTHROPIC_API_KEY=sk-ant-…
   R2_ACCOUNT_ID=…
   R2_ACCESS_KEY_ID=…
   R2_SECRET_ACCESS_KEY=…
   # Optional, first boot only (remove afterwards). The password needs 12+ characters.
   SEED_ADMIN_EMAIL=you@enmo.marketing
   SEED_ADMIN_PASSWORD=…
   ```

   Later phases add `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`,
   `HIGGSFIELD_KEY_ID`, `HIGGSFIELD_KEY_SECRET`, `HIGGSFIELD_IMAGE_MODEL` and
   `HIGGSFIELD_VIDEO_MODEL` to this group. The services refuse to boot without `TOKEN_ENC_KEY`,
   without the Anthropic key (because `LLM_PROVIDER=anthropic`), and without the R2 credentials
   (because `STORAGE_DRIVER=r2`).

2. **Apply the Blueprint.** Go to Blueprints → New Blueprint Instance and pick this repository.
   Render reads `render.yaml` and creates:
   - the env group `enmo-shared`, holding non-secret shared settings: `NODE_ENV=production`,
     `LLM_PROVIDER=anthropic`, `ANTHROPIC_MODEL=claude-sonnet-5`, `DAILY_TOKEN_CAP`,
     `PUBLISH_MODE=dry-run`, `VISUAL_PROVIDER=mock`, `STORAGE_DRIVER=r2` and so on
   - the database `enmo-db` (Postgres 16, `basic-256mb`, private network only). Each service gets
     `DATABASE_URL` from it.
   - the web service **`enmo-api`**:
     - build: `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm turbo run build --filter=@enmo/api...`
     - pre-deploy: `pnpm --filter @enmo/db db:deploy` (`prisma migrate deploy`)
     - start: `node --enable-source-maps apps/api/dist/server.js`
     - health check `/healthz`
     - `EMBEDDED_WORKER=false`, `APP_ORIGINS=https://app.enmo.marketing`,
       `COOKIE_DOMAIN=.enmo.marketing`, `COOKIE_SECURE=true`,
       `TRUST_PROXY=loopback,uniquelocal,cloudflare`
     - domain `api.enmo.marketing`
   - the background worker **`enmo-worker`**. It uses the same build and starts with
     `node --enable-source-maps apps/api/dist/worker.js`.

   Everything runs in `frankfurt`. A database's region cannot change after creation.

3. **DNS.** Add `CNAME api → enmo-api.onrender.com` in Cloudflare, then wait for Render to verify
   the domain.

4. **First admin.** Use one of these:
   - `SEED_ADMIN_*` in `enmo-secrets`. The admin is created on the first boot against an empty
     database. Remove the variables afterwards.
   - From the `enmo-api` Shell: `node apps/api/dist/create-admin.js --email … --password …`.

5. **Check.** `curl https://api.enmo.marketing/readyz` should return
   `{"status":"ok","checks":{"database":true,"redis":true}}`.

**Free-tier fallback.** Free instances get neither background workers nor pre-deploy commands.
The top of `render.yaml` spells out the changes:

1. Delete `enmo-worker`.
2. On `enmo-api`, set `plan: free` and `EMBEDDED_WORKER=true`, and move `prisma migrate deploy`
   into the start command.
3. Put `enmo-db` on the free plan. Render deletes free databases after 30 days.

A free instance sleeps after 15 idle minutes. The web Worker's cron pings `/healthz` every 5
minutes to keep it awake.

### 4. Cloudflare Workers (web)

`apps/web/wrangler.jsonc` sets up the Worker `enmo-web`:

- entry `worker.ts`, which is the OpenNext handler plus a keep-alive cron
- the flags `nodejs_compat` and `global_fetch_strictly_public`
- static assets from `.open-next/assets`
- the custom domain `app.enmo.marketing`
- the cron `*/5 * * * *`, which pings `KEEPALIVE_URL`

Deploy from a machine or CI job that has a Cloudflare API token. Create the token from the _Edit
Cloudflare Workers_ template, with the `enmo.marketing` zone included:

```sh
export CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…
NEXT_PUBLIC_API_URL=https://api.enmo.marketing pnpm --filter @enmo/web run deploy
```

- Write `run deploy`: plain `pnpm deploy` is a built-in pnpm command, not the package script.
- `NEXT_PUBLIC_API_URL` is compiled into the client bundle. Changing the API URL needs a rebuild,
  not a Worker variable. Production builds fall back to `https://api.enmo.marketing` from
  `apps/web/.env.production`, so a deploy without it can't ship a bundle that calls localhost.
  For a local production build (`next start`, `preview`) against a local API, keep
  `NEXT_PUBLIC_API_URL=http://localhost:4000` in `apps/web/.env.local`.
- `pnpm --filter @enmo/web run preview` builds the Worker and serves it locally in workerd.
- The app uses no middleware and no image optimisation (`images.unoptimized`), because OpenNext on
  Workers supports neither Node middleware nor the Next image optimiser.

## Credentials needed later

None of these block development: mocks and dry-run cover every integration. Put each one in the
Render `enmo-secrets` group when it arrives.

| Credential                                        | Unlocks                                            | Notes                                                                           |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                               | The real Arsenal (`LLM_PROVIDER=anthropic`)        | Required by the production config from day one. `DAILY_TOKEN_CAP` bounds spend. |
| Upstash `REDIS_URL`                               | Queues, realtime and OAuth state in production     | Eviction **off**.                                                               |
| `TOKEN_ENC_KEY`                                   | Encrypted social tokens                            | Generate once and back it up.                                                   |
| Cloudflare R2 keys + `assets.enmo.marketing`      | Production media storage and public media URLs     | Also needed before Meta or TikTok can pull media.                               |
| Meta app id + secret, **App Review**              | Phase 4 publishing to Instagram and Facebook       | See the Meta details below.                                                     |
| TikTok client key + secret, **app audit**         | Phase 5 publishing to TikTok                       | See the TikTok details below.                                                   |
| Higgsfield key id + secret, image/video model ids | Real renders (`VISUAL_PROVIDER=higgsfield`)        | The swap is one provider file. The pipeline already runs on MockProvider.       |
| Cloudflare API token                              | Web deploys (`pnpm --filter @enmo/web run deploy`) | _Edit Cloudflare Workers_ template plus the `enmo.marketing` zone.              |

**Meta.**

- App Review must approve `instagram_content_publish` and `pages_manage_posts`.
- The app also uses `pages_show_list`, `pages_read_engagement`, `instagram_basic`,
  `instagram_manage_insights`, `read_insights` and `business_management`.
- Redirect URI: `https://api.enmo.marketing/v1/oauth/meta/callback`.
- Start the review during Phase 3, because it takes days.

**TikTok.**

- Uses the Content Posting API.
- An unaudited app can only post `SELF_ONLY`. Set `TIKTOK_APP_AUDITED=true` once the audit passes.
- Redirect URI: `https://api.enmo.marketing/v1/oauth/tiktok/callback`.
- Verify `assets.enmo.marketing` as a URL prefix for `PULL_FROM_URL` uploads.

## Contributing

**Toolchain.**

- Node 22.22.2 and pnpm 10.33.0. Use pnpm only: no npm or yarn lockfiles.
- The versions pinned in [DESIGN §J](docs/DESIGN.md#j-full-pin-table) are deliberate. Don't bump
  them to `latest`:
  - TypeScript 7 is the Go port.
  - ESLint 10 breaks `eslint-config-next`.
  - Prisma 8 is a release candidate.
  - `@playwright/test` must match the preinstalled Chromium.
- New dependency builds must be allowed in `pnpm-workspace.yaml` (`allowBuilds`).

**Code.**

- TypeScript strict, ESM, small cohesive modules. Comments explain _why_, not _what_.
- Validate with zod at every boundary: env (`config.ts`), request bodies, and responses. The API
  encodes every response through its schema, so send timestamps as ISO strings.
- Shared shapes (enums, DTOs, RBAC, approval chain, status maps) live in `@enmo/shared`, which has
  no Node dependencies.
- Every non-2xx response is `{ "error": { "code", "message", "details"? } }`.
- Each API route declares its capability (`requireCap`). The web app uses the same matrix to hide
  controls, but hiding a control is never the enforcement.

**Adding things.**

- **A new env var** goes in `apps/api/src/config.ts`, `apps/api/.env.example` and the table above.
  If production needs it, it also goes in `render.yaml` (`enmo-shared`, or `enmo-secrets` in the
  Dashboard).
- **A new API runtime dependency** goes in `apps/api/package.json`. tsup bundles only `@enmo/*`,
  and `scripts/smoke-api.mjs` fails when a dependency is missing.
- **A schema change**: edit `packages/db/prisma/schema.prisma`, then run `pnpm db:migrate`
  (`prisma migrate dev`) to create a migration and commit it. Never edit an applied migration.
  Deploys and CI run `migrate deploy`.

**Before you push.** Run `pnpm turbo run lint typecheck test` and `pnpm format:check`. For anything
touching the API bundle or the web build, also run `node scripts/smoke-api.mjs` and
`pnpm --filter @enmo/web build:cf`.

**Parallel work.** Phase work is split into units that own disjoint files, listed in
[DESIGN §I](docs/DESIGN.md#i-parallel-unit-file-ownership-step-b). The shared files
(`schema.prisma`, `package.json` files, the lockfile, `packages/shared/src/index.ts`,
`routes/index.ts`, `jobs/registry.ts`, `deps.ts`, the Sidebar) change only in a phase's
integration step.
