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
2. Route calls the `classify-intent` Supabase edge function (or keyword-matches in demo mode)
3. Intent dispatched to a handler (`handleMorningBrief`, `handleAddWorker`, `handleNewJob`, `handleMarginQuery`, etc.)
4. Handler returns a `ChatResponse` including an optional `event` field
5. `ChatInterface` receives the response, renders a `ChatMessage`, and fires UI side-effects based on `event.type`

**Extended intents** (handled entirely in the Next.js route, not by edge functions):
`email_draft` | `email_sync_status` | `simulate_email` | `margin_query`

---

## Demo Mode

The entire app runs without Supabase by checking `process.env.NEXT_PUBLIC_SUPABASE_URL`. When not set:

- `middleware.ts` skips all auth checks
- `lib/auth/get-session.ts` → `getSessionUser()` returns the hardcoded demo user (id `00000000-0000-0000-0000-000000000001`, "Dave Nguyen")
- All API routes return in-memory demo data from `lib/*-demo.ts` files
- Edge functions are not called

**Demo data files** (all in `lib/`):
| File | Purpose |
|------|---------|
| `job-snapshot-demo.ts` | Demo jobs (Fitzroy, Toorak, Brunswick) |
| `variations-demo.ts` | Demo variations + mutable in-memory state |
| `quote-demo.ts` | Demo quotes and line items |
| `assumptions-demo.ts` | Demo AI assumptions |
| `activation-demo.ts` | Demo job activation state (in-memory map) |
| `comms-demo.ts` | Demo communication history |
| `worker-demo.ts` | Demo worker invites and worker portal data |

**Demo builder ID**: `00000000-0000-0000-0000-000000000001`  
**Demo jobs**: Fitzroy `000...010`, Toorak `000...011` / `000...020`, Brunswick `000...012` / `000...030`

---

## Auth

- `middleware.ts` — protects `/chat` and `/settings/*`; redirects to `/login?next=<path>`
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
| `MorningBriefCard.tsx` | Structured morning brief with ranked alerts |
| `UploadPanel.tsx` | File upload drawer; opens on `open_upload_panel` event |
| `WorkerModal.tsx` | Worker created confirmation; opens on `open_worker_modal` event |
| `EmailDraftModal.tsx` | Draft email for approval; opens on `open_email_draft` event |
| `MarginCard.tsx` | Per-job margin display with status pills |
| `AssumptionReview.tsx` | AI assumption resolution (accept / adjust / exclude) |
| `ActivationModal.tsx` | Job activation confirmation — shows 8 milestones + 5 invoices |
| `InboundEmailAlert.tsx` | Floating overlay on `inbound_email_alert` event |

### Job panel layer (`components/job/`)
| Component | Role |
|-----------|------|
| `JobSnapshotPanel.tsx` | Right-side split panel — tabbed job detail view |
| `MobileJobSheet.tsx` | Bottom sheet version on mobile |
| `tabs/OverviewTab.tsx` | Job summary, milestones, team |
| `tabs/QuoteTab.tsx` | Quote detail + activate button |
| `tabs/VariationsTab.tsx` | Variation list + approval flow |
| `tabs/InvoicesTab.tsx` | Invoice schedule |
| `tabs/FilesTab.tsx` | Uploaded files |
| `tabs/CommsTab.tsx` | Communication history |

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
| `POST /api/intake/[fileId]` | AI extraction pipeline for uploaded PDFs |
| `POST /api/upload` | File upload to Supabase Storage |
| `GET /api/jobs` | Job list for snapshot panel |
| `GET/POST /api/quotes` | Quote fetch and creation |
| `GET/POST /api/variations` | Variation management |
| `GET /api/email-sync/connect` | OAuth initiation (Gmail / Outlook) |
| `GET /api/email-sync/callback` | OAuth token exchange |
| `POST /api/email-sync/parse` | Classify and log an inbound email |
| `GET /api/email-sync/status` | Check OAuth connection status |
| `POST /api/email-sync/simulate` | Trigger demo email scenario |
| `POST /api/email-draft` | Generate draft email via Claude |
| `POST /api/assumptions` | Resolve an AI assumption |
| `GET /api/jobs/[jobId]/proof` | WorkA Proof trail for a job + hash-chain status |
| `GET /api/jobs/[jobId]/proof/export` | Download the Proof Pack (plain-text evidence document) |
| `GET /api/cron/morning-brief` | Vercel Cron target — emails the daily brief to every builder (guarded by `CRON_SECRET`) |

---

## WorkA Proof

`lib/proof.ts` is the central audit-trail engine. **Every consequential job action must call `recordProofEvent()`** — quote sent, variation approved/rejected, variation notice emailed, outbound client email, job activated. Events are SHA-256 hash-chained per job (each event's hash covers the previous event's hash), making the trail tamper-evident. `verifyProofChain()` re-validates the chain; the Proof tab (`components/job/tabs/ProofTab.tsx`) shows the trail and links the Proof Pack export at `/api/jobs/[jobId]/proof/export`.

Recording is best-effort: `recordProofEvent` never throws — a proof failure must not break the builder action it documents. Demo mode appends to the in-memory `demoProofLog`; real mode inserts into the `proof_events` table.

---

## Morning Brief Delivery

`vercel.json` schedules `GET /api/cron/morning-brief` daily at 20:45 UTC (6:45am AEST). The route authenticates via `Authorization: Bearer $CRON_SECRET`, asks the `morning-brief` edge function for each builder's ranked brief, formats it with `lib/morning-brief.ts`, and sends via Resend. Demo mode sends the demo brief to `MORNING_BRIEF_TEST_EMAIL` if set.

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
001_initial_schema.sql   — all tables, RLS, 13 trade categories
002_seed_data.sql        — 360+ cost rates
003_storage_bucket.sql   — Supabase Storage bucket
004_email_sync.sql       — email_sync_state table
005_job_activation.sql   — job_milestones, invoice_schedule, proof_events
006_rbac_refs.sql        — role-based access refs
007_job_workers.sql      — job ↔ worker assignment
```

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
| `NEXT_PUBLIC_SUPABASE_URL` | All Supabase clients; absence = demo mode |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | `createAdminClient()` in server/edge contexts |
| `ANTHROPIC_API_KEY` | `/api/chat` (classify), `/api/email-sync/parse`, `/api/email-draft`, `/api/intake/[fileId]` |
| `NEXT_PUBLIC_APP_URL` | OAuth redirect URIs, worker invite links |
| `GOOGLE_CLIENT_ID/SECRET` | Gmail OAuth |
| `MICROSOFT_CLIENT_ID/SECRET` | Outlook OAuth |
| `RESEND_API_KEY` | Email delivery |
| `CRON_SECRET` | Auth for `/api/cron/morning-brief` (Vercel Cron sends it as a Bearer token) |
| `MORNING_BRIEF_TEST_EMAIL` | Demo-mode recipient for the daily brief email |
