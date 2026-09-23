# ENMO OS — Master Plan (source spec)

_Extracted verbatim from `ENMO-OS-Master-Plan.docx`. This is the product spec; `docs/DESIGN.md` is the engineering design derived from it._

ENMO OS

The Autonomous Marketing Department

Master Plan · Internal PlatformGrow with Enmo · app.enmo.marketingEvery pixel has intent. Every post has a memory.

7 AI Agents (The Arsenal)   ·   3 Platforms (Instagram · Facebook · TikTok)   ·   Multi-Client Agency RBAC   ·   Closed-Loop Learning


---

**01 — VISION**

## From agency hours to agency intelligence.

Enmo sells craft. ENMO OS removes the repetitive 70% of content production — briefing, drafting, formatting, scheduling, reporting — so the team spends its hours on strategy and client relationships. It is not a tool. It is a department that never sleeps, never forgets what worked, and always waits for approval before it speaks for a brand.

"Strategy without execution is just a plan. ENMO OS is the execution." — built on the Enmo method: Discover, Strategize, Create, Optimize.

- Human-approved, always. Nothing publishes without passing the configured internal approval chain. The only shortcut is a logged one-click "approve all".
- Every client, one brain. Brand voice, banned words, visual style and performance history live per client. The Arsenal switches context as fast as you switch accounts.
- It gets smarter weekly. A closed loop pulls metrics, scores every post, and feeds learnings back into the next brief — hook styles, formats, timings, continuously optimized.

---

**02 — THE ARSENAL**

## Seven agents. One manager. Zero chaos.

Named after the Enmo services page. Each agent is a Claude system prompt with a strict contract — inputs, outputs, retries. The Manager orchestrates; specialists execute.


| Agent | Role | Contract |
|---|---|---|
| Manager | Orchestrator | Receives briefs, clarifies in ONE consolidated question, emits the JSON task graph, quality-checks output, routes approvals, schedules publishing. |
| Strategist | Think | Goals → angles, content pillars, hooks — informed by the client LearningLog and platform trends. |
| Copywriter | Write | Captions, scripts, on-screen text, CTAs. Emits strict JSON: scene-by-scene voiceover, overlay text, duration, hook timestamp. |
| Visual Director | Direct | Scripts → shot lists & provider prompts; character/style consistency; reviews renders, regenerates weak takes (max 2 retries, then escalates). |
| Adapter | Format | One master asset → 9:16 Reel/TikTok, 1:1 feed, 4:5 portrait, carousel slides with designed overlays. |
| Analyst | Learn | Weekly: pulls metrics, scores posts vs baseline, writes LearningLog takeaways, briefs the Strategist. |
| Publisher | Ship | Meta Graph API + TikTok uploads at optimal slots, token refresh, failure retries, confirms live URLs. |


### The lifecycle, end to end


| Stage | What happens | Output |
|---|---|---|
| Brief | You chat: "Ramadan campaign for the coffee client — 12 posts, push the iced line." Missing pieces → one consolidated question. | Brief object + scope |
| Plan | Manager emits a JSON task graph with plain-language summary. You approve the plan before generation spend. | Task graph |
| Create | Independent posts batch-parallelize as BullMQ jobs. Live progress in chat: "Copywriter ✓ — rendering 2/4…" | Script JSON → renders → variants |
| Review | Post cards land in the approval queue with preview, caption, platform chips, Approve / Request Changes. | ApprovalRequest per chain |
| Publish | Publisher ships at platform best-times, confirms live URL, logs timestamp for metric pull-back. | PUBLISHED + live URL |
| Learn | Analyst scores the post vs baseline, logs takeaway ("hooks under 1.2s outperform 3×"), flags it applied. | LearningLog → next Strategy call |


---

**03 — PRODUCT**

## Six screens. One command center.

Internal-only platform — the team approves; results are shared with clients over your own channels. No external logins, no client portal.


| Screen | Purpose |
|---|---|
| Command Center | Pipeline kanban per client (Idea → Draft → Visual → Approval → Scheduled → Live → Scored), failure/stuck alerts, growth metrics, weekly learnings feed. |
| The Brief (Chat) | Claude-style interface, one thread per campaign. Live agent status feed, plan cards, finished post cards with approve/edit, one-click "approve all". This is where you run the agency. |
| Calendar | Month view across all clients, color-coded by platform. Drag to reschedule; Publisher re-optimizes the slot. Ghost slots show planned pipeline. |
| The Vault | Every generated asset, versioned, searchable by prompt / campaign / scene. Regenerate any take — the Visual Director gets original context back. |
| Clients & Admin | Per-client brand voice, visual style tokens, banned words, connected accounts, configurable approval chain. RBAC: Admin / Manager / Editor. |
| Approvals Queue | Everything waiting on a human, across all clients, newest first. Filter by client, platform, campaign. Batch approve from thumbnails. |


---

**04 — DESIGN SYSTEM**

## Elite by default. Dark by identity.

The product should feel like the website: cinematic, intentional, black — a tool the team opens with the same pride clients feel seeing Enmo work.


| Token | Value | Use |
|---|---|---|
| Void Black | #060606 | Canvas |
| Panel | #0C0C0D | Surfaces |
| Enmo Green | #4ADE80 | Action only: agent pulses, approval buttons, success, live indicator |
| Paper | #F5F5F4 | Primary text |
| Steel | #8B8B90 | Secondary text |

