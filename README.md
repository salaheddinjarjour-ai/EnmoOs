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
| 2 · First words    | Brief chat, Manager intake/plan, task graph, BullMQ, Copywriter, approvals (text only)                                                                                                 | Brief → caption drafts → approve in the UI             | **Done** |
| 3 · Eyes           | Visual provider abstraction + MockProvider, Visual Director, Vault, asset versioning                                                                                                   | Brief → approvable post card with a placeholder visual | **Done** |
| 4 · Go live (Meta) | Meta Graph publishing, Publisher agent, Calendar + slot optimizer, Approvals Queue                                                                                                     | An approved post publishes itself to IG/FB             | **Done** |
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
  Admin → Users. Calendar, The Vault and the Approvals Queue are labelled placeholders until their
  phases land.
- **Ops.** `GET /healthz` (liveness) and `/readyz` (Postgres + Redis). `render.yaml` defines the
  API, the worker and Postgres. `wrangler.jsonc` and `worker.ts` define the Cloudflare Worker with
  its keep-alive cron. CI runs lint, typecheck, test, build, `build:cf`, the smoke test and
  Playwright.

### Phase 2: what works today

A chat brief becomes approved caption drafts, text only, end to end.

- **The Brief (chat).** Start a campaign from **The Brief** with one message, optionally picking the
  client ("Ramadan campaign for the coffee client, 12 posts, push the iced line"). The Manager reads
  the whole thread and asks at most **one** consolidated clarifying question, naming every gap at
  once. After that the intake runs under a brief-only contract, so remaining gaps become written
  assumptions on the locked brief and a second question is impossible (`Campaign.clarifyCount`).
- **Plan before spend.** The Manager turns the brief into a task graph (write → QA per post for
  now, `PIPELINE_ACTIONS=write,qa`). Code validates the graph (acyclic, one node per action per
  post, mix, platforms and dates inside the window) and prices it: the plan card shows the summary,
  every planned post, and a token and dollar estimate against today's remaining budget. Nothing is
  generated until a MANAGER or ADMIN approves the plan. Anyone can request changes: the note is
  passed to the Manager verbatim and comes back as version n+1, and the old version is marked
  superseded.
- **Drafting.** Approving creates the posts and their agent tasks in one transaction. The task
  graph is scheduled from Postgres, and each ready task runs as a BullMQ `task.run` job on the
  `agents` queue. The Copywriter answers in strict JSON checked against its contract (the right
  shape per post type, scene timing, hook by 3s, caption and hashtag limits, one caption per
  platform, no banned words). An invalid reply gets two corrective retries with the zod issues fed
  back, then escalates. Every attempt is an `AgentRun` row, and tokens are counted per UTC day.
- **QA and approval.** Manager QA reviews each draft with the automated checks and may send it
  back once for an automatic revision (`MAX_QA_REVISIONS`). A draft that still uses a banned word
  never reaches a person. Passing drafts open an approval round against a snapshot of the client's
  chain, and a post card lands in the thread.
- **Live progress.** `GET /v1/events` streams over SSE: one progress line per plan updated in place
  (`Copywriter ✓ 12/12 …`), agent status, post cards, approvals and alerts. Reconnecting with
  `Last-Event-ID` replays what was missed (up to 500 events, then a `resync`).
- **Review.** Each card has Approve, Request Changes and Edit. Decisions follow the client's
  approval chain. Request Changes passes the reviewer's words byte-for-byte to the Copywriter's
  revision (recorded in `AgentRun.inputSnapshot`), and the revised draft returns through QA as
  round 2. The copy editor flags banned words as you type, the API refuses them with a 422, and an
  edit reopens approval with a new round. **Approve all** (MANAGER and ADMIN) approves the current
  step of every post waiting on you in one click. It never skips a chain step, writes one
  `approval.approve_all` audit row, and marks each decision as made through it.
- **When something goes wrong.** An agent that can't meet its contract escalates: the task is
  ESCALATED, the post is flagged, the Manager posts an escalation in the thread, an alert goes out,
  and a MANAGER or ADMIN can retry it. Once `DAILY_TOKEN_CAP` is reached, tasks wait in
  `BLOCKED_BUDGET` with a budget alert. The sweeper (every 5 minutes) re-queues a stuck task once
  before failing it, and resumes budget-blocked tasks after the UTC day rolls over. A daily prune
  removes week-old realtime events and expired sessions. Archiving a campaign cancels its
  unfinished work.
