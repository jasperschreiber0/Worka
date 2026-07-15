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
and its `.test.ts`). It uses Node's built-in test runner and experimental TypeScript stripping
(needs Node 22.6+) specifically so it adds zero new dependencies — there is still no test
framework installed for the rest of the app.

---

## Git Rules

- **Always commit directly to `main`** — Vercel auto-deploys from main to getworka.com
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

`project_question` (`handleProjectQuestion` in `app/api/chat/route.ts`) is the first chat intent to read the reasoning engine's knowledge base (`project_facts` / `scope_items` / `clarifying_questions` — migration 026) — every other intent operates on `jobs`/`quotes`/`variations` only. Deliberately reuses those tables rather than a new `project_memory` table: `project_facts` already carries `evidence`, `confidence`, `source_document_id`, and a `superseded` flag that's never deleted (an audit trail — see `mergeFacts` in `supabase/functions/smooth-responder/pipeline-logic.ts` for how a fact gets superseded when a later document contradicts it). `buildProjectContext()` loads active (non-superseded) facts, pairs each superseded fact with whatever fact of the same `category`+`key` replaced it (this pairing *is* the conflict/change record — no separate conflict table), open `clarifying_questions` as "missing information", and `scope_items`; a single Claude call answers the builder's question grounded in that context, instructed to name superseded-vs-current facts explicitly and to say plainly when something isn't covered rather than guessing. Logs `project_question_answered` (job_id, memory_items_loaded, documents_referenced, context_chars, confidence_score, conflicts_detected, duration_ms) for observability. Demo mode (no `NEXT_PUBLIC_SUPABASE_URL`) returns an honest "connect a real project" message — the fallback `lib/*-demo.ts` data has no equivalent fact base to answer from.

Deliberately not built (evaluated, scope kept to what the audit showed was actually missing): a separate `project_memory` table (would duplicate `project_facts`), a second "consolidation" Claude call after every document (Stage 1/2 already does this comparison in the same call it makes today), and embeddings-based retrieval (a job's fact base is capped at 200 rows and already fits in one prompt — Voyage-embedding-based semantic dedup across documents already happens where it's needed, inside `smooth-responder`, migration 031).

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
| `GET /api/cron/morning-brief` | Vercel Cron target — emails the daily brief to every builder (guarded by `CRON_SECRET`, fails closed if unset in real mode) |
| `GET /api/cron/network-rates` | Vercel Cron target — nightly Tier-5 aggregation: anonymised P25/P50/P75 of learned rates (min 3 builders per aggregate; guarded by `CRON_SECRET`, fails closed if unset in real mode) |

**Rate limiting**: `lib/rate-limit.ts` caps requests per builder on the Claude-backed routes (`chat`, `classify-document`, `email-draft`) — a DB-backed atomic counter in real mode (`api_rate_limits` table, migration 021), an in-memory fixed window in demo mode.

---

## WorkA Proof

`lib/proof.ts` is the central audit-trail engine. **Every consequential job action must call `recordProofEvent()`** — quote sent, variation submitted/approved/rejected, variation notice emailed, outbound client email, job activated. Events are SHA-256 hash-chained per job (each event's hash covers the previous event's hash), making the trail tamper-evident. `verifyProofChain()` re-validates the chain; the Proof tab (`components/job/tabs/ProofTab.tsx`) shows the trail and links the Proof Pack export at `/api/jobs/[jobId]/proof/export`.

Demo-mode's in-memory proof log (and the other in-memory demo stores — activation, variations, comms) are best-effort and process-local: they don't survive a cold start or a second serverless instance. That's an acceptable limitation for a single always-warm demo deployment, but don't mistake it for a real persistence guarantee — real mode's `proof_events` table has no such limitation.

Recording is best-effort: `recordProofEvent` never throws — a proof failure must not break the builder action it documents. Demo mode appends to the in-memory `demoProofLog`; real mode inserts into the `proof_events` table.

