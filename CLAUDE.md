# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
npm run dev          # start dev server (localhost:3000)
npm run build        # production build
npm run type-check   # tsc --noEmit — run this before every commit
npm run lint         # eslint
```

No test suite exists yet. Type-check is the primary correctness gate.

---

## Git Rules

- **Always commit directly to `main`** — Railway auto-deploys from main to getworka.com
- When given a feature branch, develop there then merge to main before finishing
- Run `npm run type-check` before every commit; fix all new errors (pre-existing module-not-found errors from missing node_modules are acceptable)
- Push with `git push -u origin <branch>` or `git push origin main`

---

## What WorkA Is

AI-powered operations manager for Australian residential builders. Builders type in plain English; WorkA classifies intent, executes backend logic, and returns plain-English results. Zero raw data ever shown in the UI — amounts in AUD, dates as "3 days ago", never ISO strings.

---

## The Four-Layer Architecture

Every feature spans exactly four layers. **Never cross them.**

```
Layer 1 — Intent (AI)
  classify-intent edge function
  Input: raw message string
  Output: { intent, entities, confidence }
  Rule: ONLY classifies — no DB queries, no mutations

Layer 2 — Decision (Backend)
  Supabase edge functions: morning-brief, create-worker, create-job
  Rule: ONLY backend logic — never calls Claude API (except classify-intent)
  Rule: NEVER sends to clients without builder approval

Layer 3 — Events (Schema)
  Structured event objects inside every Layer 2 response
  e.g. { type: 'open_upload_panel', job_id }
  Rule: events are instructions to the UI — data, not code

Layer 4 — Presentation (UI)
  Next.js App Router — renders events as modals, panels, alerts
  Rule: ONLY renders — never makes business decisions