- **Web.** The Brief lists campaigns by client and runs the thread with its cards (clarifying
  question, brief, plan, live progress, post cards, escalations) and the sticky approve-all bar.
  Each client tab in the Command Center shows its posts on the 7-column pipeline kanban with an
  Alerts panel. The Topbar shows today's token budget and whether live updates are connected.

**Mocked, dry-run or not there yet (as of Phase 2).**

- The agents run on the deterministic **MockLlm** unless `ANTHROPIC_API_KEY` is set
  (`LLM_PROVIDER=mock` is the default and shows as a Topbar chip). It reads post counts, platforms
  and date phrases with heuristics and goes through the same runner, validation and retries as the
  real client. `MOCK_LLM_FAULTS` injects faults and `MOCK_LLM_DELAY_MS` adds latency for demos. The
  Anthropic client is written against the real Messages API (streaming, structured JSON output,
  adaptive thinking, prompt caching), but so far it has only been tested against a fake `fetch`.
- Text only. There are no visuals until Phase 3: the card preview is a text-only 9:16 frame in the
  client's palette, and Request Changes can only target Copy.
- Approved is not yet published. Approved posts show the SCHEDULED pill, but publishing jobs,
  slots and the Calendar arrive in Phase 4, so a campaign stays PRODUCING. `VISUAL_PROVIDER=mock`
  and `PUBLISH_MODE=dry-run` remain the defaults.
- The Alerts panel is assembled in the browser from the budget, flagged posts and live alert
  events; the dashboard alerts endpoint arrives in Phase 6. The Strategist joins the pipeline in
  Phase 6. Calendar, The Vault and the Approvals Queue are still placeholders.
- Social accounts are connected only by pasting a token. Meta and TikTok OAuth arrive in Phases 4
  and 5. "Check" can't ask the platform yet, so it only verifies decryption and expiry.
- Nothing has been deployed: there are no Render, Cloudflare, Upstash or R2 credentials. The deploy
  config builds (`build:cf`, `turbo build`, and `smoke-api` boots the bundle) but hasn't been run
  against real accounts.
- The login limit counters are kept in memory by each API process. That's correct for the single
  `enmo-api` instance in `render.yaml`. If the API is ever scaled out, give `@fastify/rate-limit`
  the Redis client (`apps/api/src/plugins/security.ts`).

### Phase 3: what works today

A brief now ends in approvable post cards that carry a visual. The Visual Director directs and
reviews each one; for now the renders are branded placeholders.

- **The pipeline.** `PIPELINE_ACTIONS=write,direct,qa` is the new default: write, then direct,
  then QA for each post. The Visual Director turns the post's script scenes, carousel slides or
  on-screen text into a shot list: one shot per scene or slide, each a 9:16 master (1080×1920)
  that Phase 5's Adapter crops to 4:5 and 1:1 for the feeds. Each shot gets a provider prompt, a
  negative prompt, a camera note and a seed. Clip lengths stay within what the provider can
  render. Its output is checked like every agent's: one shot per place, the right aspect ratios,
  no banned words anywhere, and two corrective retries before it escalates.
- **Renders.** Each shot becomes an `Asset` and a `render.submit` job on the `media` queue.
  `render.poll` asks the provider how the job is doing. The first poll waits
  `RENDER_POLL_DELAY_MS`, later ones back off to 10 s, and it gives up after 90 polls. The
  finished file is downloaded into Storage (`clients/<clientId>/assets/<assetId>.png`), measured
  and marked READY. The direct task waits (`WAITING`) until every shot has an accepted take.
