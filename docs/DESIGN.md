# ENMO OS — Design & Build Reference

## Context
The user uploaded `ENMO-OS-Master-Plan.docx`. It describes ENMO OS, an internal "autonomous marketing department" for the Enmo agency (app.enmo.marketing). Seven Claude agents (the Arsenal) take a chat brief, draft copy and visuals, send them through an internal approval chain, publish to Instagram, Facebook and TikTok, then score the results and feed what they learn into the next brief.
The repo `salaheddinjarjour-ai/EnmoOs` is empty (branch `claude/new-session-cwfhi7`, no commits). This plan builds the product from scratch, following the doc's six-phase roadmap.

**User decisions (fixed)**
- Scope: all six phases. Work goes one phase at a time, with **one commit per phase, pushed** to `claude/new-session-cwfhi7`. Each phase is verified against its exit criteria before the next starts. Meta, TikTok and Higgsfield are coded against their real APIs but run in mock/dry-run mode until credentials exist.
- Frontend: **Next.js 16.3.6 + `@opennextjs/cloudflare` 1.20.6** on Cloudflare Workers. `next-on-pages` is deprecated, and OpenNext needs Next ≥16.3.3.
- Auth: **email + password**. An Admin invites teammates, passwords are hashed with argon2id, and the API sets an httpOnly session cookie.