```

---

## Request Flow: Chat Message → Response

1. `POST /api/chat` (`app/api/chat/route.ts`) receives `{ message, builder_id }`
2. Route calls the `classify-intent` Supabase edge function (or keyword-matches when Supabase is unavailable)
3. Intent dispatched to a handler (`handleMorningBrief`, `handleAddWorker`, `handleNewJob`, `handleMarginQuery`, etc.)
4. Handler returns a `ChatResponse` including an optional `event` field
5. `ChatInterface` receives the response, renders a `ChatMessage`, and fires UI side-effects based on `event.type`

**Extended intents** (handled entirely in the Next.js route, not by edge functions):
`email_draft` | `email_sync_status` | `simulate_email` | `margin_query`

### New job flow — address follow-up

When the initial "new job" message contains no address, the chat route asks "Which address is this job at?" and returns the `new_job` intent with no job created. `ChatInterface.tsx` sets `awaitingAddressForNewJob` state on that response. On the next `sendMessage` call, if that flag is set, the payload sent to `/api/chat` is silently prefixed with `"new job at "` so the classifier routes it correctly. The message **displayed in chat is never modified** — only the API payload.

**This is the canonical pattern for two-step chat flows.** Any future flow that requires a follow-up answer should track pending intent in a `useState` flag inside `ChatInterface.tsx` and rewrite only the outgoing API payload, leaving the displayed message unchanged.

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

- `middleware.ts` — protects `/chat`, `/settings/*`, `/dashboard`; redirects to `/login?next=<path>`
- `lib/auth/get-session.ts` — `getSessionUser()` for server components (cookies-based)
- `@supabase/auth-helpers-nextjs` v0.10 is the only Supabase auth helper used:
  - Client components: `createClientComponentClient<Database>()`
  - Server components: `createServerComponentClient<Database>({ cookies })`
  - Middleware: `createMiddlewareClient<Database>({ req, res })`
- `lib/supabase/client.ts` — singleton browser client (use in client components when you don't need cookie-based auth)
- `lib/supabase/server.ts` — server client + `createAdminClient()` (service role, bypasses RLS — edge functions only)

---

## Key UI Components

### Chat layer (`components/chat/`)
| Component | Role |
|-----------|------|
| `ChatInterface.tsx` | Main chat UI — message history, input, side-effect dispatcher for all `event.type` values |
| `ChatMessage.tsx` | Single message bubble — renders text + inline action buttons |
| `MorningBriefCard.tsx` | Structured morning brief with ranked alerts, inline priority badges, clickable rows |
| `UploadPanel.tsx` | File upload drawer; opens on `open_upload_panel` event |
| `WorkerModal.tsx` | Worker created confirmation; opens on `open_worker_modal` event |
| `EmailDraftModal.tsx` | Draft email for approval; opens on `open_email_draft` event |
| `MarginCard.tsx` | Per-job margin display with status pills |
| `AssumptionReview.tsx` | AI assumption resolution (accept / adjust / exclude); also renders SimilarJobsCard and ScopeIntelligenceCard from estimation memory |
| `ActivationModal.tsx` | Job activation confirmation — shows 8 milestones + 5 invoices |
| `InboundEmailAlert.tsx` | Floating overlay on `inbound_email_alert` event |
| `IntakeProgress.tsx` | SSE progress bar during PDF extraction; passes `memoryData` to `onComplete` |

### Estimation layer (`components/estimation/`)
| Component | Role |
|-----------|------|
| `SimilarJobsCard.tsx` | Shows matched historical projects with similarity %, quoted/final cost, variance |
| `ScopeIntelligenceCard.tsx` | Scope gap hints with confidence levels; Accept (adds to scope) / Dismiss per item |
| `ExplainabilityCard.tsx` | Per-trade confidence bars, similar project range, key drivers, accordion expand |

### Job panel layer (`components/job/`)
| Component | Role |
|-----------|------|
| `JobSnapshotPanel.tsx` | Right-side split panel — tabbed job detail view |
| `MobileJobSheet.tsx` | Bottom sheet version on mobile |
| `tabs/OverviewTab.tsx` | Job summary, milestones, team |
| `tabs/QuoteTab.tsx` | Quote summary + activate button |
| `tabs/VariationsTab.tsx` | Variation list + approval flow |
| `tabs/InvoicesTab.tsx` | Invoice schedule |
| `tabs/FilesTab.tsx` | Uploaded files |
| `tabs/CommsTab.tsx` | Communication history |
| `tabs/ProofTab.tsx` | Proof event timeline grouped by date |

### Quote layer (`components/quote/`)
| Component | Role |
|-----------|------|
| `QuoteView.tsx` | Full quote modal — category accordion, PC/PS register, sell price per line, confidence indicators |
| `SendQuoteModal.tsx` | Send quote confirmation with email preview |

### Dashboard (`app/dashboard/`)
| Component | Role |
|-----------|------|
| `DashboardShell.tsx` | Command Centre — greeting, stats bar, Universal Drop Zone, alerts/recommendations grid |
| `components/dashboard/UniversalDropZone.tsx` | Drag-and-drop or click upload (PDF/image) or plain-English question input routing to `/chat?q=...` |

### Shell (`app/chat/`)
- `page.tsx` — async server component; calls `getSessionUser()`, passes session props to `ChatShell`
- `ChatShell.tsx` — client component; owns layout state (`activeJob`, `panelVisible`, `pendingUpload`, `pendingEmailDraft`, `pendingQuoteView`); bridges `ChatInterface` ↔ `JobSnapshotPanel`

**Pending state pattern** — ChatShell passes intent-carrying state down to ChatInterface:
- `pendingUpload: ActiveJob | null` → ChatInterface opens UploadPanel for that job
- `pendingEmailDraft: { jobId, intentHint }` → ChatInterface opens EmailDraftModal
- `pendingQuoteView: string | null` (quote_id) → ChatInterface scrolls to quote

---

## API Routes (`app/api/`)

| Route | Purpose |
|-------|---------|
| `POST /api/chat` | Main chat handler — intent classification + dispatch |
| `POST /api/intake/[fileId]` | AI extraction pipeline v2 — 12 SSE stages including memory retrieval and scope intelligence |
| `POST /api/upload` | File upload to Supabase Storage |
| `GET /api/dashboard` | Dashboard stats, alerts, recommendations (derived from live job/invoice/variation data) |
| `GET /api/jobs` | Job list for snapshot panel |
| `GET/POST /api/quotes` | Quote fetch and creation |
| `GET /api/quotes/[quoteId]` | Full quote with line items grouped by trade category |
| `GET /api/quotes/[quoteId]/export-pdf` | HTML quote export |
| `POST /api/quotes/[quoteId]/send` | Send quote to client via Resend |
| `POST /api/quotes/[quoteId]/revise` | Create revised quote version |
| `GET/POST /api/variations` | Variation management |
| `POST /api/estimation/scope-hints` | Pattern-match scope gaps for a project type |
| `POST /api/classify-document` | Claude classifies an uploaded PDF/image document type |
| `GET /api/email-sync/connect` | OAuth initiation (Gmail / Outlook) |
| `GET /api/email-sync/callback` | OAuth token exchange |
| `POST /api/email-sync/parse` | Classify and log an inbound email |
| `GET /api/email-sync/status` | Check OAuth connection status |
| `POST /api/email-sync/simulate` | Trigger demo email scenario |
| `POST /api/email-draft` | Generate draft email via Claude |
| `POST /api/assumptions` | Resolve an AI assumption |

---

## Supabase Edge Functions (`supabase/functions/`)

All use Deno + ESM. Deployed to Supabase; called from Next.js API routes via `fetch`.

| Function | Layer | Purpose |
|----------|-------|---------|
| `classify-intent` | 1 (AI) | Calls Claude to classify builder messages |
| `morning-brief` | 2 (Decision) | Ranked daily alerts from DB |
| `create-worker` | 2 (Decision) | Creates worker row + generates invite URL |
| `create-job` | 2 (Decision) | Duplicate-checks address, creates job |

**Model used in edge functions**: `claude-sonnet-4-20250514`

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
4. `cost_rates` — 360+ platform defaults (seeded migration 002), state-aware
5. `network_rate_aggregates` — anonymised P50 across all builders

**Migrations** (apply in order via `supabase db push`):
```
001_initial_schema.sql        — all tables, RLS, 13 trade categories
002_seed_data.sql             — 360+ cost rates
003_storage_bucket.sql        — Supabase Storage bucket
004_email_sync.sql            — email_sync_state table
005_job_activation.sql        — job_milestones, invoice_schedule, proof_events
006_rbac_refs.sql             — role-based access refs
007_job_workers.sql           — job ↔ worker assignment
008_auto_create_builder.sql   — auto-create builder profile on signup
008_job_context_fields.sql    — extra fields on jobs table
009_job_deadlines.sql         — deadline tracking on jobs
010_search_indexes.sql        — performance indexes
011_estimation_memory.sql     — trade_subcategories (82 rows), project_memory (pgvector),
                                cost_reconciliation, builder_estimation_profiles,
                                scope_intelligence_patterns (5 renovation patterns seeded)
012_quote_data_model.sql      — adds to quote_line_items: labour_cost, material_cost,
                                subcontract_cost, plant_cost, pricing_type
                                (measured/pc_allowance/provisional_sum), source_ref,
                                margin_pct; trigger enforces 0% margin on provisional_sum rows
```

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
| `trade_subcategories` | 82 subcategory codes under the 13 trades (e.g. `ELEC-POWER`, `TILE-FLOOR`) |
| `project_memory` | One row per completed/active job — stores metadata, cost actuals, embedding (nullable `vector(1536)`) |
| `cost_reconciliation` | Per-line actual vs quoted cost; drives the feedback loop |
| `builder_estimation_profiles` | Learned builder preferences: margin, region, finish level, accuracy score |
| `scope_intelligence_patterns` | Known scope gaps by job type — matched at intake time |

**Similarity scoring** is done in-process (no vector API required): job type (+30), floor area within 20% (+15), same region (+15), same finish level (+15), wet area count (+10), storeys (+10). Minimum score 50 to be surfaced.

---

## Intake Pipeline v2 (`app/api/intake/[fileId]/route.ts`)

12 SSE progress stages:

| Stage | % | Description |
|-------|---|-------------|
| `uploading` | 5 | File received |
| `reading` | 15 | PDF parsed |
| `metadata` | 25 | Fast metadata extraction (Claude Haiku) |
| `retrieving_memory` | 35 | Similar project retrieval from `project_memory` |
| `extracting_site` | 44 | Site works & concrete |
| `extracting_framing` | 52 | Framing quantities |
| `extracting_roofing` | 60 | Roofing |
| `extracting_fitout` | 68 | Fit-out & finishes |
| `extracting_elec` | 76 | Electrical & prelims |
| `scope_intelligence` | 84 | Pattern-match scope gaps |
| `validating` | 90 | Validation gates |
| `building_quote` | 95 | Quote row + line items created |

**Validation gates:**
- Gate 1: no unit → assumption (unresolved). Exempt: `pc_allowance`, `provisional_sum`
- Gate 2: quantity but no dimensions_string → assumption (unresolved). Exempt: `pc_allowance`, `provisional_sum`
- Gate 3: quantity ≤ 0 → assumption (excluded)

**`onComplete` payload** includes `similar_projects`, `scope_hints`, `total_in_memory` — passed through `IntakeProgress` → `UploadPanel` → `ChatInterface` → `AssumptionReview`.

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
- `NEXT_PUBLIC_COMMIT_SHA` — from `RAILWAY_GIT_COMMIT_SHA` (Railway) or local `git rev-parse --short HEAD`

These appear in the chat header. When bumping the version for a release, update `package.json` version.

---

## Styling

- Tailwind CSS 3 with custom `brand` colour palette (orange-based, `brand-500` = `#d88428`)
- Custom utilities in `tailwind.config.ts`: `.pt-safe`, `.pb-safe`, `.pl-safe`, `.pr-safe` for iPhone safe-area insets
- `app/globals.css` defines `.btn-primary`, `.btn-secondary`, and other shared utility classes
- Inter font (sans), JetBrains Mono (mono)

---

## Worker / Mobile Portal

- `/join/[token]` — 3-step onboarding flow for invited workers (`JoinFlow.tsx`)
- `/worker` — mobile-first portal showing today's site, tasks, quick actions
- Uses `env(safe-area-inset-*)` via `.pt-safe`/`.pb-safe` for iPhone home bar

---

## Non-Negotiable Safety Rules

1. **Never send without builder approval.** No quote, invoice, variation, or email reaches a client without explicit builder confirmation.
2. **Never invent quantities.** Failed AI extractions create assumptions; builder must resolve all before quote progresses to `pending_review`.
3. **Forward-only state machines.** Write guards on every status-change function.
4. **Zero raw data in the UI.** Format all amounts as AUD, all dates as relative strings.
5. **Builder data isolation.** Every query must filter by `builder_id`. Service role key only in edge functions — never in browser code.
6. **13 trade categories are immutable.** All rate and quote logic depends on fixed `sort_order` 1–13.

---

## Environment Variables

See `.env.local.example`. Key variables:

| Variable | Where used |
|----------|-----------|
| `NEXT_PUBLIC_SUPABASE_URL` | All Supabase clients; absence triggers fallback data mode |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | `createAdminClient()` in server/edge contexts |
| `ANTHROPIC_API_KEY` | `/api/chat` (classify), `/api/email-sync/parse`, `/api/email-draft`, `/api/intake/[fileId]`, `/api/estimation/scope-hints` |
| `NEXT_PUBLIC_APP_URL` | OAuth redirect URIs, worker invite links, internal fetch calls |
| `RAILWAY_GIT_COMMIT_SHA` | Baked into `NEXT_PUBLIC_COMMIT_SHA` at build time |
| `GOOGLE_CLIENT_ID/SECRET` | Gmail OAuth |
| `MICROSOFT_CLIENT_ID/SECRET` | Outlook OAuth |
| `RESEND_API_KEY` | Email delivery |