- **Review and regeneration.** The Visual Director reviews every take by looking at the render
  itself, sent as an image scaled to a 1568 px long edge. A weak take is rendered again from the
  revised prompt as the next version of the same lineage (`parentAssetId`, `rootAssetId`,
  `version`, and `isCurrent` moves to it). That happens at most `MAX_VISUAL_REGENERATIONS` (2)
  times. After that the task escalates: the Visual Director signs the escalation in the thread,
  the post is flagged, and a MANAGER or ADMIN chooses **Accept best take** (each shot keeps its
  highest-scored take) or **Retry**. If the provider refuses a render, the task escalates; if the
  render fails or times out, the task fails with an alert (the take's status and the task's
  hand-off commit together). The sweeper re-drives renders and reviews whose jobs were lost, for
  the takes someone still waits on, and hands on a task whose failed take never reached it. A
  review stopped by the token budget resumes after UTC midnight.
- **Approval.** QA sees each post's current takes with their review scores and can send the
  visuals back (`direct → qa`). An approval round's content hash covers the copy and the ids of
  the current assets, so a new take means a new round. Request Changes can target Copy, Visual or
  Both. Visual re-runs `direct.rN → qa.rN`, and Both re-runs write → direct → QA. Each agent
  receives the reviewer's words verbatim. The takes follow the copy, one per scene or slide: a
  Copy revision whose rewrite adds or drops a slide or scene gets `direct.rN` spliced in after
  its write, a hand edit that does the same goes back through the Visual Director and QA, and
  QA's `shots` check never lets a round open on takes that don't fit the copy.
- **The Vault.** `GET /v1/assets` lists every take, newest first and keyset-paginated. It shows
  current versions unless you ask for all of them. `q` searches the prompt, the campaign name and
  the shot id; filters cover client, campaign, post, scene and kind. `GET /v1/assets/:id` returns
  the take with its whole lineage. `POST /v1/assets/:id/regenerate {instruction?}` creates the next
  version and gives the Visual Director the take's original context back: the shot, the post's
  copy and the brand, plus the instruction verbatim. The new take is on trial: it goes through
  the same review loop (a weak one is regenerated at most twice, then escalated) and becomes
  current only once the Visual Director accepts it, so the post keeps its take meanwhile. On a
  planned post the regenerate runs as a revision: open or approved rounds are cancelled, and QA
  opens a new round once the new take is accepted. Outside any plan, a take that stays weak is
  set aside with an alert.
- **Files.** With `STORAGE_DRIVER=local` the API serves Storage at `GET /files/*`. The route is
  public, caches immutably and supports byte ranges. It answers only canonical storage keys and
  gives a 404 for anything else, including every traversal attempt. `STORAGE_DRIVER=r2` is
  implemented for production.
- **Providers.** `createVisualProvider` (`packages/providers/src/visual/index.ts`) switches on
  `VISUAL_PROVIDER`. Adding a provider means one file and one `case`. Provider calls and render
  downloads go through the injected `deps.fetch`.
- **Web.** Post cards show the first shot's take at the post type's shape (a carousel shows its
  first slide and the slide count). The card shimmers while the take renders. The post drawer
  lists each shot's current take and links to it in the Vault. **The Vault** shows a grid of
  current takes with search, filters, infinite scroll and an all-versions toggle. Its drawer has a
  large preview, the version timeline, the prompt and camera note, the provider, and the review's
  verdict and score. It also has **Regenerate** with an optional instruction: the new version
  shimmers at once and swaps in live when it is ready. The Visual Director's escalations offer
  Accept best take next to Retry.

**Mocked, dry-run or not there yet (as of Phase 3).**

- `VISUAL_PROVIDER=mock` is the default. MockProvider renders a branded placeholder PNG with
  sharp: a gradient in the client's palette, the headline in the brand's display font, the start
  of the prompt, and a `MOCK · s2 · v1` footer. Outputs are 1080×1920, 1080×1350 or 1080×1080. It
  reports success on its second poll. A VIDEO shot comes back as a poster PNG only
  (`params.mockVideo=true`), so there is no real clip.
- The HiggsfieldProvider is written against Higgsfield's REST API (submit, status and cancel,
  with `Authorization: Key id:secret`). `phase3.provider-swap` runs the whole pipeline with
  `VISUAL_PROVIDER=higgsfield` against an in-memory Higgsfield behind the injected fetch. It has
  never called the real service, because there are no credentials. Its request fields are checked
  again against the fake Higgsfield server in Phase 5, which also brings multi-scene video
  assembly (ffmpeg).
