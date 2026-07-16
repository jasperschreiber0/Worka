# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
npm run dev          # start dev server (localhost:3000)
npm run build        # production build
npm run type-check   # tsc --noEmit — run this before every commit
npm run lint         # eslint
npm run test         # node --experimental-strip-types --test — pure-function unit tests only
```

Type-check is still the primary correctness gate. `npm run test` covers a narrow slice — pure,
dependency-free logic extracted from the document-processing pipeline (batch splitting, fact
merge/supersession, timeout decisions — see `supabase/functions/smooth-responder/pipeline-logic.ts`
and its `.test.ts`) plus `lib/project-context.ts`'s query-construction and context-assembly
contract tests (`lib/project-context.test.ts`) — the latter needs `allowImportingTsExtensions`
in `tsconfig.json` and a relative, `.ts`-suffixed import of `pipeline-logic.ts` (not the `@/*`
alias used elsewhere) specifically so the file resolves identically under plain
`node --experimental-strip-types` and under Next.js/webpack; see that import's own comment.
It uses Node's built-in test runner and experimental TypeScript stripping (needs Node 22.6+)
specifically so it adds zero new dependencies — there is still no test framework installed for
the rest of the app.

---

## Hosting

**Production runs on Railway, not Vercel.** This is confirmed by direct inspection (Railway
project "Worka" → service "worka" → Deployments shows every commit pushed to `main` building and
going live within minutes; Vercel's own project for this repo has NOT deployed any commit pushed
in this session despite `main`'s Git integration looking correctly configured there — auto-deploy
from GitHub to Vercel is not actually firing, for reasons not diagnosed here). Concretely:

- **Real production URL**: `https://worka-production.up.railway.app` (Railway → Settings →
  Networking → Public Networking). No custom domain (e.g. `getworka.com`) is currently attached to
  this Railway service — do not assume `getworka.com`/`www.getworka.com` point here. A prior
  version of this file claimed "Vercel auto-deploys from main to getworka.com"; that claim was
  never re-verified against the actual live deployment and turned out to be wrong in a way that
  cost real debugging time (see the git history around July 2026 for the incident) — if you're
  about to write a URL against "production" anywhere (an env var, a workflow secret, a script),
  check Railway → Networking first, don't copy this file's prose without re-verifying it.
- **Auto-deploy**: Railway's GitHub integration ("Auto deploys when pushed to GitHub", visible on
  the service's Settings → Git tab) is what's actually live — every push to `main` triggers a real
  Railway build/deploy.
- **Environment variables**: set on Railway → Variables (per-service), not Vercel. A variable set
  only on Vercel (e.g. an earlier `CRON_SECRET` addition) has no effect on the running app — this
  was the root cause of an early false-negative when standing up the cron triggers below.
- **`vercel.json` is currently inert.** It still declares three `crons` entries, but Railway never
  reads that file, and Vercel isn't deploying `main` — so nothing was actually invoking
  `/api/cron/morning-brief`, `/api/cron/network-rates`, or `/api/cron/intake-recovery` on a
  schedule until the GitHub Actions workflows below were added. Left in place (not deleted) in case
  a Vercel deployment is intentionally revived as a parallel/staging target later — if that
  happens, be aware Vercel's cron would then ALSO fire in addition to the GitHub Actions triggers,
  double-invoking these routes (harmless — every one of them is idempotent — but wasteful and
  confusing in logs). If Vercel is permanently abandoned, delete `vercel.json`'s `crons` block to
  remove this ambiguity for the next person.
- **Scheduled routes now run via GitHub Actions**, not Vercel Cron: `.github/workflows/
  intake-recovery-cron.yml` (every 5 min), `morning-brief-cron.yml` (daily 20:45 UTC),
  `network-rates-cron.yml` (daily 15:00 UTC) — each just calls `scripts/trigger-cron-route.mjs`
  against the real Railway URL with the shared `CRON_SECRET`. Requires two repo secrets: `APP_URL`
  and `CRON_SECRET` (Settings → Secrets and variables → Actions), matching what's set on Railway.
  GitHub's own scheduler is best-effort (can slip several minutes under load); a Railway-native
  Cron Job service running the same script is the tighter-guarantee alternative if that ever
  matters — see "Independent Intake Recovery Service" below for the intake-recovery route
  specifically.
- **SSE / long-lived connections are capped by Railway's edge proxy**, not by a Vercel serverless
  timeout: closed after 5 minutes with no data transferred, hard capped at 15 minutes even with
  keep-alives (SSE is not exempt from this the way a WebSocket upgrade is — see
  https://docs.railway.com/guides/sse-vs-websockets). `app/api/intake/[fileId]/route.ts`'s
  self-close-and-reconnect logic and idle heartbeat exist because of this — the numbers there
  (260s reconnect margin, 60s heartbeat) were originally written against Vercel's flat 300s kill
  and happen to still satisfy Railway's limits, but read that file's own comments before touching
  those constants; the reasoning is platform-specific and has already been corrected once.

---

## Git Rules

- **Always commit directly to `main`** — Railway auto-deploys from `main` (see "Hosting" above for
  the real URL and why `vercel.json`/Vercel are not the live deployment path)
- When given a feature branch, develop there then merge to main before finishing
- Run `npm run type-check` before every commit; fix all new errors (pre-existing module-not-found errors from missing node_modules are acceptable)
- Push with `git push -u origin <branch>` or `git push origin main`

---

## What WorkA Is

AI-powered operations manager for Australian residential builders. Builders type in plain English; WorkA classifies intent, executes backend logic, and returns plain-English results. Zero raw data ever shown in the UI — amounts in AUD, dates as "3 days ago", never ISO strings.

---

## The Four-Layer Architecture (as documented — read the note below first)

The product was designed around four layers, and the Events/Presentation split (Layers 3–4) genuinely holds today. Layers 1–2 do **not** match this description in the current code — read the note directly below before relying on this diagram.

```
Layer 1 — Intent (AI)
  Input: raw message string
  Output: { intent, entities, confidence }
  Rule: ONLY classifies — no DB queries, no mutations

Layer 2 — Decision (Backend)
  Backend logic — never calls Claude API (except Layer 1 intent classification)
  Rule: NEVER sends to clients without builder approval

Layer 3 — Events (Schema)
  Structured event objects inside every Layer 2 response
  e.g. { type: 'open_upload_panel', job_id }
  Rule: events are instructions to the UI — data, not code

Layer 4 — Presentation (UI)
  Next.js App Router — renders events as modals, panels, alerts
  Rule: ONLY renders — never makes business decisions
```

**What actually runs Layers 1–2 today:** there is no `classify-intent` edge function — it was never deployed in this repo. Intent classification happens in-process, inside `app/api/chat/route.ts`'s `extractActions()`, which calls the Anthropic SDK directly. `createWorker()` and `createJob()` (also local functions in `chat/route.ts`) do the same job the `create-worker`/`create-job` edge functions were designed for — those two edge functions existed in earlier history but were deleted as dead code (zero callers) rather than wired up, since `chat/route.ts`'s versions are what's actually live. The only edge function genuinely invoked from the app is `morning-brief` (called from `app/api/cron/morning-brief/route.ts`) plus `smooth-responder` (the document-intake pipeline, invoked from `app/api/intake/[fileId]/route.ts`). See "Supabase Edge Functions" below.

In short: Layer 1 and Layer 2 are both implemented inside the same Next.js route file today, not as separate edge functions. If you're re-introducing a real Layer 1/2 split, that's a deliberate architecture change — don't assume the code already works this way.

---

## Request Flow: Chat Message → Response

1. `POST /api/chat` (`app/api/chat/route.ts`) receives `{ message }`; `builder_id` is derived from the authenticated session (`getAuthenticatedBuilderId()`), never trusted from the request body
2. `extractActions()` calls the Anthropic SDK directly, in-process, to classify intent (or keyword-matches via `routeDemoMessage()` when `ANTHROPIC_API_KEY`/Supabase is unavailable) — there is no separate `classify-intent` edge function
3. Intent dispatched to a handler (`handleMorningBrief`, `handleAddWorker`, `handleNewJob`, `handleMarginQuery`, etc.)
4. Handler returns a `ChatResponse` including an optional `event` field
5. `ChatInterface` receives the response, renders a `ChatMessage`, and fires UI side-effects based on `event.type`

**Extended intents** (handled entirely in the Next.js route, not by edge functions):
`email_draft` | `email_sync_status` | `simulate_email` | `margin_query` | `project_question`

### Project memory — free-form Q&A over a job's extracted facts

`project_question` (`handleProjectQuestion` in `app/api/chat/route.ts`) is the first chat intent to read the reasoning engine's knowledge base (`project_facts` / `scope_items` / `clarifying_questions` — migration 026) — every other intent operates on `jobs`/`quotes`/`variations` only. Deliberately reuses those tables rather than a new `project_memory` table: `project_facts` already carries `evidence`, `confidence`, `source_document_id`, and a `superseded` flag that's never deleted (an audit trail — see `mergeFacts` in `supabase/functions/smooth-responder/pipeline-logic.ts` for how a fact gets superseded when a later document contradicts it). Demo mode (no `NEXT_PUBLIC_SUPABASE_URL`) returns an honest "connect a real project" message — the fallback `lib/*-demo.ts` data has no equivalent fact base to answer from.

**Context building lives in `lib/project-context.ts`, shared with the intake route, not duplicated inline in chat.** `buildProjectContext()` fetches active and superseded facts as **separate queries** — superseded facts get their own small `SUPERSEDED_HISTORY_LIMIT` (20) ordered by recency (`created_at DESC`, a real precondition `pairSupersededFacts()` relies on — see below). Active facts are fetched via `buildActiveFactsQuerySpecs()`: when the builder's question yields no relevant-category hint, one confidence-ordered query covers the full `ACTIVE_FACTS_FETCH_LIMIT`; when `inferRelevantCategories()` does infer relevant categories, this splits into **two category-partitioned queries** — a `category IN (...)` query with its own reserved `RELEVANT_FACTS_FETCH_LIMIT` (sized to exactly `MAX_FACTS_IN_PROMPT`) and a `category NOT IN (...)` query for everything else. This closes a hidden ceiling an earlier version had: fetching the top-N active facts by confidence *before* relevance was known meant a relevant-but-lower-confidence fact could already be excluded by the fetch step itself, before `selectFactsForPrompt()`'s relevance boost ever got a chance to promote it — it was only ever re-ranking whatever survived a confidence-only cut. Partitioning the fetch by category means a relevant fact now only competes against other facts *in its own category* for its reserved budget, not the whole project's fact base — a narrower, far less likely ceiling, though not an eliminated one (a single category with more than `MAX_FACTS_IN_PROMPT` distinct facts could still lose one). `selectFactsForPrompt()` (pipeline-logic.ts) still does the actual truncation-with-ranking and remains the **one, shared implementation** — Stage 3/6 calls it with no relevance hint; chat calls it with the inferred categories. Ties (equal relevance, equal confidence) resolve deterministically by ascending `id` — arbitrary but stable across every call, documented on `selectFactsForPrompt` itself. Change/conflict pairing (`pairSupersededFacts()`) also reuses `mergeFacts`'s own semantic-similarity check (same `SEMANTIC_DUPLICATE_THRESHOLD`, same `cosineSimilarity`) rather than only exact `category`+`key` matching, and collapses multi-generation supersession chains (v1→v2→v3 producing one "v2→v3" change, not both "v1→v3" and "v2→v3") by keeping only the first (most-recently-superseded, given the required `created_at DESC` ordering) predecessor per active target — the full v1→v2→v3 lineage still isn't reconstructable without a `superseded_by_id` column this schema doesn't have, so v1 is dropped from output entirely rather than merely deprioritized; documented as a known limitation on the function itself, not fixed by a schema change.

**Persisted understanding, not just ephemeral per-answer context.** `jobs.knowledge_confidence` / `knowledge_missing_count` / `knowledge_updated_at` (migration 035) cache the same computation `buildProjectContext()` does — written by `persistContext()`/`persistProjectUnderstanding()` (`lib/project-context.ts`) opportunistically after every chat `project_question` answer, automatically right after intake completes (`app/api/intake/[fileId]/route.ts`, alongside the existing `ensureQuotePriced`/`runQualityAssurance` calls), and opportunistically from `GET /api/jobs/[jobId]/snapshot` whenever `knowledge_updated_at` is still null — a lightweight, cron-free recovery path for a transient persistence failure that would otherwise leave it null forever if nobody ever asks a chat question about that job. No new infrastructure: the snapshot endpoint is already the most frequently-hit read for exactly this job, so piggybacking recovery onto it (fire-and-forget, only when never-yet-computed) is the smallest change that gets eventual consistency. Not yet surfaced in `JobSnapshotPanel`/morning-brief UI — the columns exist and are populated, wiring the UI is the natural next phase. These are a cached view over `project_facts`/`scope_items`/`clarifying_questions`, never written to directly and never authoritative on their own — recomputed and overwritten on every call, not incrementally maintained.

**Observability logs real retrieval metrics, not a single boolean.** `buildProjectContext()` itself logs `project_context_built` (job_id, `active_fact_count` — the true total, from a `count`-only query — vs `active_facts_fetched` vs `facts_selected`, `superseded_fact_count` vs `superseded_selected`, `retrieval_strategy` — `confidence_only` or `relevance_partitioned` — `relevance_changed_selection`, `retrieval_duration_ms`, `pairing_duration_ms`) — logged once, at the one call site both chat and the intake-triggered path share, so both emit identical telemetry by construction rather than by remembering to duplicate a log statement in two places. This replaced a chat-only boolean (`facts_truncated`) that couldn't distinguish "excluded 50 facts" from "excluded 99,000 facts," and gave the intake-triggered path no success-path visibility at all. `relevance_changed_selection` answers "is relevance actually doing anything" directly, without reading code. `relevant_facts_fetched`/`relevant_facts_limit_reached` additionally report the relevant-category partition's own fetch count and whether it hit its own reserved limit (`relevant_facts_limit_reached` is a heuristic — fetched count equals the limit — not a certainty, since the category could genuinely have exactly that many facts) — `active_facts_fetched`/`facts_selected` alone are aggregated across both partitions and can't tell an operator whether truncation happened in the partition that actually matters (relevant-category) versus the harmless fallback one; both are `null`/`false` when `retrieval_strategy` is `confidence_only` (no partitioning happened). Chat's own `project_question_answered` log keeps only its answer-specific fields (`context_chars`, `confidence_score`, `duration_ms` for the Claude call) — the retrieval numbers aren't duplicated into it.

Deliberately not built (evaluated, scope kept to what was actually demonstrated as missing): a separate `project_memory` table (would duplicate `project_facts`), a second "consolidation" Claude call after every document (Stage 1/2 already does this comparison in the same call it makes today), a `superseded_by_id` schema column (would fully solve multi-generation lineage, but the task explicitly scoped this to "best possible behaviour without a schema change"), a new recovery cron (the snapshot-read-triggered backfill above achieves eventual consistency without one), and embeddings-based retrieval (`inferRelevantCategories()` is a coarse keyword heuristic; category-partitioned fetching narrows the ceiling embeddings would otherwise be needed to fully remove — real embeddings-based retrieval is justified if `relevance_changed_selection`/fetch-limit exhaustion starts appearing routinely in production logs, not before).

### New job flow — address follow-up

When the initial "new job" message contains no address, the chat route asks "Which address is this job at?" and returns the `new_job` intent with no job created. `ChatInterface.tsx` sets `awaitingAddressForNewJob` state on that response. On the next `sendMessage` call, if that flag is set, the payload sent to `/api/chat` is silently prefixed with `"new job at "` so the classifier routes it correctly. The message **displayed in chat is never modified** — only the API payload.

**This is the canonical pattern for two-step chat flows.** Any future flow that requires a follow-up answer should track pending intent in a `useState` flag inside `ChatInterface.tsx` and rewrite only the outgoing API payload, leaving the displayed message unchanged.

### Morning brief — follow-up injection

After a morning brief response, `ChatInterface` injects a second assistant message 700ms later. The content comes from the `follow_up` field in `ChatResponse` (set by `getDemoMorningBrief` / `getLiveMorningBrief`). If absent, it falls back to deriving a prompt from the top alert's `action` field. The follow-up is always specific — naming the address and the exact action ("Want me to send the payment chaser for Fitzroy now?"), never generic.

---

## Fallback Data Mode

The app checks `process.env.NEXT_PUBLIC_SUPABASE_URL` to decide whether Supabase is available. When not set:

- `middleware.ts` skips all auth checks
- `lib/auth/get-session.ts` → `getSessionUser()` returns the hardcoded fallback user (id `00000000-0000-0000-0000-000000000001`, "Dave Nguyen")
- All API routes return in-memory fallback data from `lib/*-demo.ts` files
- Edge functions are not called

**Fallback data files** (all in `lib/`):
| File | Purpose |
|------|---------|
| `job-snapshot-demo.ts` | Fallback jobs (Fitzroy, Toorak, Brunswick) |
| `variations-demo.ts` | Fallback variations + mutable in-memory state |
| `quote-demo.ts` | Fallback quotes and line items |
| `assumptions-demo.ts` | Fallback AI assumptions |
| `activation-demo.ts` | Fallback job activation state (in-memory map) |
| `comms-demo.ts` | Fallback communication history |
| `worker-demo.ts` | Fallback worker invites and worker portal data |
| `estimation-demo.ts` | Fallback estimation memory (5 completed VIC/NSW projects, builder profile, scope hints) |

**Fallback builder ID**: `00000000-0000-0000-0000-000000000001`  
**Fallback jobs**: Fitzroy `000...010`, Toorak `000...011` / `000...020`, Brunswick `000...012` / `000...030`

---

## Auth

- `middleware.ts` — protects `/chat`, `/settings/*`; redirects to `/login?next=<path>`. **It does not cover `/api/**`** — every API route is responsible for its own auth via `lib/auth/api-auth.ts`.
- `lib/auth/api-auth.ts` — `getAuthenticatedBuilderId()` (session-cookie or trusted internal service-role-key call) and `isDemoMode()`; this is the auth check nearly every API route uses. Never trust a client-supplied `builder_id` from a request body/query string — always derive it from this function.
- `lib/auth/get-session.ts` — `getSessionUser()` for server components (cookies-based)
- `lib/auth/role-guard.ts` — `requirePermission()` / `getRoleFromRequest()` for worker-role-gated actions (`send_quote`, `approve_variation`, `activate_job`, etc.); verifies the bearer token against Supabase Auth (`auth.getUser()`) rather than decoding it unverified.
- `lib/auth/worker-session.ts` — hashed, expiring session token for the worker portal (workers don't have full Supabase Auth accounts). Issued by `POST /api/join/[token]`, read by `/worker`.
- `@supabase/auth-helpers-nextjs` v0.10 is the only Supabase auth helper used:
  - Client components: `createClientComponentClient<Database>()`
  - Server components: `createServerComponentClient<Database>({ cookies })`
  - Middleware: `createMiddlewareClient<Database>({ req, res })`
  - Route handlers: `createRouteHandlerClient<Database>({ cookies })` (inside `getAuthenticatedBuilderId()`)
- There is no shared `lib/supabase/client.ts`/`server.ts` singleton — every route constructs its own `createClient(url, serviceRoleKey)` inline. A prior attempt at a shared client (including a `createAdminClient()`) existed but had zero callers and was deleted.

**Public routes (no auth required):**
- `/approve/variation/[variationId]` — client-facing variation approval portal. Requires a valid `?t=` share token (see "WorkA Proof" / variations below) — the variation ID alone is not sufficient.
- `/join/[token]` — worker onboarding
- `/login`, `/signup`, `/`, `/privacy`, `/terms`

**`/worker` is not in the protected-routes list** (no cookie-based builder session applies there) — it authenticates via the separate worker-session cookie instead. See "Worker / Mobile Portal" below.

---

## Key UI Components

### Chat layer (`components/chat/`)
| Component | Role |
|-----------|------|
| `ChatInterface.tsx` | Main chat UI — message history, input, side-effect dispatcher for all `event.type` values. Owns proactive 25-min check-in timer, time-aware welcome message, follow-up injection after morning brief. |
| `ChatMessage.tsx` | Single message bubble — renders text + inline action buttons |
| `MorningBriefCard.tsx` | Structured morning brief. HIGH alerts render as large cards (15px/600, left red border, filled orange CTA). MEDIUM/LOW are compact rows. Badge labels: URGENT / ACTION / FYI. |
| `UploadPanel.tsx` | File upload drawer; opens on `open_upload_panel` event |
| `WorkerModal.tsx` | Worker created confirmation; opens on `open_worker_modal` event |
| `EmailDraftModal.tsx` | Draft email for approval; opens on `open_email_draft` event |
| `MarginCard.tsx` | Per-job margin display with status pills |
| `AssumptionReview.tsx` | AI assumption resolution (accept / adjust / exclude). Also renders SimilarJobsCard and ScopeIntelligenceCard. Scope hints track accepted/dismissed state locally; accepted count shown in completion banner. |
| `ActivationModal.tsx` | Job activation confirmation — shows 8 milestones + 5 invoices |
| `InboundEmailAlert.tsx` | Floating overlay on `inbound_email_alert` event |
| `IntakeProgress.tsx` | SSE progress bar during document intake; renders `ClarifyingQuestionsPanel` if the estimating engine pauses for a blocking gap; passes `memoryData` to `onComplete` |
| `ClarifyingQuestionsPanel.tsx` | Stage 4/5 blocking-question form — collects builder answers, hands them to `IntakeProgress` to POST and resume the engine |
| `VariationCard.tsx` | Inline variation card in chat — approve/reject + "Send to client" share link |
| `JobListCard.tsx` | Clickable job list rendered when builder asks "show my jobs" |

### Estimation layer (`components/estimation/`)
| Component | Role |
|-----------|------|
| `SimilarJobsCard.tsx` | Shows matched historical projects with similarity %, quoted/final cost, variance |
| `ScopeIntelligenceCard.tsx` | Scope gap hints with confidence levels; Accept / Dismiss per item |
| `ExplainabilityCard.tsx` | Per-trade confidence bars, similar project range, key drivers, accordion expand |

### Job panel layer (`components/job/`)
| Component | Role |
|-----------|------|
| `JobSnapshotPanel.tsx` | Right-side split panel. Renders all job data inline (not via tab sub-components). Sections: Client, Financials (hidden when no financial data), Timeline, Next Milestone, Pending Actions, Crew, Tasks, Comms. |
| `MobileJobSheet.tsx` | Bottom sheet version on mobile — portal-rendered, slide-up animation |

**Note:** `components/job/tabs/` contains only `ProofTab.tsx` now — it's genuinely live, rendered inline inside `JobSnapshotPanel.tsx`'s "Proof trail" section. The other six tab files (OverviewTab, QuoteTab, VariationsTab, InvoicesTab, FilesTab, CommsTab) were confirmed dead (zero imports anywhere) and deleted; `JobSnapshotPanel.tsx` renders all of that data inline instead of via a tabbed layout.

### Quote layer (`components/quote/`)
| Component | Role |
|-----------|------|
| `QuoteView.tsx` | Full quote modal — category accordion, PC/PS register, sell price per line, confidence indicators |
| `SendQuoteModal.tsx` | Send quote confirmation with email preview |

### Home page (`components/home/`)
| Component | Role |
|-----------|------|
| `HeroUploadZone.tsx` | Public marketing-page (`app/page.tsx`, unauthenticated) drop zone |
| `QuotesPipeline.tsx` | Public marketing-page pipeline showcase — intentionally static demo content, not fetched from `/api/dashboard` |

**Note:** `components/dashboard/` (`UniversalDropZone.tsx`, `AIRecommendationsSection.tsx`, `NeedsAttentionSection.tsx`, `RecentActivityFeed.tsx`) no longer exists — it was confirmed dead (never imported by any page; `app/page.tsx` uses `components/home/*` instead) and deleted. `GET /api/dashboard` is still live and used (by `ChatInterface.tsx`'s stats bar and `JobSnapshotPanel.tsx`'s empty-state pulse), just not by that component directory.

### Shell (`app/chat/`)
- `page.tsx` — async server component; calls `getSessionUser()`, passes session props to `ChatShell`
- `ChatShell.tsx` — client component; owns layout state (`activeJob`, `panelVisible`, `pendingUpload`, `pendingEmailDraft`, `pendingQuoteView`); bridges `ChatInterface` ↔ `JobSnapshotPanel`

**Pending state pattern** — ChatShell passes intent-carrying state down to ChatInterface:
- `pendingUpload: ActiveJob | null` → ChatInterface opens UploadPanel for that job
- `pendingEmailDraft: { jobId, intentHint }` → ChatInterface opens EmailDraftModal
- `pendingQuoteView: string | null` (quote_id) → ChatInterface scrolls to quote

### Client-facing pages
- `app/approve/variation/[variationId]/page.tsx` — mobile-first dark portal where clients approve or reject a variation. Reads the `?t=` share token from the URL and forwards it on `GET`/`PATCH /api/variations/[id]`. No builder session — the share token (generated by `POST /api/variations/[id]/share`, hashed at rest, expiring) is the sole authorization. Name confirmation step before finalising. Forward-only: an already-approved/rejected variation can't be re-decided through this endpoint.

---

## ChatResponse type — key fields

```ts
interface ChatResponse {
  intent: string
  message: string
  alerts?: Alert[]           // morning brief alert cards
  follow_up?: string         // injected as second message after morning brief
  worker?: Worker
  invite_url?: string
  job?: Job
  duplicate?: boolean
  existing_job?: Job
  variation?: DemoVariation
  all_variations?: DemoVariation[]
  margin_jobs?: MarginJob[]
  job_list?: JobListItem[]
  worker_list?: WorkerListItem[]
  state_changes?: StateChange[]
  event?: ChatEvent          // backwards-compat single event
  events?: ChatEvent[]       // primary path
}
```

### Alert type

```ts
interface Alert {
  priority: 'high' | 'medium' | 'low'
  message: string             // short address first: "Fitzroy — $28k invoice 3 days overdue."
  action?: string             // row click label + handler key: 'Chase payment', 'Review variations', etc.
  quick_action?: string       // one-tap execute button label: 'Send chaser now', 'Approve all ($3,880)'
  entity_id?: string
  entity_type?: 'job' | 'invoice' | 'variation' | 'quote'
}
```

**Alert copy convention:** lead with the short address (`"Fitzroy —"`), then the specific fact, then the consequence. Never start with a generic verb. Days elapsed must be explicit: `"11 days since job created, no quote sent yet"` not `"no quote sent"`.

---

## API Routes (`app/api/`)

This table is now generated to match `app/api/**/route.ts` exactly — a prior version of this doc listed roughly half the real routes. Keep it in sync when adding/removing routes.

| Route | Purpose |
|-------|---------|
| `POST /api/chat` | Main chat handler — intent classification (in-process, see architecture note above) + dispatch. Rate-limited per builder. |
| `POST /api/upload` | File upload to Supabase Storage |
| `GET /api/intake/[fileId]` | SSE trigger + poller for the reasoning-first estimating engine (see "Reasoning-First Estimating Engine" below). Auth derives `builder_id` from the session — never trusted from the query string. |
| `POST /api/intake/[fileId]/clarify` | Records the builder's answers to blocking clarifying questions as `project_facts`, then resumes the engine (`resume: true`) without re-classifying documents |
| `GET /api/dashboard` | Dashboard stats, alerts, recommendations |
| `GET /api/jobs` | Job list |
| `GET /api/jobs/[jobId]/snapshot` | Full job snapshot for the panel |
| `POST /api/jobs/[jobId]/activate` | Activate a job from an approved quote — generates milestones + invoice schedule |
| `GET/POST /api/jobs/[jobId]/tasks` | Job task list; POST creates or completes/reopens a task |
| `POST /api/jobs/[jobId]/workers` | Assign a worker to a job (verifies both the job and the worker belong to the caller's builder) |
| `GET /api/jobs/[jobId]/proof` | WorkA Proof trail for a job + hash-chain status |
| `GET /api/jobs/[jobId]/proof/export` | Download the Proof Pack (plain-text evidence document) |
| `GET/POST /api/quotes` | Quote fetch and creation |
| `GET /api/quotes/[quoteId]` | Full quote with line items grouped by trade category |
| `GET /api/quotes/[quoteId]/export-pdf` | HTML quote export |
| `POST /api/quotes/[quoteId]/send` | Build the send draft (no mutation, no email sent yet) |
| `POST /api/quotes/[quoteId]/confirm-send` | Builder-confirmed send — atomic `pending_review → sent` guard, Resend delivery, proof event |
| `POST /api/quotes/[quoteId]/revise` | Copy the quote + all line items into a new draft version one number up |
| `GET/POST /api/variations` | Variation list / create (builder-session scoped; never trusts a body-supplied `builder_id`) |
| `GET /api/variations/[variationId]` | Single variation detail — builder session, or a valid `?t=` share token for the public approval page |
| `PATCH /api/variations/[variationId]` | Client approves/rejects a variation — public, requires the `?t=`/body `t` share token, forward-only |
| `POST /api/variations/[variationId]/resolve` | Builder-side approve/reject (e.g. after a phone call) — forward-only, real + demo mode |
| `POST /api/variations/[variationId]/share` | Generate the client approval link — mints a hashed, expiring share token (real mode) |
| `POST /api/variations/[variationId]/send-notification` | Email the approval notice, logs to `communication_history`, records a proof event |
| `GET/POST /api/workers` | Worker list / (workers are actually created via chat's `add_worker` intent, not this route) |
| `PATCH/DELETE /api/workers/[id]` | Update (explicit field allowlist) / soft-delete (deactivate) a worker |
| `POST /api/join/[token]` | Complete worker onboarding — validates the invite token, saves confirmed name/phone, flips `invited → active`, issues the `/worker` session cookie |
| `POST /api/estimation/scope-hints` | Pattern-match scope gaps for a project type — tries the seeded `scope_intelligence_patterns` table first, then Claude, then hardcoded demo patterns |
| `POST /api/estimation/quick-estimate` | Parametric "estimate from history" — powers `/estimate` |
| `GET/POST /api/estimation/similar-jobs` | Matched historical projects for a project profile |
| `GET/PATCH /api/estimation/profile` | Builder's learned estimation preferences (margin, contingency, finish level) |
| `GET/POST /api/estimation/history` | List / seed `project_memory` rows — powers `/estimate/history` |
| `GET/POST /api/estimation/reconcile` | Log estimated-vs-actual cost per trade after a job completes |
| `POST /api/classify-document` | Claude classifies an uploaded PDF/image document type. Rate-limited per builder. |
| `GET/POST /api/rates` | Builder rate preferences list / set |
| `POST /api/rates/import` | Import a supplier CSV price list |
| `POST /api/rates/extract-pdf` | Extract rates from a priced PDF via Claude |
| `GET /api/email-sync/connect` | OAuth initiation (Gmail / Outlook) |
| `GET /api/email-sync/callback` | OAuth token exchange |
| `POST /api/email-sync/disconnect` | Revoke an email sync connection |
| `POST /api/email-sync/parse` | Classify and log an inbound email |
| `GET /api/email-sync/status` | Check OAuth connection status |
| `POST /api/email-sync/simulate` | Trigger demo email scenario |
| `POST /api/email-draft` | Generate draft email via Claude. Rate-limited per builder. |
| `POST /api/email-draft/send` | Send the confirmed draft via Resend, logs to `communication_history` |
| `GET/POST /api/assumptions/[quoteId]` | Assumption list for a quote |
| `POST /api/assumptions/[quoteId]/resolve` | Resolve an assumption (accept/adjust/exclude); advances the quote to `pending_review` when all are resolved |
| `GET /api/cron/morning-brief` | Triggered daily by `.github/workflows/morning-brief-cron.yml` (not Vercel Cron — see "Hosting" above) — emails the daily brief to every builder (guarded by `CRON_SECRET`, fails closed if unset in real mode) |
| `GET /api/cron/network-rates` | Triggered daily by `.github/workflows/network-rates-cron.yml` — nightly Tier-5 aggregation: anonymised P25/P50/P75 of learned rates (min 3 builders per aggregate; guarded by `CRON_SECRET`, fails closed if unset in real mode) |
| `GET /api/cron/intake-recovery` | Triggered every 5 min by `.github/workflows/intake-recovery-cron.yml` — the independent intake-pipeline recovery service. See "Independent Intake Recovery Service" below. |

**Rate limiting**: `lib/rate-limit.ts` caps requests per builder on the Claude-backed routes (`chat`, `classify-document`, `email-draft`) — a DB-backed atomic counter in real mode (`api_rate_limits` table, migration 021), an in-memory fixed window in demo mode.

---

## WorkA Proof

`lib/proof.ts` is the central audit-trail engine. **Every consequential job action must call `recordProofEvent()`** — quote sent, variation submitted/approved/rejected, variation notice emailed, outbound client email, job activated. Events are SHA-256 hash-chained per job (each event's hash covers the previous event's hash), making the trail tamper-evident. `verifyProofChain()` re-validates the chain; the Proof tab (`components/job/tabs/ProofTab.tsx`) shows the trail and links the Proof Pack export at `/api/jobs/[jobId]/proof/export`.

Demo-mode's in-memory proof log (and the other in-memory demo stores — activation, variations, comms) are best-effort and process-local: they don't survive a cold start or a second serverless instance. That's an acceptable limitation for a single always-warm demo deployment, but don't mistake it for a real persistence guarantee — real mode's `proof_events` table has no such limitation.

Recording is best-effort: `recordProofEvent` never throws — a proof failure must not break the builder action it documents. Demo mode appends to the in-memory `demoProofLog`; real mode inserts into the `proof_events` table.

---

## Morning Brief Delivery

`.github/workflows/morning-brief-cron.yml` triggers `GET /api/cron/morning-brief` daily at 20:45 UTC (6:45am AEST) — see "Hosting" above for why this is a GitHub Actions workflow and not `vercel.json` (which declares the same schedule but is never actually read, since production runs on Railway). The route authenticates via `Authorization: Bearer $CRON_SECRET`, asks the `morning-brief` edge function for each builder's ranked brief, formats it with `lib/morning-brief.ts`, and sends via Resend. Demo mode sends the demo brief to `MORNING_BRIEF_TEST_EMAIL` if set.

---

## Supabase Edge Functions (`supabase/functions/`)

All use Deno + ESM. Deployed to Supabase; called from Next.js API routes via `fetch`. Three are actually invoked by the app:

| Function | Layer | Purpose |
|----------|-------|---------|
| `morning-brief` | 2 (Decision) | Ranked daily alerts from DB. Invoked from `app/api/cron/morning-brief/route.ts`. |
| `document-worker` | 2 (Decision) | **Per-document extraction** — downloads one document from Storage, runs its (gated) text extraction, and persists the result to `document_processing_jobs`. One HTTP invocation per document, deliberately, to give each document its own fresh Supabase CPU-time budget instead of sharing one with every other document in the upload. Claims its job atomically via `claim_next_document_job` (migration 034), self-chains to the next pending job, and — once every document in the batch is terminal — triggers `smooth-responder`'s classification stage exactly once. Invoked from `app/api/intake/[fileId]/route.ts` and by itself (chaining). See "Document processing queue (worker model)" below. |
| `smooth-responder` | 2 (Decision) | **The reasoning-first estimating engine** — Stages 1–6 (Document Intelligence → Project Understanding → Scope Reasoning → Gap Detection → Estimate Generation → QA), see "Reasoning-First Estimating Engine" below. Invoked from `app/api/intake/[fileId]/route.ts` directly (legacy single-invocation path, still supported) or via `document-worker` passing `parent_job_id` (the normal path today — Stage 1/2 reads each document's already-persisted extraction result instead of downloading and extracting inline). Function folder name predates this architecture; not renamed to avoid a deploy-slug break. Calls Claude directly — this is the one Layer-2 function that does, since it *is* the AI extraction/reasoning step, not a Claude-free decision step. |

`create-worker` and `create-job` (earlier Layer-2 functions matching the architecture doc above) had zero callers — `chat/route.ts`'s local `createWorker()`/`createJob()` do that work instead — and were deleted. There is no `classify-intent` function; it was never deployed in this repo. If you're restoring the documented architecture, that means writing (or reviving from git history) both, then actually routing `app/api/chat/route.ts` through them.

**Known regression, tracked as a follow-up:** the previous `smooth-responder` (and the `/api/intake/[fileId]/worker` route it replaced) used `lib/pdf-text.ts` to extract a PDF's raw text layer alongside the vision read, specifically because Claude's vision-only reading sometimes misreads column-aligned price tables in priced documents (quotes/BOQs). The reasoning-first engine reads documents vision-only (Deno edge function — `lib/pdf-text.ts` depends on the `unpdf` npm package and Node's `Buffer`, neither portable here without real work). Until this is ported, priced-document line items extracted via `document_rate`/`document_total` should be spot-checked against the source PDF for tabular data.

**Model used in edge functions**: `claude-sonnet-4-6`

**Edge functions now deploy automatically.** `.github/workflows/supabase-functions-deploy.yml`
runs `supabase functions deploy` for both functions whenever `supabase/functions/**` changes on
`main`. Before this, a push to main auto-deployed the Next.js app (Vercel) and, once
`supabase-migrate.yml` existed, the DB migrations — but function code itself still required
someone to run `supabase functions deploy` by hand, with no record of whether that had actually
happened for a given commit. Requires `SUPABASE_ACCESS_TOKEN` (from
supabase.com/dashboard/account/tokens) and `SUPABASE_PROJECT_REF` repo secrets in GitHub →
Settings → Secrets and variables → Actions.

---

## Database

All tables in `public` schema with RLS. Types in `lib/types/database.types.ts` — keep in sync with migrations manually.

**State machines (forward-only — never reverse):**
- Job: `quoting → quoted → active → complete → archived`
- Quote: `draft → pending_review → sent → approved | rejected`
- Variation: `draft → pending → approved | rejected`
- Invoice: `draft → sent → overdue → paid`

**The 13 trade categories are immutable** — locked `sort_order` 1–13, seeded in migration 001. Never create, rename, or delete.

**5-Tier rate hierarchy** (first match wins):
1. `builder_learned_rates` — auto-captured from accepted quotes
2. `builder_rate_preferences` — manual builder override
3. `builder_supplier_rates` — imported price lists
4. `cost_rates` — 630 platform defaults (seeded migration 017), state-aware
5. `network_rate_aggregates` — anonymised P50 across all builders

**Rate resolution engine** — `lib/pricing.ts`. The estimating engine only extracts quantities; pricing happens Next.js-side. `ensureQuotePriced()` runs when the intake poller sees extraction complete (and lazily from the quote GET as backfill): it matches line items to a `line_item_key` (token overlap within trade category + unit compatibility + construction-slang synonyms) and resolves rates through the 5-tier hierarchy. `recomputeQuoteTotals()` must be called after any line-item mutation. `captureLearnedRates()` runs on job activation (quote approval) to feed Tier 1; the nightly `network-rates` cron aggregates learned rates into Tier 5. All pricing is best-effort — an unpriceable item keeps `rate = null` and is excluded from totals rather than failing the pipeline. Quote `confidence_score` = lowest included line-item confidence.

**Canonical trade taxonomy** — `lib/trade-taxonomy.ts` mirrors the DB-locked `trade_categories` table byte-for-byte. This is the *only* trade numbering used anywhere in the product (rate matching, the estimating engine, scope hints, rates import). Earlier versions of this codebase had a second, incompatible 1–13 numbering living in several now-deleted or fixed code paths — if you ever see a `TRADE_CATEGORIES` constant that doesn't match this file, it's a bug, not an alternate scheme.

**Validation gates** — `lib/estimating/gates.ts` is the single specification (Gate 1 no unit, Gate 2 quantity unverified, Gate 3 invalid quantity → excluded; PC/PS items exempt from Gates 1 & 2). The gate is computed once, at extraction time, and persisted on `assumptions.gate` — never re-derived from current line-item state. The Deno estimating engine (`supabase/functions/smooth-responder`) carries a byte-identical copy of this logic since it can't import Next.js modules across the Supabase/Vercel deploy boundary.

**Margin rule** — `quotes.total_cost` is the builder's internal cost basis. Anything a client sees (send email, PDF export, quote summary `client_price`) must be marked up via `applyMargin(cost, margin_pct)`. Raw cost rates and margin percentage never appear in client-facing output.

**Migrations** (apply in order via `supabase db push`):
```
001_initial_schema.sql        — all tables, RLS, 13 trade categories
002_seed_data.sql             — demo builder, workers, clients, jobs
003_storage_bucket.sql        — Supabase Storage bucket
004_email_sync.sql            — email_sync_state table
005_job_activation.sql        — job_milestones, invoice_schedule, proof_events
006_rbac_refs.sql             — role-based access refs
007_job_workers.sql           — job ↔ worker assignment
008_auto_create_builder.sql   — auto-create builder profile on signup
009_job_deadlines.sql         — deadline tracking on jobs
010_search_indexes.sql        — performance indexes
011_estimation_memory.sql     — trade_subcategories (82 rows), project_memory (pgvector),
                                cost_reconciliation, builder_estimation_profiles,
                                scope_intelligence_patterns (5 renovation patterns seeded)
012_quote_data_model.sql      — adds to quote_line_items: labour_cost, material_cost,
                                subcontract_cost, plant_cost, pricing_type
                                (measured/pc_allowance/provisional_sum), source_ref,
                                margin_pct; trigger enforces 0% margin on provisional_sum rows
013_storage_csv_support.sql   — CSV uploads in storage bucket
014_estimate_fields.sql       — estimate fields on quotes
015_intake_diagnostics.sql    — intake diagnostic columns on files
016_pipeline_stage.sql        — intake_stage / intake_pct on files
017_cost_rates_seed.sql       — 630 platform cost rates (70 national + 8 state variants)
018_variation_share_tokens.sql        — hashed, expiring client-approval share tokens on variations
019_jobs_write_policies.sql           — restores INSERT/UPDATE/DELETE RLS on jobs (007 only left SELECT)
020_network_rate_aggregates_null_state_unique.sql — NULLS NOT DISTINCT constraint so the nightly
                                         aggregation cron can upsert atomically instead of racing
021_rate_limits.sql                   — api_rate_limits table + check_rate_limit() RPC
022_jobs_duplicate_address_guard.sql  — partial unique index closing the create-job duplicate-address race
023_atomic_learned_rate_upsert.sql    — upsert_learned_rate() RPC, atomic running-average update
024_job_tasks.sql                     — job_tasks table (route code already assumed this existed)
025_worker_sessions.sql               — hashed, expiring worker-portal session token on workers
026_reasoning_engine.sql              — assumptions.gate (persisted, not re-derived); project_documents,
                                project_facts, scope_items, clarifying_questions (Stages 1-5 of the
                                estimating engine); quotes.qa_report / overall_confidence (Stage 6 QA);
                                files.intake_status gains 'needs_info'
027_reload_postgrest_schema_cache.sql — NOTIFY pgrst, 'reload schema'. Forces PostgREST to pick up
                                objects from 021/026 that were returning "not found in schema cache"
                                in production despite being defined correctly — see note below.
028_intake_progress.sql       — intake_stage / intake_pct / intake_assumption_count on files.
                                Renumbered from 008_intake_progress.sql (see note below) — content
                                unchanged, ADD COLUMN IF NOT EXISTS so the rename was a no-op replay.
029_job_context_fields.sql    — budget_estimate / scope_notes on jobs. Renumbered from
                                008_job_context_fields.sql for the same reason as 028 above.
030_intake_locking_and_batching.sql — job_intake_locks (one active smooth-responder run per
                                job); files.upload_batch_id / skipped_sibling_filenames /
                                failed_sibling_filenames; unique index on quote_line_items (no
                                duplicate trade + description per quote — the job lock is the
                                primary defense against the duplicate-quote race, not a DB
                                constraint, since QuoteView's Revise button legitimately creates
                                a second draft quote for a job) — see "Reasoning-First
                                Estimating Engine" above.
031_fact_embeddings.sql       — project_facts.embedding vector(512), optional Voyage AI
                                semantic fact de-duplication — see "Fact de-duplication at
                                scale" above.
032_intake_batch_progress.sql — files.intake_batch_index / intake_batch_count, for the
                                multi-batch Stage 1/2 document processing described in
                                "Document batching" below.
033_intake_lock_progress_heartbeat.sql — job_intake_locks.last_progress_at, touched by the
                                engine at every real stage/batch boundary. Lets the Next.js
                                lock-staleness check reclaim an abandoned lock based on "no
                                progress observed recently" rather than only a fixed
                                age-since-acquired window — see "Text extraction is CPU-metered
                                per request, not per file" below for the incident this fixes.
034_document_processing_jobs.sql — document_processing_batches / document_processing_jobs
                                (the document processing queue), claim_next_document_job /
                                complete_document_job / retry_or_fail_document_job RPCs, and
                                files.processing_batch_id. See "Document processing queue
                                (worker model)" below — this moves per-document text
                                extraction out of the shared smooth-responder invocation
                                entirely, into its own document-worker invocation per file.
035_job_knowledge_understanding.sql — jobs.knowledge_confidence / knowledge_missing_count /
                                knowledge_updated_at — a cached snapshot of project
                                understanding (see "Project memory" above), not a new source
                                of truth. Populated by lib/project-context.ts, not written to
                                directly.
036_document_job_stale_reclaim.sql — reclaim_stale_document_jobs() + a modified
                                claim_next_document_job() that self-heals a
                                document_processing_jobs row left at status='running'
                                by a crashed document-worker invocation (the queue-model
                                analogue of job_intake_locks' own staleness reclaim,
                                migration 033) — see "Production readiness automation"
                                below.
037_intake_recovery_service.sql — document_processing_jobs.locked_by (worker
                                attribution); find_batches_with_claimable_work(),
                                recompute_stalled_batches(), find_stale_job_intake_locks(),
                                acquire_or_reclaim_job_intake_lock(),
                                find_stuck_files_needing_classification_retry(), and the
                                intake_recovery_runs audit table — the primitives behind
                                GET /api/cron/intake-recovery, which closes the deadlock
                                migration 036's reclaim left open (that reclaim only ever
                                runs INSIDE a live document-worker invocation, so a batch
                                whose entire worker chain died — e.g. any single-document
                                upload — had nothing left to ever trigger it). See
                                "Independent Intake Recovery Service" below.
```

**If you ever see "Could not find the function/table X in the schema cache" from PostgREST**
in production logs for an object that genuinely exists in a migration file, this is almost
always a stale PostgREST schema cache, not a bug in the migration. `supabase db push` does not
reliably trigger a PostgREST reload on its own. Fix: run `NOTIFY pgrst, 'reload schema';` against
the database (or use the Supabase Dashboard's Database → "Reload schema cache" button) after
confirming the migration has actually been applied (`supabase migration list`). Migration 027
does this once; if it recurs after future migrations, add another one-line `NOTIFY` migration
rather than assuming the DDL itself is wrong.

**Migrations now deploy automatically.** `.github/workflows/supabase-migrate.yml` runs
`supabase db push` against production (then reloads the PostgREST schema cache) whenever
`supabase/migrations/**` changes on `main`. This closes the gap where a migration file merged
into main was never actually applied to the live database — the root cause of the 021/026
incident above. It requires a `SUPABASE_DB_URL` repo secret (full Postgres connection string,
including password) set in GitHub → Settings → Secrets and variables → Actions. Without that
secret the workflow fails loudly on the next migration push rather than silently doing nothing.

**Resolved incident:** `008_auto_create_builder.sql`, `008_intake_progress.sql`, and
`008_job_context_fields.sql` used to share the `008_` prefix. That wasn't just cosmetic —
Supabase's CLI uses the numeric prefix as the migration's `version` primary key in
`supabase_migrations.schema_migrations`, so only the first of the three to be applied could ever
be recorded; the other two could never get their own history row. This is what actually caused
the `check_rate_limit`/`project_documents` "not found in schema cache" incident: `supabase db
push` had been silently refusing to apply *every* migration from `010_search_indexes.sql` through
`027_reload_postgrest_schema_cache.sql` for months, because it always stopped at the unresolvable
`008_` collision first. `008_intake_progress.sql` and `008_job_context_fields.sql` were renumbered
to `028_` and `029_` (content unchanged — both are `ADD COLUMN IF NOT EXISTS`, so the rename was a
safe no-op replay, not a real schema change) to give them distinct versions. If you ever see a
migration file whose leading number matches an existing one, this is why it matters: rename it to
the next free number before it ships, don't let a second file reuse a number already on disk.

### Quote line item — key columns

| Column | Type | Notes |
|--------|------|-------|
| `pricing_type` | `text` | `measured` \| `pc_allowance` \| `provisional_sum`. PC/PS items are exempt from validation Gates 1 & 2. |
| `source_ref` | `varchar(100)` | Drawing reference e.g. "A3.1", "SK-04". AI extracts from plans. |
| `margin_pct` | `numeric(5,4)` | Per-line margin (0–1). DB trigger forces 0 on `provisional_sum` rows. |
| `labour_cost` | `numeric(12,2)` | Cost split — labour component. |
| `material_cost` | `numeric(12,2)` | Cost split — materials component. |
| `subcontract_cost` | `numeric(12,2)` | Cost split — subcontractor component. |
| `plant_cost` | `numeric(12,2)` | Cost split — plant/equipment component. |

### Estimation Memory tables (migration 011)

| Table | Purpose |
|-------|---------|
| `trade_subcategories` | 82 subcategory codes under the 13 trades (e.g. `ELEC-POWER`, `TILE-FLOOR`). Seeded but not currently read anywhere — reserved for finer-grained rate learning than the 13 top-level trades. |
| `project_memory` | One row per completed/active job — stores metadata, cost actuals, embedding (nullable `vector(1536)`) |
| `cost_reconciliation` | Per-line actual vs quoted cost; drives the feedback loop |
| `builder_estimation_profiles` | Learned builder preferences: margin, region, finish level, accuracy score |
| `scope_intelligence_patterns` | Known scope gaps by job type — `POST /api/estimation/scope-hints` reads this as its fast pattern-matching pass before falling back to Claude |

**Similarity scoring** is done in-process (no vector API required): job type (+30), floor area within 20% (+15), same region (+15), same finish level (+15), wet area count (+10), storeys (+10). Minimum score 50 to be surfaced.

---

## Reasoning-First Estimating Engine

This is the **one canonical pipeline** for turning uploaded documents (or a plain-English description) into an estimate. It replaced four independent, competing "document → quote" implementations that had accumulated in this codebase (two dead/unreachable, two live and inconsistent with each other — including a second, incompatible trade-category numbering sharing the same 1–13 integer space as the DB-locked one). There is now exactly one reasoning engine, one taxonomy, one gate specification.

The pipeline always runs in this order and never skips straight to pricing:

```
Upload → Document Classification → Project Understanding → Scope Reasoning →
Gap Detection → Clarifying Questions (if blocking) → Estimate Generation →
Quality Assurance → Render Estimate
```

**Split across two runtimes, deliberately:**

| Stages | Where | Why |
|--------|-------|-----|
| 1 Document Intelligence, 2 Project Understanding | `supabase/functions/smooth-responder` (Deno) | No request/connection timeout tied to the Next.js app's own HTTP lifecycle — a multi-call reasoning chain needs room to run in the background regardless of whatever connection ceiling the app's own host (Railway; formerly assumed to be Vercel — see "Hosting" above) imposes |
| 3 Scope Reasoning, 4 Gap Detection, 5 Clarifying Questions | same Deno function | Gap detection falls directly out of scope reasoning — one Claude call covers both |
| 6 Estimate Generation (quantities only, no rates) | same Deno function | Produces line items with evidence + confidence; `rate`/`total` stay null unless the source document itself is a priced BOQ (hybrid pricing) |
| Rate resolution (5-tier hierarchy) | Next.js, `lib/pricing.ts`, called from the SSE route once `intake_status = 'extracted'` | Needs the builder's learned/preference/supplier rates — same Postgres the Next.js app already talks to |
| 8 Quality Assurance | Next.js, `lib/estimating/qa.ts`, runs immediately after pricing | Needs priced totals to check for unpriced/low-confidence/duplicate items |
| 9 Render | `IntakeProgress` → `AssumptionReview` / `QuoteView` | Presentation only |

**Real progress, not cosmetic.** `files.intake_stage` / `intake_pct` are written at each actual stage boundary inside the Deno function — there is no fake `setInterval` faking progress while a single API call runs.

**Persisted, evidence-backed state** (migration 026), enriched rather than rebuilt on every upload:

| Table | Stage | Purpose |
|-------|-------|---------|
| `project_documents` | 1 | Document map — type, discipline, revision, readability, duplicate/superseded detection |
| `project_facts` | 2 | Evidence-backed facts — every fact carries `source_document_id`, `page_reference`, `evidence`, `confidence`. Unknown stays unknown; nothing is inferred without evidence. `superseded` (migration 030) and `embedding` (migration 031, optional) support the de-duplication described below. |
| `scope_items` | 3 | Per-trade included/excluded scope, dependencies, assumptions, uncertainty |
| `clarifying_questions` | 4/5 | `blocking = true` questions stop the pipeline before Stage 6 — no estimate is generated until answered. Non-blocking gaps are instead represented as per-line assumptions, exactly like before. |
| `quotes.qa_report` / `overall_confidence` | 8 | Top risks, review items, recommended actions, missing trades, duplicate descriptions |

**Blocking clarifying questions pause the pipeline.** `files.intake_status` gains `needs_info`; the SSE route (`GET /api/intake/[fileId]`) detects it, fetches the open blocking questions, and emits a `needs_clarification` event instead of `complete`. `IntakeProgress.tsx` renders `ClarifyingQuestionsPanel.tsx` in place of the progress bar. Answering calls `POST /api/intake/[fileId]/clarify`, which writes each answer as a `project_facts` row (`category: 'builder_answer'`, confidence 100 — a direct builder answer always outranks anything inferred from a document) and re-triggers the engine with `resume: true`, which skips straight back to Scope Reasoning with the merged fact base rather than re-classifying documents from scratch.

**Incremental uploads merge, they don't restart.** A new file uploaded to a job that already has facts/scope/a quote gets classified on its own, folded into the existing fact base, and Scope Reasoning + Gap Detection re-run over the merged set. Estimate Generation reuses the job's existing draft/pending_review quote rather than creating a second one, and skips re-inserting any line item that already exists for the same trade + description — previously-resolved assumptions on unrelated line items are left untouched. Estimate Generation's line-item insert is an `upsert` with `ignoreDuplicates` against a unique index on `(quote_id, trade_category_id, description)` (migration 030) — a hard backstop, not the primary defense; see the locking note below for that.

**At most one active run per job** (`job_intake_locks`, migration 030). The Deno function's Stage 1/2 fact extraction is scoped to whatever's in the current invocation's batch — a second file for the same job triggering a second, concurrent `smooth-responder` run would reason over an incomplete fact base and race the first run's writes to `scope_items`/`quotes`/`quote_line_items`. The lock is acquired by the Next.js intake routes (`app/api/intake/[fileId]/route.ts`, `.../clarify/route.ts`) before triggering the engine, and released by the engine itself in a `try/finally` so it clears on every exit path, including pausing for a blocking clarifying question. A second upload session to the same job waits (SSE emits a `queued` progress stage) rather than racing.

**Document batching (never silently drop files).** A single Stage 1/2 Claude call has a real payload ceiling, so the primary file plus its siblings are split into batches — largest-first bin packing under a 20MB per-batch vision-encoding budget, up to `MAX_BATCHES` (3) batches per run — instead of the old single hard 20MB/6-sibling cutoff that silently discarded anything past the limit. Batch splitting is a pure function (`splitIntoBatches` in `supabase/functions/smooth-responder/pipeline-logic.ts`, unit-tested — see Commands above) shared with nothing else; facts extracted by each batch are merged into the running fact base via `mergeFacts` (same file — the same exact-key/semantic-supersession logic that already handled merging facts across separate incremental uploads, applied here across batches within one run). `files.intake_batch_index`/`intake_batch_count` (migration 032) are written at each batch boundary so `IntakeProgress.tsx` can show real "batch 2 of 3" progress. **Any file excluded — whether by the byte budget, a storage load failure, or the (generous, 30-file) total-considered cap — is written to `files.skipped_sibling_filenames`/`failed_sibling_filenames` as soon as batching decides it, not only on eventual success.** This matters: a run that later times out or fails at a subsequent stage still has this information persisted, and `GET /api/intake/[fileId]`'s `error` SSE events now read and forward it (previously only the `complete` event ever carried it, so a timeout gave the builder zero indication anything had been skipped). `UploadPanel.tsx` surfaces "N of M files processed, these weren't included" with a one-click retry scoped to just those files (resolved by filename against the panel's own already-uploaded-this-session file map, no re-upload needed). True cross-invocation batching (for uploads that would still exceed even 3 batches in one edge function invocation) is a natural follow-up using the same batch-index persistence, not implemented yet.

**Vision-selective processing (text-dense documents skip vision entirely).** `supabase/functions/smooth-responder/pdf-text.ts` is a Deno-native port of `lib/pdf-text.ts` (same library, `unpdf`, but base64→bytes via `atob` instead of Node's `Buffer`, since this edge function can't use Node globals). Every PDF's text layer is extracted before deciding how to send it: **text-dense** (≥2,000 chars — specs, fixture schedules, priced BOQs) is sent as a text-only block, skipping vision encoding entirely — this is the single biggest lever on Stage 1/2 token cost, and directly targets the documents that were most likely to get excluded by the byte budget in the first place. **Text-sparse** (an actual drawing) still gets the full vision `document` block, with any usable-but-not-dense text (≥200 chars) attached as a numeric-accuracy supplement, exactly like the original Next.js-side rationale (Claude's vision read of a rendered price table sometimes misreads column-aligned Rate/Total figures; the text layer is authoritative for those numbers). This resolves the "known regression" the Next.js pipeline used to have and this Deno pipeline never had — see `lib/pdf-text.ts`'s own comment header, now effectively ported.

**Oversized single-file rescue via page-chunking.** A single vision PDF too large to fit any batch on its own used to be excluded outright by `splitIntoBatches` — a whole document lost, not delayed. `supabase/functions/smooth-responder/pdf-chunk.ts` (using `pdf-lib`, pure JS, no canvas/DOM needed since Claude rasterizes PDF `document` blocks server-side) splits such a file into page-range chunks sized to fit the batch budget, each becoming its own entry in the batch plan under a synthetic id (`${realFileId}#pStart-End`). Only reached for genuinely large, vision-necessary documents — a text-dense PDF this large is already reduced to a small text block by the vision-selective step above, long before chunking is ever considered. Chunk ids are mapped back to the real `files.id` (`realFileId()` in `index.ts`) for every DB write; multiple chunks of one file share that file's single `project_documents` row (the last-processed chunk's classification metadata wins — an accepted simplification, since every chunk's extracted facts are captured in full regardless, they aren't gated by that row).

**Text extraction is gated, not unconditional — CPU time is metered per request, not per file.** Supabase Edge Functions cap CPU time at 2000ms per invocation (separate from the 400s wall-clock/isolate-lifetime limit) — the whole `runPipeline` call, not per file and not per batch. A production incident showed this getting exhausted mid-run: pdf.js logged `"TT: undefined function"` (it struggling to interpret an embedded TrueType font program) immediately before Supabase killed the isolate outright with `"CPU Time exceeded"` — an external, uncatchable kill, so no `catch`/`finally` ran and the job lock leaked until its own staleness timeout, then retried the identical crash forever. The file the crash logs actually named, `Kitchen Elevation.pdf`, was ~290KB — a byte-size-only gate cannot explain or prevent that. `gateTextExtraction` (`pipeline-logic.ts`) is checked before every extraction attempt against per-file heuristics (byte size, and page count via the same cheap `pdf-lib` read `pdf-chunk.ts` already uses — it doesn't interpret font programs, only the object graph, so it's safe to call even on a file that would be dangerous to actually parse) **and** against a deliberately conservative run-wide budget (900ms, well under the real 2000ms ceiling) that `index.ts` tracks across every file loaded in one invocation via a shared `ExtractionBudget` object — so a run can gate off a later file's extraction purely because earlier files in the same invocation already spent the budget, even if that later file looks individually unremarkable. There is no reliable way to preempt an in-flight parse (a same-thread `Promise.race`/`setTimeout` cannot interrupt synchronous CPU-bound execution, and even if it could, Supabase's own governor kill fires faster and cannot be caught) — the only real defense is not starting the risky work once the budget says not to. `job_intake_locks.last_progress_at` (migration 033) is touched at every real stage/batch boundary so the Next.js lock-staleness check can reclaim an abandoned lock based on observed staleness rather than only a fixed age-since-acquired window (see "Timeout handling" above and `tryAcquireJobLock` in `app/api/intake/[fileId]/route.ts`). A Stage 1/2 batch's Claude call failing (not a CPU-kill — a genuinely catchable, in-band error) no longer aborts the whole run either: that batch's files are recorded as failed and the loop continues to the next batch, so partial progress from earlier, successful batches survives.

**Document processing queue (worker model) — each document gets its own CPU budget, not a share of one.** The gating above reduces the *chance* one file exhausts the shared per-invocation budget, but can't eliminate it — a genuinely pathological document can still blow through it and take the whole shared invocation down, since Supabase's CPU-time kill is external and uncatchable regardless of how conservative the gate was. Migration 034 adds `document_processing_batches` (one row per upload) and `document_processing_jobs` (one row per document); `supabase/functions/document-worker` claims and processes exactly one document per HTTP invocation, which per Supabase's own per-*request* CPU metering means a fresh 2000ms budget every time — one document's crash can no longer touch any other document's processing. Flow: `app/api/intake/[fileId]/route.ts` creates the batch + one job per file, then fires up to 4 parallel document-worker invocations (`WORKER_CONCURRENCY = min(4, N)` — was 2; raised so a large commercial upload drains faster and a single chain death orphans a quarter of the batch instead of half); each claims a job via `claim_next_document_job` (`FOR UPDATE SKIP LOCKED` — real DB-level mutual exclusion, not an application lock, so two workers can never claim the same document), extracts it (the same `gateTextExtraction`/`ExtractionBudget` safeguards still apply, just scoped to one document instead of accounting for a whole batch), persists the result via `complete_document_job`, and triggers the next pending job as a **new** invocation (a same-invocation loop would not get a fresh CPU budget — that's the whole point). A catchable failure (not a CPU-kill) retries with backoff via `retry_or_fail_document_job` — 30s after the 1st failure, 2min after the 2nd, permanently failed after the 3rd — so one bad PDF degrades to "needs manual review" instead of taking the batch down. **Retry safeguard (critical, learned from production):** on any retry (`attempts >= 1`), document-worker skips text-layer extraction entirely and processes the document vision-only. A retry whose prior attempt was *reclaimed from `running`* means that attempt almost certainly died in the uncatchable CPU-kill mid-parse — and since byte/page gates demonstrably can't predict which PDFs do this (the incident file was ~290KB), re-attempting the identical parse just reproduces the identical kill: a deterministic crash loop that burns all 3 attempts on the same document and stalls the batch for ~20+ minutes of reclaim cycles. Extraction is an optimization (numeric fidelity for priced tables, cheaper tokens for text-dense specs), never a requirement — the vision path processes every document fully without it — so attempt 2 is guaranteed not to die in the parser. This is what makes the queue *converge* instead of merely being resurrected by the recovery cron each cycle. `recompute_parent_batch_status` (called by both RPCs) derives the batch's aggregate status from its children — `running` while any are still pending/running, `completed_with_failures` when some failed but at least one succeeded (a single bad PDF must not fail the whole batch), `failed` only if every document failed — and, in the same atomic UPDATE, flips `classification_triggered` false→true exactly once the moment the batch becomes fully terminal, so exactly one of the (possibly several) worker chains triggers `smooth-responder`'s classification stage, never zero and never twice. `smooth-responder`'s Stage 1/2 file-loading branches on whether it was invoked with a `parent_job_id`: if so, it reads each completed job's persisted extraction result (`loadAllFromExtractionResults`/`loadBlockFromExtractionResult`) instead of re-downloading and re-extracting — a vision-path document's binary is re-fetched from Storage at that point (plain I/O, not the CPU-bound parsing step that needed isolating), but never re-parsed. The legacy direct-invocation path (no `parent_job_id`) still exists in `runPipeline` for backward compatibility but is no longer what the Next.js route uses. The SSE poller reads `files.processing_batch_id` (set when the batch is created) to also poll `document_processing_jobs` and emit a `document_progress` event with a per-document checklist — `IntakeProgress.tsx` renders it above the existing stage-based progress bar, which takes back over once classification starts. The poller also derives an honest overall stage/pct for this phase (`documentPhaseProgress` in `pipeline-logic.ts`: "Reading documents — N of M processed", 5→20%, handing off to classification's real 25% write) — nothing else writes `intake_stage`/`intake_pct` before classification, so without this the bar sat frozen at "Uploading documents... 5%" for the entire extraction phase, making every healthy run look identical to a hung one.

**Deliberately not implemented: summarizing documents before the reasoning stage.** This was evaluated alongside the above as a further token-reduction lever and rejected — it would add a whole extra Claude call per document (net cost/latency negative once you're already paying for the original read), and more fundamentally it conflicts with this pipeline's core guarantee ("never invent a fact — extract only what you can point to direct evidence for"): a summary is a step removed from source evidence, exactly the kind of lossy intermediate that guarantee exists to avoid. The vision-selective processing above gets the real token savings without that tradeoff.

**Timeout handling: stuck vs. slow are different things.** The SSE poller's `OVERALL_TIMEOUT_MS` (15 min, tracked via `overallStartedAt`) is still the hard ceiling regardless of activity, but a second, tighter signal — `STUCK_TIMEOUT_MS` (9 min — deliberately set above the independent recovery service's own worst-case detection+action latency, see "Independent Intake Recovery Service" below) since `lastProgressAt`, a real stage/batch-index/per-document-status change — now lets a genuinely-hung run give up well before 15 minutes without penalizing a run that's legitimately working through several document batches. Both timestamps ride along in the SSE URL across the deliberate reconnects Railway's edge-proxy connection ceiling forces (5 min with no data, 15 min hard cap regardless — see "Hosting" above; same pattern as `started_at`), tracked client-side in `IntakeProgress.tsx` refs. See `shouldGiveUp` in `pipeline-logic.ts`.

**Stage 1/2 extraction sees prior facts, not just document titles.** The system prompt includes the job's already-established `project_facts` (not just a list of previously-processed document titles) so a newly-uploaded document is classified with real awareness of what earlier documents in the job established — it can extend, agree with, or correct that context instead of extracting in a vacuum. A fact that a new document corrects is marked `superseded = true` on the prior row (matched by `job_id` + `category` + `key`, differing value) rather than both rows accumulating forever and both landing in every future prompt.

**Fact de-duplication at scale (optional, Voyage AI).** As a job accumulates many documents, the same real-world fact often gets restated under a different `category`/`key` label per document (e.g. "gross floor area" vs `floor_area_m2`) — the exact-key supersession above won't catch that. If `VOYAGE_API_KEY` is set (as a Supabase Edge Function secret, not just in the Next.js app's env), each new fact is embedded (`voyage-3-lite`, 512 dimensions, stored on `project_facts.embedding` — migration 031) and compared by cosine similarity against the job's existing facts; anything above a 0.93 threshold is treated as the same fact restated and superseded the same way. Best-effort throughout — an unset key or a failed Voyage call just means that fact falls back to the exact-key check, never fatal to the pipeline. A separate hard cap (200 facts, highest-confidence kept) bounds prompt size regardless, in case a project genuinely has more distinct facts than that. This is deliberately not a chunking/RAG pipeline over raw PDFs — vision reads stay the extraction method; only the *fact list* gets this treatment.

**Validation gates:**
- Gate 1: no unit (or a genuinely undeterminable quantity, marked "Manual Input Required" by the model) → assumption (unresolved). Exempt: `pc_allowance`, `provisional_sum`, document-priced lines.
- Gate 2: quantity present but not traceable to evidence → assumption (unresolved). Same exemptions.
- Gate 3: quantity ≤ 0 → assumption (excluded).

See `lib/estimating/gates.ts` for the canonical spec.

---

## Production readiness automation

Converts what used to be a manual production-verification runbook (schema checks, stuck/failed-job
checks, an end-to-end smoke test — all re-derived by hand after every deploy) into checked-in,
CI-enforced and cron-run automation. Scoped deliberately to the document-processing-queue /
project-memory schema (migrations 026, 030, 033-036) this session's work actually touched, not a
retrofit of the whole 36-migration history.

| File | Runs | Purpose |
|------|------|---------|
| `supabase/verification/schema_assertions.sql` | `supabase-migrate.yml`, after every push to `main` | Asserts required tables/columns/CHECK constraints/foreign keys/indexes exist, and that `claim_next_document_job`, `complete_document_job`, `retry_or_fail_document_job`, `recompute_parent_batch_status`, `reclaim_stale_document_jobs`, and (migration 037) `find_batches_with_claimable_work`, `recompute_stalled_batches`, `find_stale_job_intake_locks`, `acquire_or_reclaim_job_intake_lock`, `find_stuck_files_needing_classification_retry` exist with their expected signatures **and are actually callable** (each probed with a bogus uuid that matches zero real rows, or — for the one function that mutates on success — an expected-and-caught foreign key violation; never a no-op existence check alone). `RAISE EXCEPTION`s on the first failure, failing the workflow loudly instead of a gap surfacing later as a runtime "not found in schema cache" error (see the 008_/021/026 incident above). |
| `supabase/verification/health_monitoring_views.sql` | Same workflow, immediately after | `CREATE OR REPLACE VIEW/FUNCTION` (idempotent, no data mutated) for: `stuck_document_jobs`, `stuck_job_intake_locks`, `failed_document_jobs_recent`, `document_job_retry_rate()`, `document_processing_latency_stats()`, `document_batch_failure_summary()`, `document_batch_completion_latency()`, `intake_recovery_activity_summary()`, and a single-row rollup `document_processing_health_summary()` for a dashboard tile or alert cron. |
| `scripts/synthetic-intake-health-check.mjs` | `.github/workflows/intake-pipeline-health-check.yml`, scheduled every 6h (`workflow_dispatch` also available) | Exercises the real, deployed pipeline end to end — upload → `document_processing_batches`/`jobs` creation → `document-worker` claim → extraction → `classification_triggered` flip → smooth-responder reachability — against a disposable synthetic job/file, cleaned up in a `finally` regardless of outcome. See the script's own header comment for exactly what a pass does and doesn't certify (plumbing, not extraction accuracy). |
| `supabase/migrations/036_document_job_stale_reclaim.sql` | Applied like any other migration | Closes the stuck-running-job gap (below). |

**The stuck-running-job gap, and the fix.** `document-worker`'s HTTP handler returns `202 claimed`
immediately after `claim_next_document_job` sets `status='running'`, then does the real extraction
inside `EdgeRuntime.waitUntil` (see `index.ts`) — the caller that could have noticed a failure has
already gone away before the real work even starts. If that background work is hit by Supabase's
external, uncatchable CPU-time governor kill (the same failure mode migration 034 exists to
isolate down to a single document), the row is left at `status='running'` forever: no code path
ever calls `complete_document_job`/`retry_or_fail_document_job` for it, so
`recompute_parent_batch_status` never sees it leave `running`, the batch never turns terminal, and
classification never triggers. This is the queue-model analogue of the `job_intake_locks` gap
migration 033 already fixed. The fix mirrors that one rather than inventing a new mechanism:
`reclaim_stale_document_jobs()` requeues (or, past 3 attempts, permanently fails — the same cap and
backoff `retry_or_fail_document_job` already uses) any `running` row whose `locked_at` is older than
3 minutes, and `claim_next_document_job` now sweeps its own batch's stale rows before claiming —
self-healing on every worker invocation, no new cron required, exactly mirroring
`tryAcquireJobLock`'s own lazy-reclaim-on-acquire pattern in `app/api/intake/[fileId]/route.ts`. A
fixed window (not a heartbeat column, unlike `job_intake_locks.last_progress_at`) is sufficient here
because one `document_processing_jobs` claim does exactly one document's extraction, bounded by the
same ~2000ms per-request CPU budget — there is no legitimate multi-minute in-progress state to
distinguish from a dead one, unlike a multi-stage `smooth-responder` run. `reclaim_stale_document_jobs`
is also exposed standalone (and surfaced via `stuck_document_jobs`) so a health check or monitoring
cron can sweep across every batch, not only the one a worker happens to be claiming against.

**Manual checks this does *not* replace** (kept as runbook items, not automated): the queue's
concurrency guarantees themselves (a live two-transaction `FOR UPDATE SKIP LOCKED` demonstration,
and a `retry_or_fail_document_job` backoff-timing test) are a one-time/occasional correctness proof
of the locking primitive, not something worth re-running on a schedule; edge function *runtime*
behaviour beyond reachability (actual extraction accuracy, Claude output quality) is exactly what
the synthetic health check's header comment explicitly declines to certify; and interpreting a
non-empty `stuck_document_jobs`/`failed_document_jobs_recent` result operationally (is this one bad
PDF or a systemic regression) still needs a human, the views only remove the need to hand-write the
SQL to see it.

---

## Independent Intake Recovery Service

Every recovery mechanism up through migration 036 shared one structural flaw: each was only ever
**invoked** by the same chain of triggers that could fail in the first place.
`reclaim_stale_document_jobs()` only runs inside `claim_next_document_job()`, which only runs inside
a *live* `document-worker` invocation — but the scenario it exists to recover from is exactly "the
document-worker chain has stopped invoking itself entirely." A single-document upload (the most
common real case — one plan PDF) fires exactly one `document-worker` invocation
(`WORKER_CONCURRENCY = min(4, N)`, `app/api/intake/[fileId]/route.ts`); if that one invocation is
killed mid-extraction by Supabase's external, uncatchable CPU-time governor, `triggerNext()` (the
line immediately after the kill point in `document-worker/index.ts`) never runs, so nothing ever
calls `claim_next_document_job()` again for that batch — the reclaim sweep that would have fixed it
never fires. The row sits at `status='running'` forever, `document_processing_batches.status` never
leaves `running`, `classification_triggered` never flips, `smooth-responder` never starts, and
`files.intake_status` never leaves `processing` — a permanent deadlock, not a slow recovery. The same
shape of gap existed one layer up: `job_intake_locks`' staleness check only runs inside
`tryAcquireJobLock`, which only runs when a *new* upload arrives for the same job — a builder who
just waits gets no second trigger, ever. And `document-worker`'s `triggerNext`/`triggerClassification`
fetches are fire-and-forget with a swallowed `catch` — a lost network call has no retry at all.

**`GET /api/cron/intake-recovery`** (`app/api/cron/intake-recovery/route.ts`, scheduled every 5 min
in `vercel.json`) is the fix, and it is deliberately independent of all of the above: it reads
current DB state cold, on a fixed schedule, and decides what to reclaim/resume with no dependency on
any previous invocation, worker, lock holder, or connected client still being alive. Five steps, all
using SQL primitives from migration 037:

1. `reclaim_stale_document_jobs()` (no batch filter — sweeps every builder's batches in one pass) —
   requeues (or permanently fails, past 3 attempts) any `document_processing_jobs` row stuck
   `running` past 3 minutes.
2. `recompute_stalled_batches()` — defense-in-depth re-derivation for a batch stuck `pending`/`running`
   with no non-terminal children; should be a no-op in steady state since `recompute_parent_batch_status`
   already runs transactionally with every child completion.
3. `find_batches_with_claimable_work()` — batches with a claimable (reclaimed, or simply never
   claimed) pending job. One fresh `document-worker` invocation per batch is enough: `triggerNext`
   keeps the chain going from there exactly as it would have originally.
4. `find_stale_job_intake_locks()` → `acquire_or_reclaim_job_intake_lock()` (atomic — re-verifies
   staleness under `FOR UPDATE` at the moment of reclaim, not just at the earlier read, so a lock
   that made real progress in between is correctly left alone) — reclaims a dead `smooth-responder`
   run's lock and re-triggers the pipeline for that file (via its `processing_batch_id` when the
   queue model was used, so Stage 1/2 re-reads each document's already-persisted extraction result
   instead of re-downloading/re-parsing).
5. `find_stuck_files_needing_classification_retry()` — closes the `triggerClassification`-fetch-lost
   gap: a batch that finished and flipped `classification_triggered`, but no `job_intake_locks` row
   ever appeared for the job, means `smooth-responder` was never actually reached. Re-fired directly,
   itself gated through `acquire_or_reclaim_job_intake_lock` so it can never race a run already in
   flight.

**Why this can't double-process.** Every primitive above is either a plain read, an atomic
conditional `UPDATE` (`claim_next_document_job` row-locks via `FOR UPDATE SKIP LOCKED`), or an atomic
acquire-or-reclaim (`acquire_or_reclaim_job_intake_lock`, which unifies what used to be two
independently-implemented, slightly-racy "steal a stale lock" code paths — the pre-existing
`tryAcquireJobLock` REST dance and this cron — into one SQL function with one definition of
staleness). Running this route twice concurrently, or every 5 minutes forever, never claims the same
row twice or fires a duplicate `smooth-responder` run for a job already in flight. `intake_recovery_runs`
(migration 037) is a persistent, queryable audit row per cron execution — counts reclaimed/resumed/
retried, duration, and any per-stage errors — so a later incident is diagnosable from SQL history,
not just whatever's left of the function's own log retention.

**Bounded per run** (`MAX_BATCHES_PER_RUN` / `MAX_LOCKS_PER_RUN` / `MAX_STUCK_FILES_PER_RUN` = 20/10/10
in the route): deliberate backpressure so a systemic outage (e.g. Anthropic down, every batch
stalling) can't turn one cron run into an unbounded re-trigger storm — a capped run still makes
visible, logged progress, and the next scheduled run picks up the rest.

**AI call timeouts, the other half of "no request can hang indefinitely."** Before this work, no
Claude call anywhere in the codebase had an explicit timeout — a hung upstream connection blocks on
I/O wait, which Supabase's CPU-time governor (metered CPU, not wall clock) never interrupts. Every
`anthropic.messages.create` call (smooth-responder's shared `callTool`, and each of the ten Next.js
route call sites — chat's three, email-draft, email-sync parse/simulate, scope-hints,
rates/extract-pdf, classify-document, estimation/history) now goes through `withTimeoutAndRetry`
(`supabase/functions/smooth-responder/pipeline-logic.ts` — dependency-free, so it's the one shared
implementation importable identically from Deno and from Next.js via the same relative-path pattern
`shouldGiveUp` already used): an `AbortController`-backed timeout (the signal is passed into the SDK
call itself, so the abort actually cancels the in-flight HTTP request) plus one bounded, backed-off
retry for transient failures only (429/5xx/abort — see `isRetryableApiError`; a 400/401 fails
immediately rather than wasting the retry budget on a deterministic failure). `smooth-responder`'s
stages use 150s (large multi-thousand-token reasoning calls); the Next.js routes use 30–90s depending
on payload size. A failure that survives the retry rethrows exactly as before — every call site's
existing graceful-failure handling (fallback to keyword routing, a 500 with a clear message, etc.) is
unchanged, only now bounded in time rather than unbounded.

**Frontend: the stuck-detection signal was unreliable, not just slow.** `IntakeProgress.tsx`'s
give-up clock (`lastProgressAtRef`) only updated on `progress` (stage/pct) events — during the
document-worker queue phase, `files.intake_stage`/`intake_pct` don't move at all (only classification
writes those), so the ref was frozen at component-mount time for that entire phase and reconnects
(mandatory every ~260s) could see an ever-growing, stale gap even while the pipeline was genuinely
processing one document after another. The `document_progress` event handler now also bumps this ref
— a per-document status change IS real progress. Separately, `STUCK_TIMEOUT_MS` (the server-side
give-up point, `app/api/intake/[fileId]/route.ts`) moved from 5 to 9 minutes — comfortably above the
recovery cron's own worst-case detection+action latency (3 min staleness window + up to 5 min until
the next scheduled run) — so a connected client doesn't show a false "timed out" for a run recovery
was seconds from fixing on its own. Recovery itself never depends on this value; it only controls how
long a *connected* client waits before surfacing an error.

**Operational considerations:**
- **Actual trigger, live today**: `.github/workflows/intake-recovery-cron.yml` calls
  `scripts/trigger-cron-route.mjs` (`ROUTE_PATH=/api/cron/intake-recovery`) every 5 minutes against
  the real Railway URL — confirmed working end to end (a manual `workflow_dispatch` run found and
  resumed 2 stuck batches + 1 stuck lock in production on first trigger). `vercel.json`'s cron entry
  for this route is not what's running it — see "Hosting" above; Vercel isn't even deploying `main`.
  GitHub's own scheduler is best-effort and can slip by several minutes under load — acceptable here
  since every run is idempotent and a late/skipped run just means recovery takes one cycle longer,
  not incorrect. A Railway-native Cron Job service (`node scripts/trigger-cron-route.mjs` with
  `ROUTE_PATH=/api/cron/intake-recovery`, `APP_URL`, `CRON_SECRET` as service variables) is the
  tighter-guarantee alternative if GitHub's scheduling slop ever matters.
- **CRON_SECRET**: this route fails closed (503) in real mode if unset. Must be set on **Railway →
  Variables** for the `worka` service — that's the app that's actually running and actually checks
  this value. Setting it only on Vercel (easy mistake, since this file used to say Vercel was
  production) has no effect. The same value must also be present as a `CRON_SECRET` GitHub Actions
  repo secret for the trigger workflow to authenticate successfully.
- **Monitoring**: `intake_recovery_runs` is the first place to look during an incident — a healthy
  system shows frequent rows with all-zero counts (nothing to recover); a spike in
  `document_jobs_reclaimed`/`job_locks_reclaimed` is an early signal of a systemic extraction/Claude
  problem worth investigating via `stuck_document_jobs`/`document_processing_health_summary()`
  (`supabase/verification/health_monitoring_views.sql`), not just something this service quietly
  papers over forever.
- **Alerting** (not yet wired to a paging system — a natural next step, not implemented here): a
  non-zero `errors` array on a recent `intake_recovery_runs` row, or `stuck_jobs_count`/
  `batch_failure_rate_pct_7d` from `document_processing_health_summary()` trending up over several
  cron runs, are the two signals worth alerting on.

---

## TypeScript Compatibility Rules

- **Never spread a `Set` or iterate `Map.entries()` directly** — use `Array.from()` wrappers. The TypeScript target doesn't enable `--downlevelIteration`.
  ```ts
  // Wrong:  [...mySet]  or  for (const [k, v] of myMap.entries())
  // Correct: Array.from(mySet)  or  Array.from(myMap.entries()).forEach(...)
  ```
- Pre-existing errors from missing `node_modules` (`Cannot find module 'react'`, `Cannot find module 'next/server'`, etc.) are acceptable in `npm run type-check` output — they exist because the CI environment doesn't install packages. Do not attempt to fix them. Fix only errors in files you touch.

---

## Version Tracking

`next.config.mjs` bakes two env vars at build time:
- `NEXT_PUBLIC_APP_VERSION` — from `package.json` version field
- `NEXT_PUBLIC_COMMIT_SHA` — from `RAILWAY_GIT_COMMIT_SHA` (Railway, the actual production host — see
  "Hosting" above), falling back to `VERCEL_GIT_COMMIT_SHA` (only relevant if a Vercel deployment is
  ever revived) or local `git rev-parse --short HEAD`

These appear in the chat header. When bumping the version for a release, update `package.json` version.

---

## Styling — Non-Negotiable Rules

All components use CSS custom properties. **Never use Tailwind color utilities** (`bg-slate-*`, `text-gray-*`, `bg-white`, etc.) in any authenticated builder-facing component. Use CSS vars:

```
Backgrounds:   var(--bg-shell)  var(--bg-surface)  var(--bg-elevated)  var(--bg-border)
Text:          var(--text-primary)  var(--text-secondary)  var(--text-tertiary)
Brand:         var(--orange-primary)  var(--orange-subtle)
Status:        var(--status-green)  var(--status-amber)  var(--status-red)  var(--status-blue)
Pill:          var(--pill-awaiting-bg)  var(--pill-awaiting-border)  var(--pill-awaiting-text)
```

RGBA equivalents for tinted backgrounds (use when `rgba()` needed):
- Green bg: `rgba(76,175,80,0.15)` / Red bg: `rgba(244,67,54,0.1)` / Amber bg: `rgba(255,152,0,0.1)` / Blue bg: `rgba(33,150,243,0.1)`

Tailwind **utility classes** (layout, spacing, flex, grid, rounded, etc.) are fine. Only color classes are banned.

- Tailwind CSS 3 with custom `brand` colour palette (orange-based, `brand-500` = `#d88428`)
- Custom utilities in `tailwind.config.ts`: `.pt-safe`, `.pb-safe`, `.pl-safe`, `.pr-safe` for iPhone safe-area insets
- `app/globals.css` defines `.btn-primary`, `.btn-secondary`, and other shared utility classes
- Inter font (sans), JetBrains Mono (mono)

---

## Worker / Mobile Portal

- Invites are created via chat's `add_worker` intent (`createWorker()` in `chat/route.ts`), which writes a real `workers` row with a DB-generated `invite_token` and returns an `/join/<token>` link (shown in `WorkerModal.tsx` for SMS/WhatsApp/email/copy-link sharing).
- `/join/[token]` — 3-step onboarding flow for invited workers (`JoinFlow.tsx`). The server component (`page.tsx`) looks up the real invite by token (workers table + any already-assigned job via `job_workers`) in real mode; demo mode uses the two seeded invites in `lib/worker-demo.ts`. An unrecognised token now correctly shows "invalid invite link" (it used to silently fall back to the first seeded invite for any token). On completing the phone step, `JoinFlow` POSTs the confirmed name/phone to `POST /api/join/[token]`, which persists them, flips the worker's status `invited → active`, and sets the `/worker` session cookie (`lib/auth/worker-session.ts`) — a hashed, expiring token, since workers don't have full Supabase Auth accounts.
- `/worker` — mobile-first portal showing today's site, tasks, quick actions. Reads the session cookie server-side (`lib/worker-portal-data.ts`) and resolves that specific worker's real assigned jobs (`job_workers`), next milestone (`job_milestones`), and tasks (`job_tasks`) — it no longer unconditionally renders a hardcoded demo worker to anyone who requests the URL. No valid session shows a "use your invite link" prompt instead. Some `DemoWorkerJob` display fields have no real schema backing (site start time, "Week X of Y") — the UI hides those specific elements rather than fabricating values for them.
- Uses `env(safe-area-inset-*)` via `.pt-safe`/`.pb-safe` for iPhone home bar
- Task completion in the portal is currently local UI state only (not yet persisted) — wiring it to `POST /api/jobs/[jobId]/tasks` would require a worker-session-authenticated variant of that route (it currently requires a builder session), which is a reasonable next step but wasn't in scope for the identity fix above.

---

## Non-Negotiable Safety Rules

1. **Never send without builder approval.** No quote, invoice, variation, or email reaches a client without explicit builder confirmation.
2. **Never invent quantities.** Failed AI extractions create assumptions; builder must resolve all before quote progresses to `pending_review`.
3. **Forward-only state machines.** Write guards on every status-change function.
4. **Zero raw data in the UI.** Format all amounts as AUD, all dates as relative strings.
5. **Builder data isolation.** Every query must filter by `builder_id`, derived from the authenticated session (`getAuthenticatedBuilderId()`) — never trust a client-supplied `builder_id` from a request body or query string. Service role key only in server-side code (API routes, edge functions) — never in browser code. Every route uses the service role key today (which bypasses RLS), so RLS is a backstop, not the primary enforcement — this rule is.
6. **13 trade categories are immutable.** All rate and quote logic depends on fixed `sort_order` 1–13.

---

## Environment Variables

See `.env.local.example`. Key variables:

| Variable | Where used |
|----------|-----------|
| `NEXT_PUBLIC_SUPABASE_URL` | All Supabase clients; absence (or the literal placeholder `your-supabase-url`) triggers fallback data mode — see `isDemoMode()` in `lib/auth/api-auth.ts` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | Every API route constructs its own `createClient(url, serviceRoleKey)` inline (no shared admin-client singleton — see "Auth" above) |
| `ANTHROPIC_API_KEY` | `/api/chat` (intent classification, in-process), `/api/email-sync/parse`, `/api/email-draft`, `/api/classify-document`, `/api/estimation/scope-hints`, the `smooth-responder` edge function |
| `VOYAGE_API_KEY` | Optional. The `smooth-responder` edge function's fact de-duplication (`voyage-3-lite` embeddings) — must be set as a Supabase Edge Function secret, not just in the Next.js app's env, since it's only ever read inside that Deno function. Unset = the engine just falls back to exact category+key supersession, never fatal. |
| `NEXT_PUBLIC_APP_URL` | OAuth redirect URIs, worker invite links, internal fetch calls |
| `RAILWAY_GIT_COMMIT_SHA` | Auto-injected by Railway (the actual production host) for a GitHub-triggered deploy; baked into `NEXT_PUBLIC_COMMIT_SHA` at build time — see "Version Tracking" below |
| `VERCEL_GIT_COMMIT_SHA` | Auto-injected by Vercel, if a Vercel deployment is ever used (not currently — see "Hosting" above); same purpose as `RAILWAY_GIT_COMMIT_SHA`, checked second |
| `GOOGLE_CLIENT_ID/SECRET` | Gmail OAuth |
| `MICROSOFT_CLIENT_ID/SECRET` | Outlook OAuth |
| `RESEND_API_KEY` | Email delivery |
| `EMAIL_FROM_ADDRESS` | From address for outbound client emails; defaults to `hello@getworka.com` if unset |
| `CRON_SECRET` | Auth for all three `/api/cron/*` routes (morning-brief, network-rates, intake-recovery) — sent as a Bearer token by the GitHub Actions workflows that trigger them (see "Hosting" above; NOT Vercel Cron, despite the routes' own `RequestOptions` shape looking generic). Must be set on **Railway → Variables** (the actual running app) — setting it only on Vercel has no effect. All three routes fail closed (503) if unset while Supabase is configured — never fail open. |
| `MORNING_BRIEF_TEST_EMAIL` | Demo-mode recipient for the daily brief email |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | **Reserved, not implemented.** No code reads these — SMS notifications were never built. |
| `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | **Reserved, not implemented.** No code reads these (though `builders.stripe_customer_id` exists in the schema) — payment collection was never built. |