---

## Morning Brief Delivery

`vercel.json` schedules `GET /api/cron/morning-brief` daily at 20:45 UTC (6:45am AEST). The route authenticates via `Authorization: Bearer $CRON_SECRET`, asks the `morning-brief` edge function for each builder's ranked brief, formats it with `lib/morning-brief.ts`, and sends via Resend. Demo mode sends the demo brief to `MORNING_BRIEF_TEST_EMAIL` if set.

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
| 1 Document Intelligence, 2 Project Understanding | `supabase/functions/smooth-responder` (Deno) | No Vercel timeout — a multi-call reasoning chain needs room to run in the background |
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

**Document processing queue (worker model) — each document gets its own CPU budget, not a share of one.** The gating above reduces the *chance* one file exhausts the shared per-invocation budget, but can't eliminate it — a genuinely pathological document can still blow through it and take the whole shared invocation down, since Supabase's CPU-time kill is external and uncatchable regardless of how conservative the gate was. Migration 034 adds `document_processing_batches` (one row per upload) and `document_processing_jobs` (one row per document); `supabase/functions/document-worker` claims and processes exactly one document per HTTP invocation, which per Supabase's own per-*request* CPU metering means a fresh 2000ms budget every time — one document's crash can no longer touch any other document's processing. Flow: `app/api/intake/[fileId]/route.ts` creates the batch + one job per file, then fires a small number (2) of parallel document-worker invocations; each claims a job via `claim_next_document_job` (`FOR UPDATE SKIP LOCKED` — real DB-level mutual exclusion, not an application lock, so two workers can never claim the same document), extracts it (the same `gateTextExtraction`/`ExtractionBudget` safeguards still apply, just scoped to one document instead of accounting for a whole batch), persists the result via `complete_document_job`, and triggers the next pending job as a **new** invocation (a same-invocation loop would not get a fresh CPU budget — that's the whole point). A catchable failure (not a CPU-kill) retries with backoff via `retry_or_fail_document_job` — 30s after the 1st failure, 2min after the 2nd, permanently failed after the 3rd — so one bad PDF degrades to "needs manual review" instead of taking the batch down. `recompute_parent_batch_status` (called by both RPCs) derives the batch's aggregate status from its children — `running` while any are still pending/running, `completed_with_failures` when some failed but at least one succeeded (a single bad PDF must not fail the whole batch), `failed` only if every document failed — and, in the same atomic UPDATE, flips `classification_triggered` false→true exactly once the moment the batch becomes fully terminal, so exactly one of the (possibly several) worker chains triggers `smooth-responder`'s classification stage, never zero and never twice. `smooth-responder`'s Stage 1/2 file-loading branches on whether it was invoked with a `parent_job_id`: if so, it reads each completed job's persisted extraction result (`loadAllFromExtractionResults`/`loadBlockFromExtractionResult`) instead of re-downloading and re-extracting — a vision-path document's binary is re-fetched from Storage at that point (plain I/O, not the CPU-bound parsing step that needed isolating), but never re-parsed. The legacy direct-invocation path (no `parent_job_id`) still exists in `runPipeline` for backward compatibility but is no longer what the Next.js route uses. The SSE poller reads `files.processing_batch_id` (set when the batch is created) to also poll `document_processing_jobs` and emit a `document_progress` event with a per-document checklist — `IntakeProgress.tsx` renders it above the existing stage-based progress bar, which takes back over once classification starts.