- R2 storage has only been tested against a local S3-compatible server. There are no R2
  credentials yet.
- The Visual Director runs on MockLlm. Its shot lists come from templates, and its review reads
  the PNG's dimensions and accepts takes in the right aspect ratio. `MOCK_LLM_FAULTS` can make it
  misbehave, for example `VISUAL_DIRECTOR.review:weak*3`.
- Approved posts are still not published (Phase 4). The Adapter's per-platform variants arrive in
  Phase 5, so for now each post has one master visual per shot.

### Phase 4: what works today

An approved post now schedules and publishes itself: as a dry run by default, and live on
Instagram and Facebook through the Meta Graph API once a Meta app and the client's accounts are
connected.

- **Scheduling.** When a post's final approval commits, `publisher.schedule` creates one
  `PostVariant` per platform that takes the post type (its caption from the copy's platform
  caption) and asks the slot optimizer for each variant's top 5 candidates. The optimizer scores
  hourly slots in the client's own time zone (DST-safe): the platform's best-time prior (Instagram
  weekdays 11–13 and 19–21, Facebook weekdays 9–13, TikTok evenings with Tuesday and Thursday
  peaks) blended with the client's learned `SlotScore`. It keeps inside the campaign window, at
  least 30 minutes from now, 4 hours apart and at most 2 a day per client and platform, and prefers
  the plan's target date ±1 day. The **Publisher** agent picks among the candidates; if it fails,
  each variant takes the top candidate (`slotSource=optimizer`), never an escalation. The payload
  and banned words are checked before a slot is spent. Each job is written `SCHEDULED` under a
  per-client lock, so posts approved together never share a slot. The post goes `SCHEDULED` and
  the Publisher signs a note in the thread. A post no platform can take (no visuals, say) stays
  approved, flagged, with an alert.
- **Publishing.** `tick.publish` (every minute) queues due jobs. `publish.run` re-checks the
  publish guard under the same locks an edit takes: the latest approval is APPROVED, its content
  hash still matches, no banned words, and the account's token is valid. Then it publishes through
  the dry-run or the Meta publisher and saves the platform's container as soon as it exists.
  Media still processing goes to `publish.poll` (every `PUBLISH_POLL_INTERVAL_SEC`, up to
  `PUBLISH_POLL_MAX_MIN`). Transient errors retry on the same container, up to
  `PUBLISH_MAX_ATTEMPTS`. The job ends `PUBLISHED` with its `liveUrl`, `externalId` and
  `publishedAt` (what Phase 6's metric pull-back reads), and the post goes `LIVE` once every
  variant is out. The tick also re-drives work a lost enqueue or a dead worker left behind.
- **Safety.** Any edit after approval (copy, a visual revision, a regenerated take) cancels the
  post's waiting jobs and reopens approval; re-approval schedules the same job rows again. At the
  slot, a job whose approval no longer stands, whose content changed or that uses a banned word is
  `CANCELLED` before any platform call, with an alert, and its approval reopens. A token problem
  (expired, revoked, missing publishing scopes) `FAILS` the job instead, marks the account and
  raises an alert, so it can be retried once the account is reconnected.
- **Meta.** `MetaPublisher` (Graph `v26.0`) posts Instagram images, reels, stories and carousels
  through containers (checking `content_publishing_limit` first, polling `status_code`, then
  `media_publish` and the permalink), and Facebook photos, multi-photo posts (unpublished photos,
  then one `feed` post), reels (`video_reels` start, `rupload` with `file_url`, finish) and photo
  or video stories. Tokens travel in the `Authorization` header with an `appsecret_proof`. The
  progress record in `PublishJob.containerId` lets a retry resume exactly where it stopped, so
  nothing is created twice. Graph errors map to AUTH, RATE_LIMITED, UNAVAILABLE, MEDIA_FAILED or
  REJECTED.
- **Meta OAuth.** An ADMIN's **Connect Meta** (`GET /v1/oauth/meta/start`) sends the browser to
  Meta's consent dialog with a one-time state (and PKCE) bound to the session in Redis for 10
  minutes. The callback exchanges the code, swaps it for a long-lived token, reads the granted
  scopes with `debug_token`, and stores one `SocialAccount` per Page and per linked Instagram
  account with AES-256-GCM encrypted Page tokens. `tick.tokens` asks `debug_token` about every
  Meta account once a day: a revoked token marks the account REVOKED, a lapsed one EXPIRED, each
  with an alert, and tokens expiring within 7 days get a warning. "Check" on an account asks Meta
  too.
- **Calendar** (`GET /v1/calendar`). A month grid across all clients (or one), with each job on
  its client-local day in its platform's colour, its thumbnail and time, and ghost slots (dashed,
  40% opacity) for planned posts that have no job yet. MANAGERs and ADMINs drag a scheduled job
  to another day (`PATCH /v1/publish-jobs/:id {date}`): the optimizer picks that day's best free
  hour, with no LLM call, and records `slotSource=manual`. The move shows at once and snaps back
  with the reason if the day is full. The event dialog offers the same move by keyboard, plus
  Retry for a failed job and Cancel. LIVE events link to the live post, and the grid updates
  live over SSE.