- Type — Space Grotesk for display/headlines, Inter for body and UI, JetBrains Mono for agent names, job IDs, timestamps, status. The machines speak mono.
- Motion — 200–300ms eases, subtle hover rises, soft green pulse on agent activity, skeleton shimmer while rendering. Nothing bounces; everything lands.
- Agent identity — Each Arsenal member has a monogram avatar and green activity dot; agents sign their chat messages.
- Post card — The atomic unit: 9:16 preview, caption excerpt, platform chips, status pill, approve/edit. Reused in chat, queue, kanban.
- Status pills — Mono 11px, rounded: PLANNING · PENDING_APPROVAL · SCHEDULED · LIVE · LEARNED. Approved = green border.
- Empty states — Cinematic, never apologetic: "The Arsenal is idle. Give it a brief." with a single green CTA.

---

**05 — ARCHITECTURE**

## Cloudflare speed. Render muscle. Upstash memory.

One monorepo, two deploy targets. All secrets live on Render. All generation is async — nothing waits on a render.


| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 · Cloudflare Pages (next-on-pages) | Edge speed, free tier, app.enmo.marketing |
| Backend | Node + Fastify · Render | Type-sharing with frontend; AI calls are just HTTP |
| Queue | BullMQ + Upstash Redis (TLS) | Renders take minutes — jobs must be async & retryable |
| Database | PostgreSQL + Prisma | Multi-client relations, clean migrations |
| LLM | Anthropic API — Claude Sonnet | Best instruction-following for strict JSON contracts |
| Visuals | MockProvider (now) → HiggsfieldProvider (on access) | Pipeline ships today; swap is one file |
| Publish | Meta Graph API → TikTok API | Instagram + Facebook first; TikTok phase 5 |
| Realtime | SSE (Server-Sent Events) | Survives Cloudflare proxy, auto-reconnects, simpler than WS |


---

**06 — DATA FOUNDATION**

## The schema is the strategy.

Core entities: User (ADMIN / MANAGER / EDITOR) · Client (brandVoice, visualStyle, bannedWords, approvalChain JSON) · SocialAccount (encrypted tokens) · Campaign → Post (REEL / TIKTOK / CAROUSEL / STATIC / STORY) → Asset (provider, prompt, version) · ApprovalRequest + ApprovalDecision (walks the configurable chain; feedback routes verbatim to agents) · PerformanceMetric + LearningLog (engagement vs baseline, applied flag so insights surface once).


---

**07 — ROADMAP**

## Six phases. Ship the loop early.


| Phase | Weeks | Ships | Exit criteria |
|---|---|---|---|
| 1 · Foundation | 1 | Monorepo, Prisma schema, auth + RBAC, Client CRUD, dashboard shell on Cloudflare + Render | Log in, create a client, see dashboard |
| 2 · First words | 2 | Chat page, Manager prompt, task-graph parser, BullMQ, Copywriter — text-only end-to-end | Brief → caption drafts → approve in UI |
| 3 · Eyes | 3 | VisualProvider + MockProvider, Visual Director prompt, Vault page, asset versioning | Brief → approvable post card with placeholder visual |
| 4 · Go live (Meta) | 4 | Meta Graph API, Publisher agent, Calendar + scheduler, approval queue UI | Approved post self-publishes to IG/FB |
| 5 · Everywhere | 5 | TikTok API, Adapter agent, HiggsfieldProvider swap on access | One brief → three platforms, native formats |
| 6 · The loop | 6 | Metrics pull, Analyst agent, LearningLog, Strategist integration, growth dashboard v1 | Content visibly improves week-over-week |

Cut line under pressure: TikTok API waits — Meta covers two of three platforms. Meta app review starts in Phase 3 (it takes days and blocks Phase 4).


---

**08 — RISKS & DECISIONS**

## Decided. Logged. Moved on.


| Risk | Mitigation |
|---|---|
| Higgsfield API access unknown | MockProvider ships the whole pipeline without it; swap-in is one provider file |
| Render free tier sleeps | 5-min cron ping; upgrade $7/mo when clients live |
| Platform API approvals slow | Apply during Phase 3, not Phase 4 |
| Agent cost runaway | Max 2 retries, plan-approval before generation, Sonnet not Opus, daily token cap env var |


| Decision | Call | Why |
|---|---|---|
| Approvals | Internal only, configurable chain | Clients never touch the system; share results over your channels |
| Roles | ADMIN / MANAGER / EDITOR | Lean; add roles only when pain proves them |
| Backend language | Node | Type-sharing; all AI calls are HTTP anyway |
| Visual strategy | Provider abstraction, Higgsfield first | Add Ideogram/Flux later without touching agent code |


---

**09 — NORTH STAR**

## How we know it is working.


| Metric | Target / meaning |
|---|---|
| Brief → Live time | Under 48h for a 12-post campaign — the core promise |
| Approval pass rate | % approved with zero edits; rising rate = the loop learned your taste |
| Engagement vs baseline | System posts must beat account historical average by month 2 |
| Hours saved / client / month | The agency math — this number sells ENMO OS to your own team first |

ENMO OS · Master Plan · Grow with Enmo · app.enmo.marketing