**Deliberately not implemented: summarizing documents before the reasoning stage.** This was evaluated alongside the above as a further token-reduction lever and rejected — it would add a whole extra Claude call per document (net cost/latency negative once you're already paying for the original read), and more fundamentally it conflicts with this pipeline's core guarantee ("never invent a fact — extract only what you can point to direct evidence for"): a summary is a step removed from source evidence, exactly the kind of lossy intermediate that guarantee exists to avoid. The vision-selective processing above gets the real token savings without that tradeoff.

**Timeout handling: stuck vs. slow are different things.** The SSE poller's `OVERALL_TIMEOUT_MS` (15 min, tracked via `overallStartedAt`) is still the hard ceiling regardless of activity, but a second, tighter signal — `STUCK_TIMEOUT_MS` (5 min) since `lastProgressAt`, a real stage or batch-index change — now lets a genuinely-hung run give up well before 15 minutes without penalizing a run that's legitimately working through several document batches. Both timestamps ride along in the SSE URL across the deliberate reconnects Vercel's 300s connection ceiling forces (same pattern as `started_at`), tracked client-side in `IntakeProgress.tsx` refs. See `shouldGiveUp` in `pipeline-logic.ts`.

**Stage 1/2 extraction sees prior facts, not just document titles.** The system prompt includes the job's already-established `project_facts` (not just a list of previously-processed document titles) so a newly-uploaded document is classified with real awareness of what earlier documents in the job established — it can extend, agree with, or correct that context instead of extracting in a vacuum. A fact that a new document corrects is marked `superseded = true` on the prior row (matched by `job_id` + `category` + `key`, differing value) rather than both rows accumulating forever and both landing in every future prompt.

**Fact de-duplication at scale (optional, Voyage AI).** As a job accumulates many documents, the same real-world fact often gets restated under a different `category`/`key` label per document (e.g. "gross floor area" vs `floor_area_m2`) — the exact-key supersession above won't catch that. If `VOYAGE_API_KEY` is set (as a Supabase Edge Function secret, not just in the Next.js app's env), each new fact is embedded (`voyage-3-lite`, 512 dimensions, stored on `project_facts.embedding` — migration 031) and compared by cosine similarity against the job's existing facts; anything above a 0.93 threshold is treated as the same fact restated and superseded the same way. Best-effort throughout — an unset key or a failed Voyage call just means that fact falls back to the exact-key check, never fatal to the pipeline. A separate hard cap (200 facts, highest-confidence kept) bounds prompt size regardless, in case a project genuinely has more distinct facts than that. This is deliberately not a chunking/RAG pipeline over raw PDFs — vision reads stay the extraction method; only the *fact list* gets this treatment.

**Validation gates:**
- Gate 1: no unit (or a genuinely undeterminable quantity, marked "Manual Input Required" by the model) → assumption (unresolved). Exempt: `pc_allowance`, `provisional_sum`, document-priced lines.
- Gate 2: quantity present but not traceable to evidence → assumption (unresolved). Same exemptions.
- Gate 3: quantity ≤ 0 → assumption (excluded).

See `lib/estimating/gates.ts` for the canonical spec.

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
- `NEXT_PUBLIC_COMMIT_SHA` — from `VERCEL_GIT_COMMIT_SHA` (Vercel) or local `git rev-parse --short HEAD`

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
| `VERCEL_GIT_COMMIT_SHA` | Auto-injected by Vercel; baked into `NEXT_PUBLIC_COMMIT_SHA` at build time |
| `GOOGLE_CLIENT_ID/SECRET` | Gmail OAuth |
| `MICROSOFT_CLIENT_ID/SECRET` | Outlook OAuth |
| `RESEND_API_KEY` | Email delivery |
| `EMAIL_FROM_ADDRESS` | From address for outbound client emails; defaults to `hello@getworka.com` if unset |
| `CRON_SECRET` | Auth for `/api/cron/morning-brief` and `/api/cron/network-rates` (Vercel Cron sends it as a Bearer token). Both routes fail closed (503) if unset while Supabase is configured — never fail open. |
| `MORNING_BRIEF_TEST_EMAIL` | Demo-mode recipient for the daily brief email |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | **Reserved, not implemented.** No code reads these — SMS notifications were never built. |
| `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | **Reserved, not implemented.** No code reads these (though `builders.stripe_customer_id` exists in the schema) — payment collection was never built. |