- **Approvals Queue.** Everything waiting on a person across all clients, newest first, filtered
  by client, platform and campaign in the address. Each tile is the post's thumbnail with Approve
  and Request changes; MANAGERs and ADMINs tick tiles (or "Select all") and approve them in one
  confirmed, logged batch.
- **Web.** Post cards and the drawer show each platform's publish state, time, DRY RUN tag and
  live link. The client's Accounts tab lists connected accounts with their source, status, token
  expiry and missing permissions, and has Connect Meta.

**Mocked, dry-run or not there yet (as of Phase 4).**

- `PUBLISH_MODE=dry-run` is the default: jobs run the same payload validation and "publish" to
  `https://dryrun.enmo.marketing/<platform>/<variantId>`. The Meta publisher and OAuth have only
  run against the fake Graph server in `apps/api/test/fakes/meta-graph.ts`, which records the call
  sequence the tests assert. There is no Meta app yet. Without `META_APP_ID` and
  `META_APP_SECRET`, Connect Meta is disabled and `/v1/oauth/meta/start` answers 503.
- The Publisher agent runs on MockLlm, which picks each variant's top candidate. The best-time
  priors are industry heuristics until Phase 6's metrics fill `SlotScore`; weekends have no peaks.
- Live publishing needs public HTTPS media URLs (R2). Local storage only works with a Graph on the
  same machine, which is what the tests use.