**Environment (verified)**
- Node 22.22.2, pnpm 10.33, 4 CPUs.
- Postgres 16 binaries at `/usr/lib/postgresql/16/bin` (not running; `initdb` has to run as the `postgres` user because we're root). redis-server 7.0.15. Docker is available.
- Chromium revision 1194 at `/opt/pw-browsers`. No ffmpeg.
- No Anthropic, Meta, TikTok or Higgsfield credentials. So every external call has a deterministic mock mode, and the whole pipeline runs end to end in tests and CI.

**Version pins where npm `latest` is a trap (verified)**
| Package | Pin | Why not `latest` |
|---|---|---|
| typescript | 6.0.3 | 7.0.2 is the Go port and has no JS API |
| eslint | 9.39.5 | eslint-config-next plugins only support up to v9 |
| prisma, @prisma/client, @prisma/adapter-pg | 7.10.0 | `latest` is 8.0.0-rc |
| ioredis | 5.11.1 | BullMQ 6 made it an optional peer, so it must be installed explicitly |
| @playwright/test | 1.56.1 | the version that matches the preinstalled chromium-1194 |

Other pins: bullmq 6.3.8, fastify 5.12.5, zod 4.6.5, @anthropic-ai/sdk 0.128.0, turbo 2.11.3, tailwindcss 4.3.3, vitest 5.0.1, @node-rs/argon2 2.2.1 (prebuilt, no node-gyp), sharp 0.35.x, react 19.3. The appendix has the full pin table.

---

## Architecture (summary)

**Monorepo layout (pnpm workspaces + turbo)**
- `apps/web` (`@enmo/web`): Next 16 App Router, a thin client of the API.
  - TanStack Query for data, Tailwind v4 theme tokens, self-hosted fonts (@fontsource-variable → `next/font/local`).
  - No middleware or `proxy.ts`, because OpenNext doesn't support Node middleware.
  - A custom `worker.ts` adds a Cloudflare cron that pings the API every 5 minutes to keep it awake.
- `apps/api` (`@enmo/api`): one Fastify package with two entrypoints, built with tsup.
  - `server.ts` serves HTTP + SSE; `worker.ts` runs the BullMQ consumers and schedulers.
  - `EMBEDDED_WORKER=true` runs both in one process for dev and for Render's free tier.
- `packages/shared`: everything the web app and API both need, with zero Node dependencies.
  - Zod enums, DTOs, all 7 agent contracts, the task-graph schema and its validator.
  - The SSE event union, approval-chain logic, status→kanban/pill maps, platform rules, the banned-words matcher, and the RBAC capability matrix.
- `packages/db`: Prisma 7 schema, `prisma.config.ts`, migrations, `createPrisma()` using the pg adapter, and the seed script.
- `packages/agents`: the pure agent layer, with no database or queue access.
  - An `LlmClient` interface with two implementations: Anthropic and a deterministic MockLlm with fault injection.
  - The runner (strict JSON, 2 retries that feed the zod errors back, then escalate, daily token cap), plus the prompts and agent definitions.
- `packages/providers`:
  - Visual: `MockProvider` (sharp-rendered branded PNG placeholders) and `HiggsfieldProvider` (REST).
  - Storage: local disk and Cloudflare R2.
  - Imaging and the Adapter's reframing.
  - Publishers: Meta, TikTok, and a DryRun wrapper.
  - OAuth (Meta, TikTok) and metrics (Meta, TikTok, Synthetic).
- The web app is lint-blocked from importing `@enmo/db`, `@enmo/agents` or `@enmo/providers`.

**Key design decisions**
- **Full Prisma schema lands in Phase 1** (appendix A), so later phases rarely touch that shared file.
- **Task graph DAG is scheduled from Postgres, not BullMQ FlowProducer**, because FlowProducer only handles trees. `AgentTask` rows hold `dependsOn`. When a task finishes, an idempotent `advance(graphId)` queues whatever is now ready.
- **Three BullMQ queues** keep Upstash command costs down:
  - `agents`: LLM work
  - `media`: rendering and adapting
  - `ops`: publishing, metrics, and scheduler ticks via `upsertJobScheduler`
- **Strict JSON from Claude:**
  - Call `messages.stream().finalMessage()` with `output_config.format: zodOutputFormat(schema)`, then run our own `safeParse` plus business validation.
  - On failure, feed the zod issues back and retry, at most 2 times, then escalate.
  - Model is `claude-sonnet-5` (env `ANTHROPIC_MODEL`). No temperature and no prefill.
  - Pass `authToken: null` and an explicit base URL, so the dev harness's `ANTHROPIC_*` env vars are never picked up.
- **One consolidated question:**
  - The intake contract may return `clarify` once.
  - After that, the orchestrator switches to a schema that has only the `brief` branch, so any remaining gaps must become written `assumptions`.
- **Plan approval before any generation spend.** The PlanCard shows a code-computed token/$ estimate against the remaining daily budget.
- **Request Changes:**
  - The reviewer picks a target (Copy / Visual / Both).
  - The feedback text is passed **byte-for-byte** into that agent's revision input, and `AgentRun.inputSnapshot` makes this testable.
  - A revision subgraph is appended, which leads to a new approval round.
- **Approve-all** approves the current step of each eligible request. It never skips chain steps, and it writes an AuditLog row plus `viaApproveAll` decisions.
- **Publishing safety:**
  - At execution time, check four things: the latest approval is APPROVED, its `contentHash` still matches, there are no banned words, and the token is valid.
  - Any edit after approval cancels the PublishJob and reopens approval.
  - Dry-run is the default (`PUBLISH_MODE`); it returns `https://dryrun.enmo.marketing/...` URLs.
- **Realtime:**
  - The worker writes a `RealtimeEvent` row, then publishes it on Redis. One API subscriber fans it out to SSE clients.
  - `Last-Event-ID` replays missed events from the table; a heartbeat goes out every 15s.
  - CORS is exact-origin with credentials. Cookie: `Domain=.enmo.marketing`, `SameSite=Lax`, `Secure`, `HttpOnly`.
- **Visual loop:** submit → poll → store → Visual Director review (LLM looks at the image).
  - A weak take is regenerated at most 2 times as new Asset versions (`parentAssetId`/`rootAssetId`), then escalated.
  - Regenerating from the Vault gives the Visual Director its original context back.
- **Learning loop:**
  - Metrics are captured at 24h, 72h and 168h after publishing. `score = engagementRate / accountBaseline`.
  - The Analyst runs weekly and writes `LearningLog` entries; code recomputes each lift from the evidence.
  - The Strategist receives unapplied learnings and marks the ones it used as `applied`, so each insight surfaces once.
  - In dry-run, SyntheticMetrics has a known, learnable bias, which lets Phase 6 prove the loop closes.

**Defaults I picked where the doc is silent** (easy to change later)
- Calendar drag-to-reschedule picks the best slot on the new day deterministically, with no LLM call.
- The Publisher LLM picks from the optimizer's top-5 candidates, and falls back to the top candidate if it fails.
- Manager QA may send a post back for 1 automatic revision before it goes to humans.
- The North Star "Brief → Live" metric is shown next to "Brief → Ready" (all posts scheduled). A 12-post campaign scheduled across a month naturally goes live over several weeks.
- "Hours saved" is an estimate: configurable minutes per post type, minus review time.
- Render: `render.yaml` defines an API web service, a background worker, and Postgres 16. Cloudflare: `wrangler.jsonc` for `app.enmo.marketing`. Assets go to R2 in production, because Render's disk is ephemeral and Meta and TikTok need public URLs. Nothing gets deployed from this session, because there are no credentials.

---


---

## Phases

Each phase lists its A-step contents, its B units (U1–U4, which own disjoint files) and its exit test. File ownership is spelled out in appendix D.

### Phase 1 — Foundation
Exit: log in, create a client, see the dashboard.
- **A:**
  - root configs: turbo, tsconfig.base, eslint flat config, prettier, `.node-version`, `pnpm-workspace.yaml` with `allowBuilds`
  - `scripts/services.sh` (local PG on :54329 via `runuser -u postgres`, Redis on :63799)
  - `packages/shared` basics
  - `packages/db` with the **full schema** and migration `0001_init`, plus a test that Prisma enums match the zod enums
  - the api skeleton and test helpers
  - the web skeleton with design tokens and the six-screen sidebar
  - `docs/DESIGN.md`
- **B:**
  - U1 Auth/users/invites/sessions/audit plus RBAC plugins
  - U2 Clients, social accounts (AES-256-GCM token encryption), capabilities, health
  - U3 Web shell: login, invite accept, clients editor (including ApprovalChainEditor), admin users, and a Command Center shell with the cinematic empty state
  - U4 Infra: `render.yaml`, CI workflow, tsup config, `smoke-api.mjs`, `docker-compose.dev.yml`, README
- **Exit test:** integration tests for auth, invites, the RBAC matrix and clients. Playwright `phase1.spec`: the seeded admin logs in → sees "The Arsenal is idle. Give it a brief." → creates the client "Qahwa Co" → the client appears in the list. Also: `build:cf` succeeds and `smoke-api` gets 200 from `/healthz`.

### Phase 2 — First words
Exit: brief → caption drafts → approve in UI.
- **A:**
  - contracts: common, manager intake/plan/qa, copywriter, task-graph + validator, events, banned-words, progress
  - `packages/agents` skeleton
  - queues, registries and deps
  - `PIPELINE_ACTIONS=write,qa`
- **B:**
  - U1 Agents: runner, Anthropic client, MockLlm, prompts and definitions
  - U2 Orchestration: intake, plan, graph advance, feedback, escalation, budget, approvals service, realtime publisher
  - U3 Routes and SSE hub
  - U4 Web: Brief chat (ClarifyCard, PlanCard, ProgressFeed, PostCard, RequestChangesDialog, CopyEditor, ApproveAllBar), realtime hook, basic kanban and alerts
- **Exit test** `phase2.brief-to-approval`:
  1. "Ramadan campaign for the coffee client — 12 posts, push the iced line" → exactly one clarify.
  2. The answer → the plan. No Copywriter runs happen before the plan is approved.
  3. Approve the plan → 12 posts in PENDING_APPROVAL, with a "Copywriter ✓" SSE event.
  4. Request changes on p3 → the feedback reaches the Copywriter verbatim → approval round 2.
  5. Approve-all → 12 posts APPROVED plus 1 AuditLog row.

  Also covered:
  - fault `invalid*2` → succeeds on attempt 3
  - `invalid*3` → ESCALATED
  - `DAILY_TOKEN_CAP=1` → BLOCKED_BUDGET
  - Playwright `phase2.spec`

### Phase 3 — Eyes
Exit: brief → approvable post card with a placeholder visual.
- **A:** Visual Director contracts, the providers skeleton with committed OFL fonts, render/review jobs, and `PIPELINE_ACTIONS=write,direct,qa`.
- **B:**
  - U1 Providers: Mock, Higgsfield, local and R2 storage, placeholder imaging
  - U2 Visual Director plus the render/review/regenerate loop and versioning
  - U3 Asset and files routes, plus `accept_best` for resolving escalations
  - U4 Web: Vault (search, lineage drawer, regenerate), PostPreview with shimmer, PostDetailDrawer
- **Exit test** `phase3.brief-to-visual`: every post has a READY current asset served at 1080×1920 PNG. A Vault regenerate creates v2 and gives the Visual Director its original context. Fault `weak*3` → 2 regenerations, then escalation. Playwright checks that the card image loads and that Vault search finds it.

### Phase 4 — Go live (Meta)
Exit: an approved post publishes itself to IG/FB.
- **A:** Publisher contract, `platform-rules.ts` (formats, limits, best-time priors), publish/oauth/metrics interfaces, publish jobs and ticks, and a skeleton fake Graph server.
- **B:**
  - U1 Meta publisher and OAuth (Graph `v26.0` via env; IG image/reel/story/carousel via containers; FB photo/reel/multi-photo; resume from `containerId`) plus contract tests against the fake Graph server
  - U2 Slot optimizer, publish guards, publish service and processors, Publisher agent
  - U3 Calendar, publish-jobs and Meta OAuth routes
  - U4 Web: Calendar month grid with dnd-kit drag and ghost slots, Approvals queue with batch approve from thumbnails, Connected Accounts
- **Exit test** `phase4.self-publish`: approve → slot assigned → move the FakeClock forward → dry-run PUBLISHED with `liveUrl` → post LIVE. The same flow in `PUBLISH_MODE=live` against the fake Graph server asserts the exact call sequence. An edit after approval cancels the job. Dragging on the calendar moves the job to the best hour on the new day. Playwright `phase4.spec`.

### Phase 5 — Everywhere
Exit: one brief → three platforms, in native formats.
- **A:** Adapter contract, TikTok rules, the variant format map, fake TikTok/Higgsfield servers, and `PIPELINE_ACTIONS=write,direct,adapt,qa`.
- **B:**
  - U1 TikTok publisher and OAuth (creator_info → init with PULL_FROM_URL → status fetch; photo mode; SELF_ONLY while the app is unaudited; token refresh)
  - U2 Adapter agent plus sharp reframing and overlays (9:16, 4:5, 1:1, carousel frames)
  - U3 Full Higgsfield provider plus a `VideoAssembler` (Noop by default; Ffmpeg when `FFMPEG_PATH` is set)
  - U4 Web: variant tabs, carousel viewer, TikTok connect, capability badges
- **Exit test** `phase5.three-platforms`:
  - each variant has the right format and pixel size for its platform
  - carousel frame count equals slide count
  - a dry-run publish to all three platforms gives three live URLs
  - the full pipeline passes again with `VISUAL_PROVIDER=higgsfield` against the fake server, which proves the provider swap is one file

### Phase 6 — The loop
Exit: content visibly improves week over week.
- **A:** Strategist and Analyst contracts, dashboard DTOs, metrics and analyst jobs, and `PIPELINE_ACTIONS=strategy,write,direct,adapt,qa`.
- **B:**
  - U1 Metrics pull (Meta, TikTok, Synthetic), baseline, scoring, SlotScore learning
  - U2 Analyst and Strategist agents, feature table, applied-flag logic, the Strategist node feeding the Copywriter
  - U3 Dashboard services (pipeline, alerts, learnings, growth / North Star) plus routes
  - U4 Command Center: kanban, alerts, learnings feed, growth tiles with SVG charts
- **Exit test** `phase6.week-over-week`:
  - Week 1 publishes in dry-run and gets synthetic metrics. The Analyst then writes a hook-timing learning with lift > 1.5.
  - Week 2: the Strategist applies that learning, the post's `applied` flag becomes true, and the mean score rises to at least 1.2× week 1.
  - Week 3: the learning is not offered again as unapplied.
  - The growth API returns a rising series.
  - Playwright `phase6.spec`.

  The README states plainly that this proves the loop closes on synthetic data. Real improvement can only be measured with live accounts.

---

## Verification (end to end)
- Per phase: run `scripts/services.sh up`, then `pnpm turbo run lint typecheck test build`, `pnpm --filter @enmo/web build:cf` and `pnpm --filter @enmo/web test:e2e -- phaseN` (with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; never run `playwright install`), then `node scripts/smoke-api.mjs`.
- Final pass after Phase 6: run every exit test (phases 1–6) plus every Playwright spec together on a clean database. Then manually drive the app with the `run` skill: log in, create a client, run a brief through to live (dry-run), and take screenshots of the six screens to check against the design tokens.
- CI (`.github/workflows/ci.yml`) mirrors this with postgres:16 and redis:7 services. It gets pushed with Phase 1, but I can't watch it run from here unless a PR exists. No PR gets opened unless you ask for one.

## What you'll need to add later (not blocking)
- `ANTHROPIC_API_KEY` (switches `LLM_PROVIDER` to `anthropic`)
- Upstash `REDIS_URL` (eviction off)
- Render Postgres, `TOKEN_ENC_KEY`, Cloudflare R2 credentials, and the `assets.enmo.marketing` domain
- Meta app ID and secret, with App Review for `instagram_content_publish` and `pages_manage_posts`
- TikTok client key and secret, plus an app audit (unaudited apps can only post SELF_ONLY)
- Higgsfield credentials and model IDs
- A Cloudflare API token for deploys

---

# Appendix — Design reference

## A. Repo layout
```
package.json (packageManager pnpm@10.33.0)  pnpm-workspace.yaml (allowBuilds: esbuild, prisma, @prisma/engines, msgpackr-extract, workerd, sharp, @node-rs/argon2 if needed)
turbo.json  tsconfig.base.json  eslint.config.mjs  .prettierrc  .node-version (22.22.2)  .gitignore
render.yaml  docker-compose.dev.yml  .github/workflows/ci.yml  scripts/{services.sh,smoke-api.mjs}  docs/DESIGN.md  README.md
apps/api/src/{server.ts,worker.ts,app.ts,deps.ts,config.ts}
         src/plugins/{auth,rbac,security,errors}.ts   src/routes/<resource>.ts + index.ts
         src/services/  src/orchestrator/{intake,plan,graph,post-status,progress,feedback,escalation,visuals,variants,strategy}.ts
         src/jobs/{connection,queues,registry,runtime,schedulers}.ts + processors/*.ts   src/realtime/{publisher,hub,sse}.ts
         src/publishing/{slot-optimizer,guards,publish-service}.ts   src/learning/{metrics,baseline,scoring,features}.ts
         src/lib/{crypto,clock,tokens,logger,errors}.ts   src/scripts/create-admin.ts
         test/{helpers,fakes,integration,e2e}/
apps/web/{next.config.ts,open-next.config.ts,wrangler.jsonc,worker.ts,postcss.config.mjs,playwright.config.ts}
         src/{app,components,hooks,lib}/  e2e/phase{1..6}.spec.ts
packages/shared/src/{enums,dto/*,contracts/*,task-graph,events,approval-chain,status,platform-rules,platform-notes,banned-words,progress,rbac}.ts
packages/db/{prisma/schema.prisma,prisma/migrations,prisma.config.ts,src/index.ts,src/seed.ts}
packages/agents/src/{runner.ts,llm/{types,anthropic}.ts,llm/mock/**,prompts/*,definitions/*,validators/*}
packages/providers/src/{visual,storage,imaging,publish,oauth,metrics}/*  fonts/ (OFL TTFs: SpaceGrotesk-Bold, Inter-SemiBold, JetBrainsMono)
```
- Internal packages are TS-source (`exports: ./src/index.ts`, ESM, `moduleResolution: Bundler`). The web app uses `transpilePackages: ["@enmo/shared"]`.
- The API is bundled with tsup: entries `server`, `worker` and `create-admin`; `noExternal: [/^@enmo\//]`; ESM, targeting node22.
  - `apps/api` must declare every runtime dependency its bundled workspace code needs (for example `@prisma/client`, `@prisma/adapter-pg`, `pg`, `sharp`).
  - `smoke-api.mjs` boots `dist/server.js` so a missing dependency gets caught.
- turbo:
  - `build` depends on `^build`; the db package's build is `prisma generate`.
  - `typecheck` and `test` depend on `^build`.
  - outputs: `dist/**`, `.next/**`, `.open-next/**`, `src/generated/**`

## B. Prisma schema (`packages/db/prisma/schema.prisma`, migration `0001_init`)
Generator: `prisma-client` with `output = "../src/generated"`, `moduleFormat = "esm"`, `runtime = "nodejs"`. The datasource has no URL, because `prisma.config.ts` supplies it:
```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx src/seed.ts" },
  datasource: { url: process.env.DATABASE_URL },
});
```
`createPrisma(url)` returns `new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })`.

```prisma
enum Role            { ADMIN MANAGER EDITOR }
enum Platform        { INSTAGRAM FACEBOOK TIKTOK }
enum PostType        { REEL TIKTOK CAROUSEL STATIC STORY }
enum PostStatus      { IDEA DRAFTING VISUALIZING ADAPTING QA PENDING_APPROVAL CHANGES_REQUESTED APPROVED SCHEDULED PUBLISHING LIVE SCORED FAILED }
enum VariantFormat   { VERTICAL_9_16 PORTRAIT_4_5 SQUARE_1_1 }
enum AgentName       { MANAGER STRATEGIST COPYWRITER VISUAL_DIRECTOR ADAPTER ANALYST PUBLISHER }
enum CampaignStatus  { BRIEFING PLANNING PRODUCING ACTIVE COMPLETED ARCHIVED }
enum TaskGraphStatus { PROPOSED APPROVED REJECTED SUPERSEDED COMPLETED }
enum TaskStatus      { PENDING QUEUED RUNNING WAITING SUCCEEDED ESCALATED FAILED BLOCKED_BUDGET CANCELLED }
enum RunOutcome      { OK INVALID_OUTPUT REFUSED TRUNCATED API_ERROR }
enum AssetKind       { IMAGE VIDEO }
enum AssetRole       { SHOT MASTER VARIANT_FRAME }
enum AssetStatus     { QUEUED RENDERING READY FAILED REJECTED }
enum ApprovalStatus  { PENDING APPROVED CHANGES_REQUESTED CANCELLED }
enum Decision        { APPROVE REQUEST_CHANGES }
enum FeedbackTarget  { COPY VISUAL BOTH }
enum PublishStatus   { SCHEDULED QUEUED PUBLISHING PUBLISHED FAILED CANCELLED }
enum MessageRole     { USER AGENT SYSTEM }
enum MessageKind     { TEXT CLARIFY BRIEF PLAN PROGRESS POST_CARD ESCALATION }
enum AccountStatus   { ACTIVE EXPIRED REVOKED ERROR }
enum Confidence      { LOW MEDIUM HIGH }
```
Models, fields and relations (every model has `id String @id @default(cuid())`, and `createdAt`/`updatedAt` where it makes sense):

**People and access**
- **User**:
  - `email @unique` (stored lowercased), `name`, `passwordHash` (argon2id), `role Role`, `isActive`, `lastLoginAt`
  - relations: sessions, invitesSent, decisions, messages, auditLogs
- **Session**: `tokenHash @unique` (sha256 of the cookie token), `userId` (cascade delete), `expiresAt`, `lastSeenAt`, `ip`, `userAgent`. Index on `userId`.
- **Invite**: `email`, `role`, `tokenHash @unique`, `invitedById`, `expiresAt`, `acceptedAt?`, `revokedAt?`.

**Clients**
- **Client**:
  - `name`, `slug @unique`, `timezone` (IANA, default "UTC"), `brandVoice` (text)
  - `visualStyle Json` (VisualStyleTokens), `bannedWords String[]`, `approvalChain Json` (ApprovalChain), `enabledPlatforms Platform[]`, `archivedAt?`
- **SocialAccount**:
  - `clientId`, `platform`, `externalId`, `handle`, `displayName?`
  - `accessTokenEnc` and `refreshTokenEnc?`, both in the format `v1:<iv>:<tag>:<ct>` (AES-256-GCM with `TOKEN_ENC_KEY`)
  - `tokenExpiresAt?`, `refreshExpiresAt?`, `scopes[]`, `meta Json` (pageId, igUserId, username), `status AccountStatus`, `lastCheckedAt?`, `connectedById?`
  - `@@unique([platform, externalId])`

**Campaigns and chat**
- **Campaign**:
  - `clientId?`: stays null until the brief resolves a client
  - `name`, `status`, `brief Json?`
  - `clarifyCount Int`: enforces the one-question rule
  - `briefAt`: when the North Star clock starts
  - `briefLockedAt?`, `createdById`
- **ChatThread**: `campaignId @unique`.
- **ChatMessage**:
  - `threadId`, `role`, `kind`, `agent AgentName?` (so agents can sign their messages), `userId?`
  - `content`, `payload Json?`
  - index on `[threadId, createdAt]`

**Task graph and agent runs**
- **TaskGraph**:
  - `campaignId`, `version`, `status`, `summary`, `graph Json` (the validated plan output)
  - `estimate Json` (calls, input tokens, output tokens, USD)
  - `changeRequest?` (the feedback verbatim), `approvedById?`, `approvedAt?`
  - `@@unique([campaignId, version])`
- **AgentTask**:
  - `graphId`, `nodeKey` ("n7", or "n7.r1" for a revision), `agent`, `action`, `postId?`, `dependsOn String[]` (task ids)
  - `status`, `revision`, `contractAttempts`, `input Json?`, `output Json?`, `feedback Json?` (`{verbatim, source: HUMAN|QA, decisionId?}`), `error?`
  - timestamps: `queuedAt`, `startedAt`, `finishedAt`
  - `@@unique([graphId, nodeKey])`; indexes on `[status, updatedAt]` and `[postId]`
- **AgentRun**: a ledger with one row per LLM attempt.
  - `taskId?`, `campaignId?`, `clientId?`, `agent`, `action`, `attempt`, `model`, `promptVersion`, `outcome`, `stopReason?`
  - `inputSnapshot Json?`, `responseText?` (capped at 64 KB), `validationErrors Json?`
  - token counts: input, output, cacheRead, cacheWrite; plus `latencyMs`
- **TokenUsage**: `day @id @db.Date` (UTC); BigInt counters for input, output, cacheRead and cacheWrite; `calls`; `costUsdMicros`.

**Posts and assets**
- **Post**:
  - `campaignId`, `clientId`, `ref` ("p1"), `type`, `platforms[]`, `status`, `targetDate? @db.Date`
  - `pillar?`, `angle?`, `hook?`, `copy Json?` (the current CopywriterOutput)
  - `humanEditCount`, `revision`, `needsAttention`, `attentionReason?`, `qaNotes?`
  - timestamps: `approvedAt?`, `liveAt?`, `scoredAt?`
  - `@@unique([campaignId, ref])`; index on `[clientId, status]`
- **PostVariant**: one per platform.
  - `postId`, `platform`, `format`, `caption`, `hashtags[]`, `overlay Json?`
  - scoring: `engagementRate?`, `baselineRate?`, `score?`, `scoredAt?`
  - relations: `frames Asset[]` ("VariantFrames"), `publishJob?`, `metrics[]`
  - `@@unique([postId, platform])`
- **Asset**:
  - ownership: `clientId`, `campaignId?`, `postId?`, `variantId?` ("VariantFrames"), `position?`, `role`
  - versioning: `parentAssetId?` (self relation "AssetLineage"), `rootAssetId?`, `version`, `isCurrent`
  - render: `kind`, `status`, `provider` (mock|higgsfield|sharp), `providerModel?`, `providerJobId?`, `prompt`, `negativePrompt?`, `params Json`, `shotId?`, `sceneIndex?`
  - file: `storageKey?`, `url?`, `posterUrl?`, `mimeType?`, `width?`, `height?`, `durationSec?`, `bytes?`
  - review: `review Json?`, `regenCount`; plus `createdById?`
  - indexes on `[clientId, createdAt]`, `[postId]`, `[rootAssetId, version]`

**Approvals and publishing**
- **ApprovalRequest**:
  - `postId`, `round`, `status`, `chain Json` (a snapshot of the client's chain), `currentStep`
  - `contentHash`: sha256 of the copy, the variant captions and the current asset ids
  - `resolvedAt?`; `@@unique([postId, round])`; index on `[status, createdAt]`
- **ApprovalDecision**: `requestId`, `step`, `userId`, `decision`, `feedback?` (verbatim), `target FeedbackTarget?`, `viaApproveAll`, `auditLogId?`. `@@unique([requestId, step, userId])`.
- **PublishJob**:
  - `variantId @unique`, `socialAccountId?` (null only in dry-run), `platform`, `status`
  - scheduling: `scheduledFor`, `slotSource` (publisher|optimizer|manual), `slotReason?`
  - execution: `dryRun`, `attempts`, `containerId?` (for resuming), `externalId?`, `liveUrl?`, `lastError?`, `publishedAt?`
  - index on `[status, scheduledFor]`
- **SlotScore**: `clientId`, `platform`, `dayOfWeek` (0–6, client-local), `hourBucket` (0–7, 3-hour buckets), `meanScore`, `samples`. Unique on the first four.

**Metrics and learning**
- **PerformanceMetric**: `variantId`, `platform`, `capturedAt`, `ageHours`; views, reach, likes, comments, shares and saves (all nullable); `engagements`, `engagementRate?`, `source` (meta|tiktok|synthetic), `raw Json?`.
- **AccountBaseline**: `clientId`, `platform`, `computedAt`, `windowDays`, `engagementRate`, `sampleSize`, `source` (platform_history|enmo_history|default_benchmark).
- **AnalystReport**: `clientId`, `weekOf @db.Date`, `summary`, `strategistBrief`, `stats Json`, `agentRunId?`. `@@unique([clientId, weekOf])`.
- **LearningLog**:
  - `clientId`, `reportId?`, `takeaway`, `recommendation`, `metric`
  - `claimedLift`, `computedLift`, `confidence`, `evidencePostIds[]`, `appliesTo Json` (platforms[], postTypes[])
  - `applied` (default false), `appliedAt?`, `appliedInCampaignId?`
  - index on `[clientId, applied, createdAt]`

**System**
- **AuditLog**: `actorId?`, `action` (e.g. auth.login, user.invite, plan.approve, approval.approve_all, publish.reschedule), `entityType`, `entityId?`, `data Json?`, `ip?`.
- **RealtimeEvent**: `id BigInt @id @default(autoincrement())`, `channel` ("global" | "thread:<id>"), `type`, `payload Json`. Index on `[channel, id]`. Pruned after 7 days.

**Status mapping** (`shared/status.ts`)

| PostStatus | Kanban column | Pill |
|---|---|---|
| IDEA | Idea | PLANNING |
| DRAFTING, CHANGES_REQUESTED | Draft | PLANNING |
| VISUALIZING, ADAPTING, QA | Visual | PLANNING |
| PENDING_APPROVAL | Approval | PENDING_APPROVAL |
| APPROVED, SCHEDULED, PUBLISHING | Scheduled | SCHEDULED (green border once approved) |
| LIVE | Live | LIVE |
| SCORED | Scored | LEARNED |
| FAILED | stays in its column | its pill, plus `needsAttention` and an alert |

## C. Agent layer
**Runner** `runAgent(def, input, {llm, budget, recorder, maxRetries: 2})`. Each attempt, up to 3 in total:
1. **Budget check.** If today's input + output tokens ≥ `DAILY_TOKEN_CAP`, throw `BudgetExceeded`. The task becomes `BLOCKED_BUDGET`, and the sweeper re-queues it after UTC midnight.
2. **Call the LLM:** `llm.complete({model, max_tokens, thinking: {type: "adaptive"}, output_config: {effort, format: zodOutputFormat(def.output)}, system: [staticPrompt, brandBlock (cache_control)], messages})`, using `client.messages.stream(...).finalMessage()`.
3. **Record** an AgentRun row and upsert the day's TokenUsage.
4. **Check `stop_reason`.** `refusal` escalates. `max_tokens` retries with `max_tokens × 1.5`, capped at 32k.
5. **Validate:** `JSON.parse`, then `def.output.safeParse`, then `def.validate` (business rules). If there are issues, append the assistant's reply plus a user turn listing each failing path and message, ask for the complete corrected JSON, and retry.
6. **After 2 failed retries**, throw `AgentEscalation`.

**Transport errors** (429, 5xx, connection) don't count against those 2 retries. The SDK retries them first (`maxRetries: 2`), then BullMQ (`attempts: 3`, exponential backoff starting at 5s).

**Anthropic client:** `new Anthropic({apiKey: env.ANTHROPIC_API_KEY, authToken: null, baseURL: env.ENMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com", maxRetries: 2})`.

**Output schema rules:**
- The root is an object.
- Every field is required; use `.nullable()`, never `.optional()`.
- No `z.record`, no recursion, no `z.any`.

**Visual Director review** sends the render as base64, downscaled to a 1568px long edge.

**Effort defaults:** high for manager.plan, strategist and analyst; medium for manager.intake, copywriter and visual direct; low for everything else. Each can be overridden with `AGENT_EFFORT_<AGENT>`.

**Contracts** (`packages/shared/src/contracts/*`):
- **Common types:**
  - `BrandContext` {clientId, name, timezone, brandVoice, bannedWords, visualStyle, platforms}
  - `Brief` {clientId, title, objective, productFocus|null, audience|null, keyMessages[], platforms[≥1], postCount 1–60, postMix[{type, count}], window{start, end}, cadenceNotes|null, constraints[], assumptions[]}
  - `FeedbackInput` {verbatim, source: HUMAN|QA, decisionId|null} | null
- **Manager intake:**
  - Input: {thread[], clients[{id, name}], selectedClientId|null, today, allowClarify, brand|null}
  - Output: `{result: {kind: "clarify", question, missing[≥1 of client|platforms|postCount|postMix|window|objective|productFocus], draft: BriefDraft} | {kind: "brief", brief, confirmation}}`
  - Once `clarifyCount ≥ 1`, the call uses `ManagerIntakeNoClarifyOutput`, which only has the brief branch.
  - Validation: `postMix` sums to `postCount`; window.start ≥ today and window.end ≥ window.start; the client is in the list; platforms ⊆ the client's `enabledPlatforms`.
- **Manager plan:**
  - Input: {brief, brand, today, enabledActions, busyDates, changeRequest|null, previousGraph|null}
  - Output: {summary, posts[{ref /^p\d{1,3}$/, type, platforms[≥1], targetDate, angle, pillarHint|null}], nodes[{id /^n\d{1,4}$/, agent, action: strategy|write|direct|adapt|qa, postRef|null, deps[], instructions|null}]}
  - `validateTaskGraph` is a pure function. It checks:
    - node ids are unique and every dependency exists
    - the graph is acyclic (Kahn's algorithm)
    - fixed agent/action pairs
    - at most one strategy node, with a null `postRef`
    - each post gets exactly one node per enabled per-post action, chained write→direct→adapt→qa, and write depends on strategy when there is one
    - post count and type mix match the brief; platforms ⊆ the brief's; dates fall inside the window
    - no more than 4 × posts + 1 nodes
  - The token and dollar estimate is computed in code, not by the model.
- **Manager QA:**
  - Input: {brief, brand, post, copy, visuals|null, variants|null, automatedChecks[]}
  - Output: {verdict: pass|revise, issues[{target: COPYWRITER|VISUAL_DIRECTOR|ADAPTER, field, problem, instruction}], summaryForReviewer}
  - At most 1 QA revision per post (`MAX_QA_REVISIONS=1`). After that the post goes to humans with `qaNotes`.
- **Strategist** (Phase 6):
  - Input: {brief, brand, posts, learnings (unapplied, plus up to 3 recent applied), analystBrief|null, platformNotes}
  - Output: {pillars[1–5]{name, description}, angles[{postRef, pillar, angle, hook, hookType, targetHookSec|null, rationale, learningIds[]}], appliedLearningIds[]}
  - Validation: every learning id must come from the input.
- **Copywriter:**
  - Input: {brief, brand, post{ref, type, platforms, targetDate, angle, hook|null, pillar|null, targetHookSec|null, instructions|null}, revision: {feedback, previous}|null}
  - Output: {caption, hashtags[], cta, altText, platformCaptions[{platform, caption}], script: {totalDurationSec, hookTimestampSec, hookText, scenes[{index, startSec, durationSec, voiceover, overlayText, visualNote}]}|null, slides[{index, headline, body}]|null, onScreenText|null}
  - Validation:
    - the right shape for the post type: script for REEL and TIKTOK, 3–10 slides for CAROUSEL, onScreenText for STATIC and STORY
    - scenes are contiguous and their durations sum to the total, within ±0.25s
    - the hook lands within 3s and inside the first scene
    - total length ≤ 90s
    - captions ≤ 2200 characters; ≤ 30 hashtags
    - exactly one caption per platform
    - no banned words in any text field
- **Visual Director, direct:**
  - Input: {brand, post, copy, feedback, previousShots|null, capabilities}
  - Output: {consistency{characterDescription|null, palette[], lighting, styleKeywords[]}, shots[1–12]{shotId /^s\d+$/, sceneIndex|null, slideIndex|null, kind IMAGE|VIDEO, aspectRatio, durationSec|null, prompt, negativePrompt, cameraNote, seed|null}}
  - One shot per scene, per slide, or one shot for single-image posts.
- **Visual Director, review:**
  - Input: {shot, render, attempt, brand}, plus the image
  - Output: {verdict: accept|regenerate, score, issues[], revisedPrompt|null}
- **Adapter** (Phase 5):
  - Input: {brand, post, masters[], copy{slides, onScreenText, overlays}, targets[{platform, format}]}
  - Output: {variants[{platform, format, frames[{sourceAssetId, crop{focusX 0–1, focusY 0–1, zoom 1–2}, overlay{text ≤90, position, align, style, scrim}|null}]}]}
- **Analyst** (Phase 6):
  - Input: {client, weekOf, baselines[], posts[per-variant features + score], priorLearnings[]}
  - Output: {summary, learnings[0–5]{takeaway, metric, direction, claimedLift, evidencePostIds[≥2], appliesTo, recommendation, confidence}, strategistBrief}
  - Code then recomputes `computedLift` from the evidence.
- **Publisher** (Phase 4):
  - Input: {campaign, briefSummary, timezone, items[{variantId, platform, postType, targetDate, candidates[top 5 {slotStart, score, reasons}]}]}
  - Output: {assignments[{variantId, slotStart ∈ candidates, reason}]}
  - Once retries run out, it falls back to the top candidate (`slotSource=optimizer`). No escalation.

**Banned words** (`shared/banned-words.ts`):
- The matcher normalizes with NFKC and case-folding, then uses the regex `(?<![\p{L}\p{N}])term(?![\p{L}\p{N}])/giu`, so it works for Arabic too. It handles multi-word phrases and strips `#` from hashtags.
- The same matcher is used in five places: the web editor's warnings, the agent validators, `PATCH /posts/:id/copy` (which returns 422), the gate before creating an approval request, and the publish guard.
- Every prompt also includes the list as "never use".

**MockLlm** (`packages/agents/src/llm/mock/`):
- Deterministic fixtures keyed by `agent.action`, seeded from a hash of the input. It goes through the exact same runner path as the real client.
- **Intake:** regex heuristics pick up "N posts", platform names and date phrases. Anything still missing produces one clarify.
- **Plan:** builds the canonical graph for the enabled actions.
- **Copywriter:** never uses banned words, honours `targetHookSec`, and prefixes its output with `[rev]` when it has feedback.
- **Analyst:** actually groups posts by hook timing and reports the real lift.
- **Fault injection:** `MOCK_LLM_FAULTS="COPYWRITER.write:invalid*2,VISUAL_DIRECTOR.review:weak*3"`, or pass the same thing to the constructor. Fault kinds: invalid, banned, refusal, truncated, weak.
- **Synthetic usage:** characters / 4.
- **Selection:** `LLM_PROVIDER=mock|anthropic`, defaulting to mock when no key is set. The UI shows a "MOCK LLM" chip.

## D. Orchestration, queues, realtime
**Redis connection:**
- `new IORedis(REDIS_URL, {maxRetriesPerRequest: null, enableReadyCheck: false})`. A `rediss://` URL gives TLS for Upstash.
- API producers use a separate client with `enableOfflineQueue: false`.
- The API holds one extra client for realtime SUBSCRIBE.
- Everything uses `prefix: BULLMQ_PREFIX`; tests use a unique prefix per file.

**Queues and schedulers:**
- `agents` (concurrency 4): manager.intake, manager.plan, task.run, visual.review, publisher.schedule, analyst.client
- `media` (4): render.submit, render.poll (re-enqueued with a 3–10s delay), adapt.render, video.assemble
- `ops` (2): publish.run, publish.poll, metrics.pull
- Schedulers are registered with `upsertJobScheduler` on worker boot, and are off when `SCHEDULERS_ENABLED=false`, which tests call directly:

  | Scheduler | Frequency |
  |---|---|
  | tick.publish | every 60s |
  | tick.metrics | hourly |
  | tick.tokens | hourly |
  | tick.analyst | Mondays 06:00 UTC |
  | tick.sweeper | every 5 min |
  | tick.prune | daily (RealtimeEvent rows older than 7 days, and Session rows past `expiresAt`) |

- Worker settings:
  - `drainDelay` comes from env (5s dev, 20s prod)
  - `stalledInterval: 60000`
  - `removeOnComplete: {age: 86400, count: 1000}`, `removeOnFail: {age: 604800}`

**Graph lifecycle:**
- **`approvePlan(graphId)`** runs as one transaction:
  - the graph becomes APPROVED and older PROPOSED graphs become SUPERSEDED
  - the campaign moves to PRODUCING
  - it creates the Post rows (IDEA) and the AgentTask rows, mapping postRef → postId and deps → task ids
  - after commit, it calls `advance`
- **`advance(graphId)`**:
  - finds PENDING tasks whose dependencies have all SUCCEEDED
  - runs `UPDATE … SET status='QUEUED' WHERE id IN (…) AND status='PENDING' RETURNING id`
  - enqueues `task.run` with `jobId = task:<id>:r<revision>`, which gives idempotency
- **`task.run`**:
  - does nothing unless the task is QUEUED or RUNNING
  - marks it RUNNING and updates the post status (write → DRAFTING, direct → VISUALIZING, adapt → ADAPTING, qa → QA)
  - builds the agent input from the database (brief, brand, post, upstream outputs, feedback) and calls `runAgent`
  - saves the output: `Post.copy`, shot Assets, or variants
  - async work (renders) leaves the task WAITING until every asset is resolved; otherwise it goes to SUCCEEDED, then `advance` runs
  - `AgentEscalation` → the task becomes ESCALATED, `post.needsAttention` is set, the Manager signs an ESCALATION chat message, and an `alert` event fires
- **QA outcomes:**
  - pass (or the QA revision limit is reached) → create `ApprovalRequest(round)`; the post goes to PENDING_APPROVAL
  - revise → append a revision subgraph for the named target
- **Progress:** each task transition upserts a single PROGRESS ChatMessage per graph and emits `agent.status`. The line comes from `shared/progress.ts formatProgress()`, for example `Copywriter ✓ 12/12 — Visual Director rendering 2/4…`.
- **Sweeper:**
  - RUNNING for more than 15 minutes with no live job → re-queue once, then FAILED with an alert
  - BLOCKED_BUDGET → re-queue after the UTC day rolls over
  - drive any stale WAITING render polls
- **Request Changes:**
  - the ApprovalDecision is saved with the verbatim feedback and a target; the post goes to CHANGES_REQUESTED and `revision` goes up by one
  - a revision subgraph is appended: COPY is `write.rN → [adapt.rN] → qa.rN`, VISUAL is `direct.rN → [adapt] → qa`, BOTH is `write → direct → adapt → qa`
  - `AgentTask.feedback = {verbatim, source: HUMAN, decisionId}`
  - a new approval round starts once QA finishes
- **Plan request-changes:** the feedback becomes `changeRequest`, passed verbatim to `manager.plan`. That produces graph version n+1, and the old one becomes SUPERSEDED.

**Realtime (SSE):**
- **Event union** (`shared/events.ts`, with a zod discriminated union on `type`):
  - `message.created` and `message.updated`
  - `agent.status` {campaignId, taskId, agent, postRef|null, state: queued|running|done|waiting|escalated, line}
  - `plan.proposed`
  - `post.updated` {postId, status, column, pill}
  - `asset.updated`
  - `approval.created` and `approval.resolved`
  - `publish.updated`
  - `alert` {kind: stuck|failed|escalated|budget|token_expiring, entityType, entityId, message}
  - `learning.created`
  - `budget.updated`
  - `resync`
- **Publisher** (`realtime/publisher.ts`): `publish(channel, type, payload)` inserts a RealtimeEvent row, then `PUBLISH enmo:rt {id, channel, type, payload}`. It works from both the worker and the API.
- **Hub** (`realtime/hub.ts`): one SUBSCRIBE connection per API process, fanning out to in-memory subscriber sets keyed by channel.
- **Endpoint** `GET /v1/events?threadId=` (needs a session):
  - subscribes to `global`, plus `thread:<id>` when a thread is given
  - calls `reply.hijack()`, then writes the headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, and the CORS headers copied over manually
  - sends `retry: 3000` first
  - replay: when a `Last-Event-ID` header or `?lastEventId=` is present, replay rows with id greater than that on those channels (up to 500). More than 500 sends `resync` instead.
  - frames are `id:`, `event:`, `data:`; a `: ping` heartbeat goes out every 15s; the client is unsubscribed when the connection closes
- **Web** (`lib/realtime.tsx`):
  - opens one `EventSource(url, {withCredentials: true})`
  - each event type maps to TanStack Query invalidations or cache patches; `resync` invalidates everything
  - the thread page switches the stream to `?threadId=`

## E. Auth, security, API, RBAC
**Sessions:**
- Login verifies the password with argon2id (`@node-rs/argon2`).
- A session token is 32 random bytes in base64url. The database stores its sha256.
- Cookie `enmo_session`: `HttpOnly; Secure (COOKIE_SECURE); SameSite=Lax; Domain=COOKIE_DOMAIN; Path=/; Max-Age=SESSION_TTL_DAYS (30)`.
- Sessions roll: `lastSeenAt` and the expiry are extended at most every 5 minutes.
- Logout deletes the session row. Deactivating a user deletes all of their sessions. Signing in deletes the user's expired sessions; `tick.prune` (Phase 2) sweeps the rest.
- Login is rate-limited (`@fastify/rate-limit`): 10 per minute per IP and 5 per minute per email. A failed login returns a generic 401 and writes an audit row.
- The client IP (per-IP limits, `Session.ip`, `AuditLog.ip`, request logs) is `request.clientIp` (`lib/trusted-proxies.ts`), never `request.ip`. `TRUST_PROXY` lists our own hops, whose `X-Forwarded-For` entries are believed. `cloudflare` in that list means a Cloudflare edge's `CF-Connecting-IP` is believed; its `X-Forwarded-For` never is, because any Cloudflare Worker sends from Cloudflare's ranges with a header it wrote. Render sets `loopback,uniquelocal,cloudflare`. `TRUST_PROXY=true` is refused in production.

**CSRF and CORS:**
- `@fastify/cors`: exact `APP_ORIGINS` list, `credentials: true`.
- Non-GET requests must send an `Origin` in `APP_ORIGINS`. A request with a body must also send it as JSON: other content types get 415 before the body is read. Bodyless mutations (logout, archive, check, disconnect, revoke) need only the `Origin`, although the web client sends `Content-Type: application/json` on every mutation. Combined with SameSite=Lax, that covers CSRF.

**Passwords:** at least 12 characters. Setting one requires an invite token or the current password.

**Bootstrap:**
- `pnpm --filter @enmo/api create-admin --email --password`
- If the users table is empty on boot and `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are set, that admin is created.
- Invites don't send email. The ADMIN copies the one-time link `/invite/<token>` (expires in 7 days).

**Approval chain** (`shared/approval-chain.ts`):
- Shape: `{steps: [{name, approverRoles: Role[], approverUserIds: string[], minApprovals: 1..3}] (1–5 steps)}`.
- Default: `[{name: "Manager review", approverRoles: ["ADMIN","MANAGER"], approverUserIds: [], minApprovals: 1}]`.
- A user can decide the current step if their role is in `approverRoles` or their id is in `approverUserIds`.
- Once a step has `minApprovals`, the chain moves to the next step. After the last step, the request is APPROVED.
- REQUEST_CHANGES at any step resolves the request as CHANGES_REQUESTED.

**RBAC capability matrix** (`shared/rbac.ts`; enforced by `requireCap()` on the API and used to hide controls on the web):

| Capability | ADMIN | MANAGER | EDITOR |
|---|---|---|---|
| users.manage, invites.manage, audit.read (the team directory, names and roles only, needs just clients.read) | ✓ | – | – |
| clients.read, campaigns.read, posts.read, assets.read, calendar.read, dashboard.read, budget.read | ✓ | ✓ | ✓ |
| clients.write (brand voice, style, banned words, approval chain) | ✓ | ✓ | – |
| clients.archive, socialAccounts.manage (connect/disconnect/check, OAuth) | ✓ | – | – |
| campaigns.create, chat.post, plan.requestChanges, posts.editCopy, assets.regenerate | ✓ | ✓ | ✓ |
| plan.approve (starts spending), tasks.resolveEscalation, campaigns.archive | ✓ | ✓ | – |
| approvals.decide | chain-eligible | chain-eligible | chain-eligible |
| approvals.approveAll (still only for steps they're eligible for) | ✓ | ✓ | – |
| publish.reschedule, publish.cancel, publish.retry, analyst.run | ✓ | ✓ | – |

**API routes** (all under `/v1`; each route declares its required capability):
- **auth:** `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/password` · `GET /invites/:token` (public) · `POST /invites/:token/accept` (public)
- **users:** `GET /users` · `PATCH /users/:id {role?, isActive?}` (you can't demote or deactivate the last active ADMIN, or yourself) · `POST /invites {email, role}` · `GET /invites` · `DELETE /invites/:id` · `GET /users/directory` (clients.read: every account's id, name, role and isActive, no emails; for naming approvers and checking chains)
- **system:** `GET /capabilities` (LLM/visual/publish modes, which integrations are configured) · `GET /budget` · `GET /audit` · `GET /healthz` · `GET /readyz`
- **clients:**
  - `GET /clients` · `GET /clients/:id` · `POST /clients` · `PATCH /clients/:id` · `PUT /clients/:id/approval-chain` · `POST /clients/:id/archive`
  - social accounts: `GET /clients/:id/social-accounts` (never returns tokens) · `POST /clients/:id/social-accounts` (manual token) · `DELETE /social-accounts/:id` · `POST /social-accounts/:id/check`
  - OAuth: `GET /oauth/{meta,tiktok}/start?clientId` · `GET /oauth/{meta,tiktok}/callback`. The state and PKCE verifier are kept in Redis for 10 minutes, bound to the admin's session.
- **campaigns and chat:** `GET /campaigns?clientId&status` · `POST /campaigns {clientId?, message}` · `GET /campaigns/:id` · `POST /campaigns/:id/archive` · `GET /threads/:id/messages?after` · `POST /threads/:id/messages {content}`
- **plans and tasks:** `GET /task-graphs/:id` · `POST /task-graphs/:id/approve` · `POST /task-graphs/:id/request-changes {feedback}` · `GET /campaigns/:id/tasks` · `POST /agent-tasks/:id/resolve {action: retry|accept_best}`
- **posts:** `GET /posts?clientId&campaignId&status&platform` · `GET /posts/:id` · `PATCH /posts/:id/copy` (increments `humanEditCount`; returns 422 on banned words; after approval it reopens approval)
- **approvals:** `GET /approvals?clientId&platform&campaignId` (pending, newest first, with a `canDecide` flag) · `POST /approvals/:id/decision {decision, feedback?, target?}` · `POST /approvals/approve-all {requestIds[]}`
- **vault:** `GET /assets?q&clientId&campaignId&sceneIndex&kind&allVersions&cursor` · `GET /assets/:id` (includes lineage) · `POST /assets/:id/regenerate {instruction?}`
- **calendar:** `GET /calendar?from&to&clientId` (publish jobs plus ghost slots) · `PATCH /publish-jobs/:id {date}` · `POST /publish-jobs/:id/retry` · `POST /publish-jobs/:id/cancel`
- **dashboard:** `GET /dashboard/{pipeline,alerts,learnings,growth}?clientId` · `POST /clients/:id/analyze`
- **realtime and files:** `GET /events` (SSE) · `GET /files/*` (only when `STORAGE_DRIVER=local`)

## F. Visuals, publishing, learning
**Visual providers:**
- `VisualProvider` interface: `{name, capabilities(), submit(req) → {jobId}, status(jobId) → {state: queued|running|succeeded|failed|rejected, outputs?, error?}, cancel?}`.
- `createVisualProvider(env)` in `visual/index.ts` switches on `VISUAL_PROVIDER`. Adding a new provider means one new file and one new case.
- **MockProvider:**
  - builds a sharp gradient from the client palette, draws text with `sharp({text: {fontfile}})` using the committed TTFs, and adds a mono footer `MOCK · s2 · v1`
  - output sizes: 1080×1920, 1080×1350 or 1080×1080
  - `status()` reports success on the second poll, so the async path gets exercised
  - VIDEO returns a poster PNG with `params.mockVideo=true`
- **HiggsfieldProvider:**
  - `POST https://api.higgsfield.ai/{model}` with `Authorization: Key KEY_ID:KEY_SECRET`
  - `GET /requests/{id}/status` returns queued, in_progress, completed, failed or nsfw
  - `POST /requests/{id}/cancel`
  - model ids come from env
  - outputs are always downloaded into our Storage
- **Storage:** Local (served at `/files/*`) or R2 (S3 client, public base `https://assets.enmo.marketing`). **Production needs R2.**

**Adapter formats:**

| Post type | IG | FB | TikTok |
|---|---|---|---|
| REEL / TIKTOK | 9:16 | 9:16 | 9:16 |
| STORY | 9:16 | 9:16 | – |
| STATIC | 4:5 | 1:1 | 9:16 photo |
| CAROUSEL | 4:5 | 1:1 multi-photo | 9:16 photo mode |

- sharp does the extract and resize around the focus point and zoom, then renders overlay text with the brand fonts over an SVG scrim.
- Video targets are always 9:16. Multi-scene assembly needs ffmpeg (set `FFMPEG_PATH`); otherwise `NoopAssembler` uses the first clip, and the overlays stay as metadata that CSS draws in the preview.

**Meta** (`META_GRAPH_VERSION=v26.0`, base `https://graph.facebook.com/{v}`):
- **OAuth:**
  - scopes: `pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, instagram_manage_insights, read_insights, business_management`
  - flow: exchange the code, swap for a long-lived token (`fb_exchange_token`), then read `/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}`
  - store one SocialAccount per FB page and one per linked IG account
  - `tick.tokens` runs `debug_token` daily and marks accounts EXPIRED with an alert when needed
- **IG posting** (each container type below, then poll `status_code` until it's FINISHED, then `POST media_publish`, then read `permalink`):
  - image: `POST /{ig}/media {image_url, caption, alt_text}`
  - REELS: `{media_type: REELS, video_url, share_to_feed}`
  - STORIES
  - CAROUSEL: up to 10 children with `is_carousel_item`, then the parent container
  - check `content_publishing_limit` first
  - persist `containerId` right away, so a retry resumes the existing container instead of creating a new one
- **FB posting:**
  - photo: `POST /{page}/photos`
  - reel: `video_reels` start → upload to `rupload` with the `file_url` header → finish with `PUBLISHED`
  - carousel: upload photos unpublished, then `POST /{page}/feed {attached_media}`
  - story: `photo_stories` / `video_stories`

**TikTok** (base `https://open.tiktokapis.com`):
- **OAuth:** `/v2/auth/authorize/`, then `POST /v2/oauth/token/`. The access token lasts 24h and the refresh token 365 days. Tokens get refreshed within 2h of expiry.
- **Posting:**
  1. `creator_info/query`
  2. `POST /v2/post/publish/video/init/` with `source: PULL_FROM_URL`
  3. poll `status/fetch` until PUBLISH_COMPLETE
  4. build the `liveUrl` from the handle and post id

  Photo posts use `content/init` with `media_type: PHOTO`. Set `is_aigc` for generated content. `TIKTOK_APP_AUDITED=false` forces `SELF_ONLY`.

**Dry-run** applies when `PUBLISH_MODE !== "live"`, when there's no account, or when the platform has no credentials. It runs the same payload validation and returns `https://dryrun.enmo.marketing/<platform>/<variantId>`. All HTTP goes through an injected `fetch` with an overridable base URL, which is how the fake servers in `apps/api/test/fakes/` get used.

**Slot optimizer:**
- Priors are per-platform hour-of-week weights in the client's local time: IG weekdays 11–13 and 19–21, FB 9–13, TikTok 18–22 with Tue/Thu peaks.
- The prior is blended with the learned `SlotScore`: `(prior·5 + mean·n)/(5+n)`.
- Constraints:
  - inside the campaign window, and at least 30 minutes from now
  - at least 4h between posts and at most 2 per day for each client+platform
  - no collisions with existing jobs
- `candidates()` returns the top 5. `bestSlotOn(date)` is used for calendar drags.

**Metrics:** captured at 24h, 72h and 168h after publishing; IG Stories at 20h.
- IG: `/{media}/insights?metric=views,reach,likes,comments,shares,saved,total_interactions`
- FB: reactions, comments and shares, plus insights
- TikTok: `POST /v2/video/query/`
- Dry-run: `SyntheticMetrics`, which is deterministic and has a known bias: hooks under 1.2s get about 3× the engagement rate, and the best time buckets get +20%.

**Scoring:**
- engagements = likes + comments + shares + saves
- engagement rate = engagements / reach, falling back to views and then followers
- baseline = the average engagement rate over the trailing 90 days. The sources, in order of preference, are the platform's media history, ENMO's own history, then default benchmarks.
- score = engagement rate / baseline, measured at 72h and re-scored at 168h. A post becomes SCORED once all its variants are scored. SlotScore is updated at the same time.

**Weekly Analyst:**
1. Pull any overdue metrics.
2. Refresh baselines and scores.
3. Build the feature table.
4. Call the Analyst.
5. Recompute lifts, then save the AnalystReport and its LearningLogs.
6. Emit `learning.created`.

**Applied learnings:**
- The Strategist receives the unapplied learnings plus the latest `strategistBrief`.
- Learnings listed in its `appliedLearningIds` are marked `applied`, with `appliedAt` and `appliedInCampaignId` set.
- Later calls see at most 3 of them, as context.

**Growth dashboard v1:**
- Brief→Live and Brief→Ready, as medians per campaign
- approval pass rate: approved posts with round 1 and `humanEditCount = 0`, divided by all approved posts
- weekly mean score against the baseline
- hours saved: Σ `MANUAL_MINUTES[type]` (REEL 180, TIKTOK 150, CAROUSEL 120, STATIC 60, STORY 30), minus 10 minutes per approval round, divided by 60. It's labelled as an estimate.

## G. Frontend
**Routes:**
- `/login`, `/invite/[token]`, and `/` (redirects to `/command`)
- `(app)/command`, `(app)/brief`, `(app)/brief/[campaignId]`, `(app)/calendar`, `(app)/vault`, `(app)/approvals`
- `(app)/clients` and `(app)/clients/[clientId]`, with tabs for brand voice, visual style, banned words, accounts and approval chain
- `(app)/admin/users`

`(app)` is a client-side `AuthGate`.

**Components:**
- Brand and identity:
  - `brand/Logo`: an SVG "ENMO" wordmark with a green notch on the O
  - `agent/AgentAvatar`: monogram plus a green pulse dot
  - `agent/AgentSignature`: name and timestamp, in mono
- `post/PostCard`:
  - variants `full`, `compact` and `thumb`, reused in chat, the queue and the kanban
  - contains a 9:16 PostPreview (shimmer while rendering), a caption excerpt, PlatformChips, a StatusPill, and Approve / Edit / Request Changes actions
  - gets a green border once approved
- Other post components: `post/StatusPill` (mono, 11px), `RequestChangesDialog` (verbatim text plus a Copy/Visual/Both target), `CopyEditor` (inline banned-word warnings), `PostDetailDrawer`
- Chat: `chat/{MessageList, Composer, ClarifyCard, PlanCard (summary, posts, estimate vs budget), ProgressFeed, ApproveAllBar}`
- Screens:
  - `approvals/*`, `kanban/PipelineKanban` (7 columns)
  - `calendar/MonthGrid`: dnd-kit, draggable only when SCHEDULED; ghost slots are dashed at 40% opacity
  - `vault/{AssetGrid, AssetDrawer}`
  - `clients/{BrandVoiceForm, VisualStyleEditor, BannedWordsEditor, ApprovalChainEditor, ConnectedAccounts}`
  - `dashboard/{AlertsPanel, LearningsFeed, GrowthTiles}`, with SVG charts (no chart library)
- `ui/*`: Button, Input, Textarea, Select, Dialog, Tabs, Skeleton, EmptyState ("The Arsenal is idle. Give it a brief." with one green CTA), Toast, Sidebar, and a Topbar showing the budget meter and MOCK/DRY-RUN chips

**Theme** (`globals.css`, Tailwind v4 `@theme`):
- Colours:
  - `--color-void #060606`, `--color-panel #0C0C0D`, `--color-enmo #4ADE80` (**used for actions only**), `--color-paper #F5F5F4`, `--color-steel #8B8B90`
  - `--color-line: rgb(245 245 244 / 0.08)`
  - platform colours: IG `#C13584`, FB `#5B7FF0`, TikTok `#25F4EE`
- Fonts: display Space Grotesk, body Inter, mono JetBrains Mono
- Motion: `--ease-enmo: cubic-bezier(.2,.8,.2,1)`, transitions of 200–300ms, and `agent-pulse` and `shimmer` keyframes. Nothing bounces.

**Data layer:**
- `lib/api.ts`: fetch with `credentials: "include"` against `NEXT_PUBLIC_API_URL`, typed with the shared DTOs. A 401 redirects to `/login`.
- TanStack Query hooks, with optimistic approve and reschedule.

**OpenNext:**
- `images.unoptimized: true`
- `open-next.config.ts` is `defineCloudflareConfig()`
- `wrangler.jsonc`:
  - `main: worker.ts`, `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`, assets in `.open-next/assets`
  - the `app.enmo.marketing` custom domain
  - cron `*/5 * * * *`, with `vars.KEEPALIVE_URL`
- Scripts: `build:cf` (`opennextjs-cloudflare build`), `preview`, `deploy`.

## H. Deploy, env, CI, tests
**`render.yaml`:**
- An `enmo-shared` env group:
  - `DATABASE_URL` (from `enmo-db`), plus `REDIS_URL`, `ANTHROPIC_API_KEY` and `TOKEN_ENC_KEY` (all `sync:false`)
  - `ANTHROPIC_MODEL=claude-sonnet-5`, `LLM_PROVIDER=anthropic`, `DAILY_TOKEN_CAP`, `PUBLISH_MODE=dry-run`, `VISUAL_PROVIDER=mock`, `STORAGE_DRIVER=r2`
  - the R2, Meta, TikTok and Higgsfield variables
- Web service `enmo-api`:
  - build: `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm turbo run build --filter=@enmo/api...`
  - pre-deploy: `prisma migrate deploy`
  - start: `node apps/api/dist/server.js`
  - health check at `/healthz`; `EMBEDDED_WORKER=false`, `APP_ORIGINS`, `COOKIE_DOMAIN=.enmo.marketing`; domain `api.enmo.marketing`
- Worker `enmo-worker`: start command `node apps/api/dist/worker.js`.
- Database `enmo-db`: Postgres 16.
- A comment explains the free-tier fallback: drop the worker service and set `EMBEDDED_WORKER=true`.

**`.env.example` files:**
- `apps/api`:
  - server: PORT=4000, APP_ORIGINS, COOKIE_DOMAIN, COOKIE_SECURE, SESSION_TTL_DAYS
  - data: DATABASE_URL, REDIS_URL, BULLMQ_PREFIX, EMBEDDED_WORKER, SCHEDULERS_ENABLED
  - LLM: LLM_PROVIDER, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, DAILY_TOKEN_CAP, AGENT_CONCURRENCY, MEDIA_CONCURRENCY, PIPELINE_ACTIONS, MOCK_LLM_FAULTS
  - visuals: VISUAL_PROVIDER, HIGGSFIELD_*, FFMPEG_PATH
  - storage: STORAGE_DRIVER, STORAGE_LOCAL_DIR, PUBLIC_ASSET_BASE_URL, R2_*
  - publishing: PUBLISH_MODE, META_*, TIKTOK_*
  - secrets and seed: TOKEN_ENC_KEY, SEED_ADMIN_*
- `apps/web`: `NEXT_PUBLIC_API_URL`.
- `packages/db`: `DATABASE_URL`.

Env is loaded with `node --env-file-if-exists=.env`.

**CI** (`.github/workflows/ci.yml`):
- Job `verify`, with postgres:16 and redis:7 services, runs:
  1. install
  2. lint and typecheck
  3. `migrate deploy`
  4. `turbo test`
  5. `turbo build`
  6. `build:cf`
  7. `smoke-api`
- Job `web-e2e` runs Playwright on Chromium. CI runs `playwright install` itself; that never happens locally.

**`scripts/services.sh up|down|status|env`:**
- Postgres goes into `/tmp/enmo-pg` on port 54329, started with `runuser -u postgres` when running as root, with `fsync=off`. It creates the `enmo_dev` and `enmo_test` databases.
- Redis runs on port 63799 with noeviction.
- If either binary is missing, it falls back to `docker-compose.dev.yml`.

**Test layers:**
- **Unit tests** (vitest): contracts, the graph validator, runner retry and escalation, banned words (including Arabic), script timing, crypto round-trip and tampering, the RBAC matrix, the chain walk, the slot optimizer (including timezones), scoring and lift, the progress formatter, and provider request shapes via a fake `fetch`.
- **Integration tests** (`apps/api/test/integration`):
  - no file parallelism; `migrate deploy` runs on `enmo_test`, and every table is truncated between tests
  - `app.inject` against real Postgres and Redis
  - SSE replay is tested over a real port
- **Pipeline e2e** (`apps/api/test/e2e/phaseN.*`): `startHarness()` wires up the app plus in-process workers, MockLlm, MockProvider, a temporary LocalStorage, dry-run publishers and a FakeClock. Scheduler ticks are called directly, and `waitFor(predicate)` polls the database.
- **Contract fakes:** small Fastify servers for Meta Graph, TikTok and Higgsfield. They run the **real** provider code and record the call sequence.
- **Playwright 1.56.1** (`apps/web/e2e/phaseN.spec.ts`): `webServer` starts the API with tsx (embedded worker, mock LLM) and the web app with `next build && next start`.

## I. Parallel-unit file ownership (Step B)
- **Rule:** B-units never edit `schema.prisma`, `package.json` files, the lockfile, `packages/shared/src/index.ts`, `routes/index.ts`, `jobs/registry.ts`, `deps.ts` or the Sidebar. Step A creates stubs for all of those.
- **Phase 1:**
  - U1: `plugins/{auth,rbac,security}`, `services/{auth,sessions,invites,users,audit}`, `routes/{auth,users,invites}`, `scripts/create-admin`, and their integration tests
  - U2: `lib/crypto`, `services/{clients,social-accounts}`, `routes/{clients,social-accounts,capabilities,health}`, and their tests
  - U3: `web components/ui/*`, `brand/Logo`, `StatusPill`, `AgentAvatar`, `lib/{api,query-client,auth}`, pages for login, invite, clients, admin/users and the command shell, plus `e2e/phase1`
  - U4: `render.yaml`, CI, tsup config, `smoke-api`, docker-compose, README
- **Phase 2:**
  - U1: `packages/agents` (runner, anthropic, mock, prompts and definitions for manager and copywriter, validators)
  - U2: `orchestrator/*`, `jobs/{connection,queues,schedulers}`, processors `manager-intake`, `manager-plan`, `task-run`, `tick-sweeper`, `tick-prune`, `realtime/publisher`, `services/{budget,approvals,campaigns}`, embedded worker mode (`jobs/runtime.ts`)
  - U3: `routes/{campaigns,threads,task-graphs,posts,approvals,events,budget,agent-tasks}`, `realtime/{hub,sse}`
  - U4: `web (app)/brief/**`, `chat/*`, `post/{PostCard,PlatformChips,RequestChangesDialog,CopyEditor}`, `lib/realtime`, basic kanban, AlertsPanel, `e2e/phase2`
- **Phase 3:**
  - U1: `providers/{visual,storage,imaging/placeholder}`
  - U2: Visual Director agent files, processors `render-submit`, `render-poll`, `visual-review`, `orchestrator/visuals`, `services/assets`
  - U3: `routes/{assets,files}`, `agent-tasks` resolve, post detail
  - U4: web vault, `PostPreview`, `PostDetailDrawer`, `e2e/phase3`
- **Phase 4:**
  - U1: `providers/{publish/meta,publish/dry-run,oauth/meta}` and the fake Graph server
  - U2: `publishing/*`, processors `publisher-schedule`, `publish-run`, `publish-poll`, `tick-publish`, `tick-tokens`, Publisher agent files
  - U3: `routes/{calendar,publish-jobs,oauth-meta}`
  - U4: web calendar, approvals, ConnectedAccounts, `e2e/phase4`
- **Phase 5:**
  - U1: `providers/{publish/tiktok,oauth/tiktok}`, `routes/oauth-tiktok`, the TikTok token hook, the fake TikTok server
  - U2: `imaging/adapt`, Adapter agent files, `adapt-render`, `orchestrator/variants`
  - U3: the full `visual/higgsfield`, `VideoAssembler`, the fake Higgsfield server
  - U4: web variant tabs and carousel, TikTok connect, `e2e/phase5`
- **Phase 6:**
  - U1: `providers/metrics/*`, `learning/{metrics,baseline,scoring}`, processors `metrics-pull` and `tick-metrics`
  - U2: Analyst and Strategist agent files, `learning/features`, `orchestrator/strategy`, `analyst-client`, `tick-analyst`
  - U3: `services/dashboard/*`, `routes/dashboard`
  - U4: web command center, `e2e/phase6`

## J. Full pin table
Pinned versions:
- **Runtime and tooling:** node 22.22.2, pnpm 10.33.0, turbo 2.11.3, typescript 6.0.3, zod 4.6.5
- **Web:** next 16.3.6, react and react-dom 19.3.0, @opennextjs/cloudflare 1.20.6, wrangler 4.137.0, tailwindcss and @tailwindcss/postcss 4.3.3, @tanstack/react-query 5.103.2, @dnd-kit/core 6.3.1
- **API:** fastify 5.12.5, @fastify/cookie 11.1.2, @fastify/cors 11.3.0, @fastify/rate-limit 11.2.0, @fastify/static 10.1.4, fastify-type-provider-zod 7.0.0
- **Data:** prisma, @prisma/client and @prisma/adapter-pg 7.10.0, pg 8.23.0, bullmq 6.3.8, ioredis 5.11.1
- **Services and media:** @anthropic-ai/sdk 0.128.0, @node-rs/argon2 2.2.1, sharp 0.35.4, @aws-sdk/client-s3 3.x, date-fns 4.4.0, @date-fns/tz 1.5.0
- **Build, test and lint:** pino 10.3.1, tsup 8.5.1, tsx 4.23.15, vitest 5.0.1, @playwright/test 1.56.1, eslint 9.39.5, typescript-eslint 8.70.1, eslint-config-next 16.3.6, prettier 3.9.9
- **Fonts:** @fontsource-variable/{space-grotesk,inter,jetbrains-mono} 5.3.0

Step A of Phase 1 re-checks each one with `npm view` before writing `package.json`.