- Every variant still publishes the 9:16 master (the Adapter's native crops arrive in Phase 5),
  and a reel publishes its first clip until the VideoAssembler lands (MockProvider's video is a
  poster PNG anyway). TikTok jobs stay dry runs until Phase 5.
- A job a teammate cancels stays cancelled: the calendar shows its platform as a ghost again, and
  it is scheduled again only through a new approval round.
- Metrics pull-back, scoring and the Analyst arrive in Phase 6; `publishedAt` and `externalId` are
  already stored for them.

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
    src/        config.ts (all env), app.ts, deps.ts, plugins/, routes/, services/, orchestrator/,
                jobs/ (queues, processors, schedulers), realtime/ (publisher, SSE hub), lib/
    test/       integration (real Postgres + Redis, app.inject), e2e (pipeline harness), helpers
  web/          @enmo/web     Next.js 16 → Cloudflare Workers via @opennextjs/cloudflare
    src/        app/ (routes), components/, hooks/ (TanStack Query), lib/ (api client, auth)
    e2e/        Playwright specs, phase1.spec.ts …
    worker.ts   Worker entry: OpenNext handler + keep-alive cron
packages/
  shared/       @enmo/shared  zod enums + DTOs, RBAC matrix, approval-chain walk, status maps (no Node deps)
  db/           @enmo/db      Prisma 7 schema + migrations, createPrisma(), seed, test helpers
  agents/       @enmo/agents  agent runner, Anthropic + MockLlm clients, prompts, definitions, validators
  providers/    @enmo/providers  visual providers (mock, Higgsfield), storage (local / R2), imaging; publishers, OAuth, metrics later
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
"The Arsenal is idle. Give it a brief." Go to **Clients → New client** to set up a brand, then
brief a campaign in **The Brief**. With the mock LLM the Manager answers within seconds;
`MOCK_LLM_DELAY_MS` in `apps/api/.env` (300 in the example) paces the agents so you can watch the
progress arrive.

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
pnpm --filter @enmo/api test:integration           # test/integration + test/e2e against enmo_test
pnpm --filter @enmo/shared test
pnpm --filter @enmo/web test                       # web unit tests (pure modules, e.g. safe redirects)
pnpm --filter @enmo/db test                        # schema drift + seed, in enmo_test_dbpkg (needs services)

pnpm --filter @enmo/web test:e2e                   # Playwright, all specs
pnpm --filter @enmo/web test:e2e -- phase2         # one phase

pnpm --filter @enmo/api build && node scripts/smoke-api.mjs   # boot the bundle: /healthz, /readyz
pnpm --filter @enmo/web build:cf                   # OpenNext build for Cloudflare Workers
pnpm format:check
```

- **Test databases.** Integration tests use `TEST_DATABASE_URL` (default: local `enmo_test`). They
  run `prisma migrate deploy` once, then truncate every table before each test. They refuse any
  database whose name lacks `test` or `e2e`. `@enmo/db` uses its own `enmo_test_dbpkg`, so both
  suites can run in parallel under turbo.
- **Pipeline e2e.** `apps/api/test/e2e/phaseN.*` run in the integration project through
  `startHarness()`: the app listening on a free port, in-process BullMQ workers on a unique queue
  prefix, the MockLlm and a FakeClock. The SSE stream is read over the real port, scheduler ticks
  are called directly, and `waitFor` polls the database. `phase2.brief-to-approval` is the Phase 2
  exit test; `phase2.faults` covers `MOCK_LLM_FAULTS` and `DAILY_TOKEN_CAP`. The harness also uses
  MockProvider and a temporary LocalStorage. `phase3.brief-to-visual` is the Phase 3 exit test.
  `phase3.visual-loop` covers feedback routing, provider failures, the sweeper and the budget.
  `phase3.provider-swap` runs the pipeline on Higgsfield against a fake behind the injected fetch.
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
| `BULLMQ_PREFIX`          | `enmo`                                           | Key prefix for every queue and the realtime pub/sub channel (`<prefix>:rt`). Tests use a unique one.              |
| `BULLMQ_DRAIN_DELAY_SEC` | `20` in production, else `5`                     | Seconds an idle worker blocks waiting for jobs. The production default keeps Upstash command costs down.          |
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
| `PIPELINE_ACTIONS`        | `write,direct,qa`                                      | Comma list of per-post actions the Manager may plan, from `strategy`, `write`, `direct`, `adapt` and `qa`. It widens phase by phase. |
| `MAX_QA_REVISIONS`        | `1`                                                    | Automatic Manager QA revisions per post (0–3). After that the post goes to humans with the QA notes.                                 |
| `MOCK_LLM_FAULTS`         | none                                                   | MockLlm fault injection for tests, e.g. `COPYWRITER.write:invalid*2,VISUAL_DIRECTOR.review:weak*3`.                                  |
| `MOCK_LLM_DELAY_MS`       | `0`                                                    | MockLlm latency per call (0–60000 ms), so a local demo shows progress arriving live instead of all at once.                          |
| `AGENT_EFFORT_<AGENT>`    | per action                                             | `low`, `medium`, `high`, `xhigh` or `max` for every action of one agent, e.g. `AGENT_EFFORT_COPYWRITER=high`.                        |

**Visuals**

| Variable                   | Default                     | Purpose                                                                                                                                                   |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VISUAL_PROVIDER`          | `mock`                      | `mock` (sharp-rendered branded placeholders) or `higgsfield`.                                                                                             |
| `HIGGSFIELD_CREDENTIALS`   | none                        | The Higgsfield key as `<key id>:<key secret>`. `higgsfield` needs either this or both halves below, never both forms.                                     |
| `HIGGSFIELD_KEY_ID`        | none                        | The key id, if you set the halves separately.                                                                                                             |
| `HIGGSFIELD_KEY_SECRET`    | none                        | The key secret, if you set the halves separately.                                                                                                         |
| `HIGGSFIELD_BASE_URL`      | `https://api.higgsfield.ai` | API base URL. Tests override it with a fake server.                                                                                                       |
| `HIGGSFIELD_IMAGE_MODEL`   | none                        | Higgsfield model id for stills. `higgsfield` needs it: every post type has stills.                                                                        |
| `HIGGSFIELD_VIDEO_MODEL`   | none                        | Higgsfield model id for video. Optional: without it, reel and TikTok shots are stills too.                                                                |
| `FFMPEG_PATH`              | none                        | Enables multi-scene video assembly. Without it, the first clip is used.                                                                                   |
| `MAX_VISUAL_REGENERATIONS` | `2`                         | How many times (0–2) the Visual Director may regenerate a weak take of one shot, each as a new asset version, before it escalates. Lower it to save cost. |
| `RENDER_POLL_DELAY_MS`     | `3000`                      | Wait before the first `render.poll` after a submit (10–10000 ms). Later polls back off to 10 s. Tests shorten it.                                         |

**Storage**

| Variable                            | Default                                           | Purpose                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`                    | `local`                                           | `local` (disk, served by the API at `/files/*`) or `r2`. Production needs `r2`: Render's disk is ephemeral, and Meta and TikTok fetch media by public URL. |
| `STORAGE_LOCAL_DIR`                 | `.data/assets`                                    | Directory for the local driver, relative to the API's working directory.                                                                                   |
| `ALLOW_LOCAL_STORAGE_IN_PRODUCTION` | `false`                                           | With `NODE_ENV=production` the services refuse `local` unless this is `true`: only for a disk that survives deploys (the smoke test sets it).              |
| `PUBLIC_ASSET_BASE_URL`             | `$API_PUBLIC_URL/files`                           | Local driver only: the public base URL of `/files/*`. With `r2`, setting it is an error.                                                                   |
| `R2_ACCOUNT_ID`                     | none                                              | Cloudflare account id. All four `R2_*` credentials are required for `r2`.                                                                                  |
| `R2_ACCESS_KEY_ID`                  | none                                              | R2 API token access key.                                                                                                                                   |
| `R2_SECRET_ACCESS_KEY`              | none                                              | R2 API token secret.                                                                                                                                       |
| `R2_BUCKET`                         | none                                              | Bucket name. Production: `enmo-assets`.                                                                                                                    |
| `R2_ENDPOINT`                       | `https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com` | Override for tests or another S3-compatible store.                                                                                                         |
| `R2_PUBLIC_BASE_URL`                | `https://assets.enmo.marketing`                   | The bucket's public domain, which every R2 asset URL starts with.                                                                                          |

**Publishing**

| Variable                    | Default                                  | Purpose                                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLISH_MODE`              | `dry-run`                                | `dry-run` validates payloads and returns `https://dryrun.enmo.marketing/...` URLs. `live` really posts, but only on platforms whose app credentials are set and for clients with an account there. `live` with no platform credentials at all is refused. |
| `APP_PUBLIC_URL`            | the first `APP_ORIGINS` entry            | The web app URL the OAuth callback sends the browser back to.                                                                                                                                                                                             |
| `META_APP_ID`               | none                                     | Meta app id (OAuth, Graph API). Set it together with `META_APP_SECRET`.                                                                                                                                                                                   |
| `META_APP_SECRET`           | none                                     | Meta app secret.                                                                                                                                                                                                                                          |
| `META_GRAPH_VERSION`        | `v26.0`                                  | Graph API version.                                                                                                                                                                                                                                        |
| `META_GRAPH_BASE_URL`       | `https://graph.facebook.com`             | Graph base URL. Tests point it at a fake Graph server.                                                                                                                                                                                                    |
| `META_RUPLOAD_BASE_URL`     | `https://rupload.facebook.com`           | Facebook Reels upload host. Tests point it at the fake Graph server too.                                                                                                                                                                                  |
| `META_OAUTH_DIALOG_URL`     | `https://www.facebook.com`               | Host of the OAuth consent dialog.                                                                                                                                                                                                                         |
| `META_REDIRECT_URI`         | `$API_PUBLIC_URL/v1/oauth/meta/callback` | The OAuth redirect URI. It must match the one registered with the Meta app exactly.                                                                                                                                                                       |
| `PUBLISH_POLL_INTERVAL_SEC` | `10`                                     | Seconds between checks of media the platform is still processing (1–300).                                                                                                                                                                                 |
| `PUBLISH_POLL_MAX_MIN`      | `10`                                     | Minutes a publish may wait on that processing before it fails (1–1440).                                                                                                                                                                                   |
| `PUBLISH_MAX_ATTEMPTS`      | `3`                                      | Publish attempts per job, the first included, before it fails for good (1–10).                                                                                                                                                                            |
| `TIKTOK_CLIENT_KEY`         | none                                     | TikTok app client key.                                                                                                                                                                                                                                    |
| `TIKTOK_CLIENT_SECRET`      | none                                     | TikTok app client secret.                                                                                                                                                                                                                                 |
| `TIKTOK_API_BASE_URL`       | `https://open.tiktokapis.com`            | TikTok API base URL.                                                                                                                                                                                                                                      |
| `TIKTOK_APP_AUDITED`        | `false`                                  | Unaudited TikTok apps may only post `SELF_ONLY`. Set `true` once the audit passes.                                                                                                                                                                        |

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

| Host                    | Points to                               | Created by                                                                                 |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `app.enmo.marketing`    | Worker `enmoos` (custom domain)         | Workers → `enmoos` → Settings → Domains & Routes, or `routes` in `apps/web/wrangler.jsonc` |
| `api.enmo.marketing`    | `CNAME enmo-api.onrender.com`           | You, after Render lists the domain (`domains` in `render.yaml`)                            |
| `assets.enmo.marketing` | R2 bucket `enmo-assets` (custom domain) | R2 → bucket → Settings → Custom Domains                                                    |

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
   `HIGGSFIELD_CREDENTIALS` (or `HIGGSFIELD_KEY_ID` and `HIGGSFIELD_KEY_SECRET`),
   `HIGGSFIELD_IMAGE_MODEL` and `HIGGSFIELD_VIDEO_MODEL` to this group. The services refuse to
   boot without `TOKEN_ENC_KEY`, without the Anthropic key (because `LLM_PROVIDER=anthropic`), and
   without the R2 credentials (because `STORAGE_DRIVER=r2`; production refuses the local driver,
   whose files a deploy would wipe).

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

`apps/web/wrangler.jsonc` sets up the Worker `enmoos`:

- entry `worker.ts`, which is the OpenNext handler plus a keep-alive cron
- the flags `nodejs_compat` and `global_fetch_strictly_public`
- static assets from `.open-next/assets`
- the cron `*/5 * * * *`, which pings `KEEPALIVE_URL`

It serves on the Worker's `workers.dev` address. To put it on `app.enmo.marketing`, add the custom
domain under the Worker's _Settings → Domains & Routes_, or uncomment `routes` in `wrangler.jsonc`.

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

**Deploying from the Cloudflare dashboard (Workers Builds / Git integration).** The repo is a pnpm
monorepo, so the dashboard's defaults (`npm run build`, then `npx wrangler deploy` at the repo root)
fail: the root has no Wrangler config, and a plain `next build` doesn't produce the Worker. In the
Worker's _Settings → Build_, set:

| Setting        | Value                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| Root directory | `/` (the repo root, so pnpm installs the whole workspace)                       |
| Build command  | `pnpm --filter @enmo/web run build:cf`                                          |
| Deploy command | `pnpm --filter @enmo/web exec wrangler deploy`                                  |
| Build variable | `NEXT_PUBLIC_API_URL` = your API URL (defaults to `https://api.enmo.marketing`) |

- The Worker's name in the dashboard must match `"name"` in `apps/web/wrangler.jsonc` (`enmoos`,
  also used by the `WORKER_SELF_REFERENCE` service binding). If you rename the Worker, change both.
- The `app.enmo.marketing` custom domain needs the `enmo.marketing` zone in the same Cloudflare
  account and no existing DNS record for `app`.
- The web app only works end to end once the API is live: sign-in cookies are scoped to
  `.enmo.marketing`, so the web app and API must be served from `app.` and `api.enmo.marketing`.

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
