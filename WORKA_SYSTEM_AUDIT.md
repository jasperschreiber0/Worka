# WORKA_SYSTEM_AUDIT.md

**Scope:** Full technical audit of the WorkA codebase as it exists on `main` at commit `9fdd0dc` (2026-07-19).
**Method:** Direct repository inspection — `Glob`/`Grep`/`Read` over the actual source, migrations, and edge functions. Where the checked-in `CLAUDE.md` was used as a secondary source, every load-bearing claim was cross-checked against real files; discrepancies found are called out explicitly (see §6.4).
**Not done:** No live database was queried (no production credentials in this session). No code was changed. No fixes were implemented. Anything that depends on live DB/production state is marked **UNKNOWN**.

---

## 1. What WorkA Is

### 1.1 Purpose
WorkA is an AI-operations layer for Australian residential builders. A builder uploads project documents (architectural drawings, engineering sets, priced BOQs, FF&E schedules) or types a request in plain English; the system classifies intent, runs backend logic, and returns a plain-English result. The stated design principle (`CLAUDE.md`, confirmed by the UI code — `MorningBriefCard.tsx`, `ChatMessage.tsx`) is **zero raw data in the UI**: amounts always rendered in AUD, dates always relative ("3 days ago"), never ISO timestamps.

### 1.2 Who uses it
Two distinct user classes, with separate auth mechanisms (see §2.4):
- **Builders** — full Supabase Auth accounts, use the chat interface (`/chat`) and settings pages. This is the primary product surface.
- **Workers** — invited by a builder via chat (`add_worker` intent), no Supabase Auth account; authenticate via a hashed, expiring session cookie (`lib/auth/worker-session.ts`) issued after completing `/join/[token]` onboarding. Access is limited to `/worker`, a mobile-first portal.
- **Clients** (a builder's customers) are a third, unauthenticated actor: they interact only via `/approve/variation/[variationId]`, gated by a per-variation share token, not a login.

### 1.3 Core user workflows (as implemented, verified against `app/api/chat/route.ts`'s intent switch, lines 1717–2524)
1. **New job creation** — `create_job` intent; if no address is given, a two-step follow-up flow (documented in `CLAUDE.md`, confirmed present in `ChatInterface.tsx`'s `awaitingAddressForNewJob` state).
2. **Document upload → estimate** — the central workflow, traced in full in §3.
3. **Quote review/send** — `QuoteView.tsx` + `SendQuoteModal.tsx`, gated by `deriveQuoteReadiness()` (`lib/estimating/readiness.ts`).
4. **Variation handling** — builder records/approves via chat or `POST /api/variations/[id]/resolve`; client approves via the public share-token portal.
5. **Worker invite/onboarding** — `add_worker` intent → `/join/[token]` → `/worker` portal.
6. **Morning brief** — daily ranked alert digest, delivered by email (cron) and replayed in-chat (`morning_brief` intent).
7. **Free-form project Q&A** — `project_question` intent, reads the reasoning engine's fact base (`lib/project-context.ts`).
8. **Rate/price-list management** — `/settings/rates`, CSV/PDF import routes.
9. **Parametric quick-estimate** — `/estimate`, `lib/estimation-engine.ts`, independent of the document pipeline (see §1.5).

### 1.4 Intended business logic
Everything a client sees must be builder-approved first (Non-Negotiable Safety Rule #1, `CLAUDE.md`; enforced in code by state machines that never auto-advance a quote past `pending_review` and by `deriveQuoteReadiness()` refusing to allow `send` on a `blocked` quote — confirmed in `lib/estimating/readiness.ts:61-107`). Cost data (`quotes.total_cost`, margin percentage) is never exposed client-side; only `applyMargin(cost, margin_pct)` output reaches a client (`lib/pricing.ts:286`).

### 1.5 Value proposition
Two independent estimating paths exist, not one:
- **Document-driven** (the "reasoning-first estimating engine", §3) — evidence-backed, per-line-item confidence, full audit trail (`project_facts.evidence`), the product's primary differentiator.
- **Parametric/history-driven** (`lib/estimation-engine.ts`) — `client_price = floor_area × ($/m² blended from similar past jobs)`, a fast ChatGPT-style estimate grounded in the builder's own delivered-job history (`project_memory` table), independent of any document upload. This second path is **not documented anywhere in `CLAUDE.md`** despite being a fully separate, shipped feature (`/estimate`, `POST /api/estimation/quick-estimate`) — see §6.4 finding.

Underneath both, `WorkA Proof` (`lib/proof.ts`) hash-chains every consequential action (quote sent, variation approved, email sent) per job — the audit-trail differentiator aimed at disputes.

---

## 2. Current Architecture

### 2.1 Frontend
- **Framework:** Next.js 14.2 (App Router), React 18.3, TypeScript 5.4. No state management library (no Redux/Zustand) — state lives in component `useState`/`useEffect`, lifted only as far as `ChatShell.tsx` (owns `activeJob`, `panelVisible`, `pendingUpload`, `pendingEmailDraft`, `pendingQuoteView` — verified in `app/chat/ChatShell.tsx`).
- **Structure:** `app/` (routed pages + all API routes co-located under `app/api/`), `components/` (7 subdirectories: `chat/`, `dashboard/`, `estimation/`, `home/`, `job/`, `quote/`, plus one loose `DeploymentGuard.tsx`), `lib/` (business logic, non-visual).
- **Styling:** Tailwind CSS 3 + CSS custom properties for all colour (never Tailwind colour utilities in authenticated views — a repo-wide convention, not lint-enforced; verified as a documentation-only rule, not a CI gate — see §6.4).
- **No test framework for components.** `npm run test` covers exactly two areas: `supabase/functions/smooth-responder/pipeline-logic.test.ts` (126 assertions as of this audit, confirmed passing) and `lib/project-context.test.ts` / `lib/readiness.test.ts`. Zero UI/integration tests exist.

### 2.2 Backend
No separate backend service — "backend" is entirely Next.js API routes (`app/api/**/route.ts`, 49 route files, confirmed by `find`) plus two runtimes that live outside the Next.js process:
- **Supabase Postgres** (RLS-enabled, but bypassed by every route — see §2.4).
- **Supabase Edge Functions** (Deno) — three functions exist on disk (`morning-brief`, `document-worker`, `smooth-responder`); confirmed only these three are invoked anywhere in the Next.js code (`grep -r "functions/v1"` across `app/`).

No queue/message broker (no SQS/RabbitMQ/Redis). The "queue" for document processing is a Postgres table (`document_processing_jobs`) claimed via `FOR UPDATE SKIP LOCKED`, driven by Edge Functions re-invoking themselves over HTTP (`document-worker`'s `triggerNext`, `EdgeRuntime.waitUntil`) — a self-chaining HTTP fan-out, not a managed queue. This is architecturally unusual and is a load-bearing design decision worth naming explicitly for anyone unfamiliar with it (§8).

### 2.3 Database structure
Postgres via Supabase, 53 migrations (`001_initial_schema.sql` → `053_stage3_checkpoint_and_wallclock_observability.sql`, confirmed sequential with no gaps or duplicate-prefix collisions as of this audit). Full table inventory in §5.

**Critical finding:** `lib/types/database.types.ts` (857 lines, hand-maintained per `CLAUDE.md`: *"keep in sync with migrations manually"*) is missing every table introduced by migration 030 onward that the document-processing queue and recovery system depend on:
```
job_intake_locks            — MISSING from database.types.ts
document_processing_batches — MISSING
document_processing_jobs    — MISSING
intake_recovery_runs        — MISSING
worker_sessions             — MISSING
```
Confirmed by direct grep (0 matches for all five names in the file). In practice this is **not currently causing type errors** because — second finding — **no file in the codebase uses the typed client** (`createClient<Database>(...)`) for direct table queries; every server route uses the untyped `createClient(url, key)` from `@supabase/supabase-js` (confirmed: 22 files match `from '@supabase/supabase-js'` in `app/api/`, 0 files match `createClient<Database>`). The `Database` generic is only used by the `@supabase/auth-helpers-nextjs` client factories (`createRouteHandlerClient<Database>`, etc.) for auth/session handling, not general queries. **Net effect:** the types file is largely decorative for anything written since mid-pipeline development — every Supabase call touching `files`, `document_processing_jobs`, `job_intake_locks`, etc. is effectively `any`-typed, and `tsc --noEmit` cannot catch a column-name typo or a shape mismatch anywhere in the intake pipeline. This is a real, present technical-debt item, not hypothetical.

### 2.4 Supabase usage
- **Auth:** `@supabase/auth-helpers-nextjs` v0.10 — four client factories used contextually (client component / server component / middleware / route handler), confirmed via `CLAUDE.md` and spot-checked in `lib/auth/api-auth.ts:44` (`createRouteHandlerClient<Database>`).
- **Storage:** one bucket, `plans` (confirmed in `app/api/upload/route.ts:99` and `document-worker/index.ts:91`). Upload is client → signed URL → direct-to-Storage PUT (bypasses Next.js body-size limits entirely — confirmed, `app/api/upload/route.ts:34-43` comment + code, `MAX_FILE_SIZE = 52428800` i.e. 50MB checked only against the client-declared `size`, not re-verified server-side after upload — **a client can declare an under-limit size and then PUT a larger file directly to the signed URL; Supabase Storage bucket-level size limits, if any, are UNKNOWN — not configured in any migration found in this repo**).
- **RLS:** every table has RLS per migration 001, but **every single API route and edge function uses the service-role key**, which bypasses RLS entirely (confirmed: all 22+ files above construct `createClient(url, SUPABASE_SERVICE_ROLE_KEY)`). `CLAUDE.md` states this explicitly as Non-Negotiable Safety Rule #5: *"RLS is a backstop, not the primary enforcement — [the `builder_id` filter in every query] is."* This is architecturally sound only if every single query is manually and correctly filtered by an authenticated `builder_id` — there is no defense-in-depth if one route forgets. This audit did not exhaustively verify every one of the 49 route files for a missing `builder_id`/ownership filter — flagged as **UNKNOWN, needs a dedicated pass** (see §9).
- **Realtime:** not used anywhere (no `supabase.channel()` calls found).

### 2.5 Authentication flow
Two independent, non-overlapping systems, confirmed by code:
1. **Builder session** — Supabase Auth cookie session, checked per-route via `getAuthenticatedBuilderId()` (`lib/auth/api-auth.ts:26`). `middleware.ts` (1174 bytes, confirmed short) protects `/chat` and `/settings/*` pages only — it does **not** cover `/api/**`, so every API route must call `getAuthenticatedBuilderId()` itself. This audit spot-checked ~10 routes; all called it. A systematic sweep of all 49 route files to confirm none skip auth was **not performed** — flagged as a required follow-up (§9).
2. **Internal service-to-service** — a route presenting `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` plus an `x-worka-builder-id` header is trusted (`api-auth.ts:29-41`) *because possessing the service-role secret is itself proof of internal origin*. This path exists for the intake worker calling into `scope-hints`-style internal routes, per the function's own comment. This is a reasonable pattern but means **the service-role key is a single point of total-system-trust**: anyone who obtains it (leaked env var, compromised Railway account) can impersonate any builder by setting `x-worka-builder-id` to any UUID, with no further check.
3. **Worker session** — `lib/auth/worker-session.ts`, a hashed/expiring token issued on `/join/[token]` completion, read by `/worker`. Independent of Supabase Auth.
4. **Client share tokens** — per-variation, hashed at rest, expiring (`POST /api/variations/[id]/share`). Forward-only.

### 2.6 Storage/file handling
Covered in §2.4 and traced fully in §3. One notable gap: **no antivirus/malware scanning, no MIME-type verification against actual file bytes** (only filename extension is checked — `detectFileType()`, `app/api/upload/route.ts:13-19` — a builder could upload an executable renamed `plans.pdf` and it would be classified `pdf` and passed to the extraction pipeline, which would presumably fail gracefully at the PDF-parsing stage, but this was not tested).

### 2.7 AI processing architecture
Covered fully in §4. Single model in use everywhere: `claude-sonnet-4-6` (confirmed hardcoded in `supabase/functions/smooth-responder/index.ts:557` and referenced identically in `CLAUDE.md`). Anthropic SDK version `^0.24.0` per `package.json`.

### 2.8 APIs and external services
| Service | Purpose | Confirmed usage |
|---|---|---|
| Anthropic (`ANTHROPIC_API_KEY`) | Intent classification, document extraction, scope reasoning, estimate generation, email drafting | 3 call sites in `chat/route.ts`, 3 in `smooth-responder/index.ts` (Stage 1/2, 3, 6), plus `classify-document`, `email-draft`, `email-sync/parse`, `email-sync/simulate`, `estimation/scope-hints`, `estimation/history`, `rates/extract-pdf` — 10 total call sites, matching `CLAUDE.md`'s own count |
| Voyage AI (`VOYAGE_API_KEY`, optional) | Fact-embedding de-duplication in `smooth-responder` only | confirmed optional/best-effort in code |
| Resend (`RESEND_API_KEY`) | Outbound email (quotes, morning brief, variation notices) | confirmed |
| Google/Microsoft OAuth | Email sync (Gmail/Outlook) | confirmed present but **UNKNOWN whether functional in production** — no test coverage, not exercised in this audit |
| Twilio, Stripe | Env vars reserved in `.env.local.example`, **zero code reads them** — confirmed by grep, matches `CLAUDE.md`'s own disclosure |

### 2.9 Background jobs / cron / recovery systems
Full detail in §3 and §5. Summary inventory:
| Mechanism | Trigger | Current state (verified from source, not production) |
|---|---|---|
| `morning-brief-cron.yml` (GitHub Actions, daily 20:45 UTC) | calls `GET /api/cron/morning-brief` | presumed active — not independently verified live |
| `network-rates-cron.yml` (GitHub Actions, daily 15:00 UTC) | calls `GET /api/cron/network-rates` | presumed active |
| `intake-recovery-cron.yml` (GitHub Actions, every 5 min) | calls `GET /api/cron/intake-recovery` | **the route itself currently has both internal kill switches set to `true`** (`DOCUMENT_RECOVERY_DISABLED = true`, `AI_RECOVERY_DISABLED = true`, confirmed at `app/api/cron/intake-recovery/route.ts:149,170` as of this commit) — the cron still fires, but every step inside the route is a no-op except the final audit-row insert. **This is a live, deliberate, currently-active state — the automatic recovery system for stuck uploads is fully off right now.** |
| `supabase/migrations/038_intake_recovery_pg_cron.sql` (pg_cron, every minute) | calls the same route via `pg_net` | same effective no-op as above; **UNKNOWN whether the one-time `vault.create_secret` setup this requires was ever actually run in production** — migration comment says it's required and logs a `WARNING` and skips if not done |
| `supabase-functions-deploy.yml` | on push to `supabase/functions/**` on `main` | deploys edge functions automatically |
| `supabase-migrate.yml` | on push to `supabase/migrations/**` on `main` | runs `supabase db push` + PostgREST reload automatically |
| `intake-pipeline-health-check.yml` (every 6h) | `scripts/synthetic-intake-health-check.mjs` | exercises real pipeline plumbing end-to-end against a disposable job; does not certify extraction accuracy (documented limitation in the script's own header, per `CLAUDE.md`) |
| `document-queue-reliability-check.yml` (on push to queue files) | `scripts/document-queue-reliability-check.mjs` | drives DB RPCs directly, no Claude calls |

### 2.10 Deployment architecture
- **Production host:** Railway (service "worka"), confirmed by `CLAUDE.md`'s own documented incident history (Vercel's project for this repo does not auto-deploy despite looking configured). **This audit did not independently re-verify live Railway state** — taken on trust from `CLAUDE.md`'s account, which itself documents having been wrong about this exact fact before (the `getworka.com` incident). Flagged as **UNKNOWN — should be re-confirmed directly in the Railway dashboard**, not re-assumed from a document that has been wrong about hosting once already.
- `vercel.json` still exists and declares 3 cron entries — inert per the same document (Vercel isn't deploying `main`).
- **Version tracking:** `next.config.mjs` bakes `NEXT_PUBLIC_COMMIT_SHA` from `RAILWAY_GIT_COMMIT_SHA` first, `VERCEL_GIT_COMMIT_SHA` second, local git third.
- **SSE/long-lived connections** are capped by Railway's edge proxy (5 min no-data close, 15 min hard cap) — this is a real, load-bearing constraint on the intake SSE route's design (§3).

---

## 3. Full Processing Lifecycle — Upload → Estimate → Quote

This is the single most complex subsystem in the codebase and the one with the most incident history (§7). Traced end-to-end against the actual source files, not summarized from `CLAUDE.md`.

### 3.1 Step-by-step trace

```
Browser                    Next.js API                         Supabase DB / Storage              Edge Functions
───────                    ───────────                         ──────────────────────             ──────────────
1. Select file(s)
2. POST /api/upload  ──────► app/api/upload/route.ts
                             • getAuthenticatedBuilderId()
                             • verify job belongs to builder
                             • createSignedUploadUrl('plans', path)
                             • INSERT files (intake_status='uploaded')  ─► files row created
                             ◄──── { file, upload_url }
3. Browser PUTs file bytes directly to upload_url ─────────────────────► Storage: plans/<path>
4. GET /api/intake/[fileId]?job_id=&siblings=  ──────► app/api/intake/[fileId]/route.ts (SSE, edge runtime)
                             • getAuthenticatedBuilderId()
                             • ownerCheck: files.builder_id == builder_id           [404 if not]
                             • alreadyProcessing = intake_status not in ('uploaded', null)
                             • IF NOT alreadyTriggered AND NOT alreadyProcessing:
                                 tryAcquireJobLock()  ───────────────────────────► INSERT job_intake_locks
                                                                                     (PK conflict = 409 = another
                                                                                      run holds it; stale-steal
                                                                                      logic if last_progress_at
                                                                                      > 6min old or started_at
                                                                                      > 16min old)
                                 query project_documents.extraction_status='complete'
                                   for allDocumentIds ──────────────────────────►  (skip already-classified docs
                                                                                     on a retry — migration 050)
                                 IF documentIdsNeedingProcessing == []:
                                     POST smooth-responder { file_id, job_id, resume:true }  ──► Stage 3 direct
                                 ELSE:
                                     createDocumentProcessingBatch()  ─────────────► INSERT document_processing_batches
                                                                                       (status='running')
                                                                                     INSERT document_processing_jobs
                                                                                       (one row per document,
                                                                                        status='pending')
                                                                                     UPDATE files.processing_batch_id
                                                                                     RPC recompute_batch_file_
                                                                                       intake_statuses
                                     fire WORKER_CONCURRENCY (min(4,N)) parallel
                                     POST document-worker { parent_job_id }  ──────────────────────────────► document-worker
                                                                                                                • claim_next_document_job
                                                                                                                  (FOR UPDATE SKIP LOCKED)
                                                                                                                • download from Storage
                                                                                                                • extractPdfTextGated()
                                                                                                                  (CPU-budget gated,
                                                                                                                   text-dense vs vision-only)
                                                                                                                • RPC complete_document_job
                                                                                                                  OR retry_or_fail_document_job
                                                                                                                • RPC recompute_file_intake_status
                                                                                                                • self-trigger next document-worker
                                                                                                                  (fresh CPU budget)
                                                                                                                • IF batch fully terminal:
                                                                                                                    POST smooth-responder
                                                                                                                      { parent_job_id }  ──────────► smooth-responder
                             • poll loop (1.5s interval, emits SSE progress/
                               document_progress/needs_clarification/complete/
                               error/reconnect events; self-closes at 260s to
                               respect Railway's connection ceiling; give-up
                               logic via shouldGiveUp(): 15min overall ceiling,
                               9min no-progress ceiling)
                                                                                                              smooth-responder runPipeline():
                                                                                                              ── Stage 1/2 (skipped if resume
                                                                                                                 or all docs already
                                                                                                                 extraction_status='complete') ──► project_documents,
                                                                                                                                                    project_facts
                                                                                                                 [wall-clock check before
                                                                                                                  each batch's Claude call]
                                                                                                              ── Stage 3+4 (Scope Reasoning +
                                                                                                                 Gap Detection) — SKIPPED if
                                                                                                                 document_processing_batches.
                                                                                                                 scope_reasoning_completed_at
                                                                                                                 already set (migration 053)  ──► scope_items,
                                                                                                                 [wall-clock check: needs 220s]     clarifying_questions
                                                                                                                 IF blocking question raised:
                                                                                                                   → files.intake_status='needs_info'
                                                                                                                   → RETURN (lock released)
                                                                                                              ── Stage 6 (Estimate Generation)
                                                                                                                 [wall-clock check: needs 150s]  ──► quote_line_items,
                                                                                                              ── Validation gates                     assumptions
                                                                                                              ── build/reuse quote                 ──► quotes
                                                                                                              ── files.intake_status='extracted'
                                                                                                                 (or derived via
                                                                                                                  recompute_batch_file_
                                                                                                                  intake_statuses)
                                                                                                              ── finally: DELETE job_intake_locks
5. IF needs_info: ClarifyingQuestionsPanel.tsx collects answers
   → POST /api/intake/[fileId]/clarify { job_id, answers }  ──► app/api/intake/[fileId]/clarify/route.ts
                             • INSERT project_facts (category='builder_answer',
                               confidence=100) per answer
                             • acquireLockOrWait() (20s bounded wait)
                             • POST smooth-responder { resume:true }  ────────────────────────────────────► resumes at Stage 3
6. On 'complete' SSE event:
   • ensureQuotePriced(quote_id)  ──► lib/pricing.ts: 5-tier rate resolution,
                                       recomputeQuoteTotals()
   • runQualityAssurance(quote_id, job_id)  ──► lib/estimating/qa.ts: writes
                                                 quotes.qa_report/overall_confidence
   • persistProjectUnderstanding(job_id)  ──► lib/project-context.ts: writes
                                               jobs.knowledge_confidence etc.
   • AssumptionReview.tsx renders for unresolved assumptions
7. Builder resolves assumptions → POST /api/assumptions/[quoteId]/resolve
   • when all resolved: quotes.status draft → pending_review
8. Builder reviews in QuoteView.tsx (deriveQuoteReadiness gates the Send button)
   POST /api/quotes/[quoteId]/send  ──► builds send draft, no mutation
   POST /api/quotes/[quoteId]/confirm-send  ──► atomic pending_review→sent guard,
                                                  Resend delivery, recordProofEvent()
```

### 3.2 Status transitions (verified against migrations + code, not just documentation prose)

**`files.intake_status`** (type in `database.types.ts`, `FileIntakeStatus`): `uploaded → processing → extracted | needs_info | failed`. As of migration 052, this column is **derived, not directly written**, for any file that went through the document-processing queue — `recompute_file_intake_status(file_id)` computes it from `document_processing_jobs.status` (per-document) and `document_processing_batches` / `clarifying_questions` (batch-level), and is called at every real transition point instead of an inline `UPDATE files SET intake_status=...`. The **legacy direct-invocation path** (no `parent_job_id`, i.e. `smooth-responder` invoked directly with `file_id`/`job_id`) still writes `intake_status` inline (`index.ts` `fail()`/success paths, `else` branches) — **two different write mechanisms for the same column coexist in the same file**, gated on whether `parentJobId` is set. This is documented as deliberate in code comments but is a real source of complexity for anyone debugging a stuck file: you must first determine which code path a given file went through before you know which mechanism controls its status.

**`document_processing_jobs.status`**: `pending → running → completed | failed`, with a retry path `running → pending` (requeue) on a catchable failure (up to 3 attempts, `retry_or_fail_document_job`), and a *stale-reclaim* path `running → pending` triggered externally when `locked_at` is >3 minutes old with no completion (`reclaim_stale_document_jobs`, migration 036).

**`document_processing_batches.status`**: `pending → running → completed | completed_with_failures | failed`, derived from child job statuses (`recompute_parent_batch_status`, migration 034/pipeline-logic.ts `deriveParentBatchStatus`, unit-tested).

**`job_intake_locks`**: not a status field but a mutex — existence = "a run holds this job." No status transitions; row is inserted then deleted. Its *absence* combined with other terminal fields is what several recovery-discovery queries key on (see §5.5 for why this is fragile).

**`quotes.status`**: `draft → pending_review → sent → approved | rejected` (forward-only, per `CLAUDE.md`, matches the DB CHECK-constraint pattern used elsewhere in this schema — **not independently re-derived from a migration file in this audit**, taken as accurate).

### 3.3 Failure points, retry logic, locks — consolidated table

| Stage | Failure mode | What catches it | Retry behavior | Terminal state on exhaustion |
|---|---|---|---|---|
| Storage download (document-worker) | network/storage error | `try/catch` in `processOneDocument` | `retry_or_fail_document_job`, up to 3 attempts, exponential-ish backoff (30s/2min) | `document_processing_jobs.status='failed'`; batch becomes `completed_with_failures` if siblings succeeded |
| PDF text extraction (document-worker) | Supabase CPU-governor kill (**external, uncatchable** — this is the single most-cited failure mode across the codebase's own comments) | Nothing *can* catch it in-process | `reclaim_stale_document_jobs` (external, 3-min staleness sweep) + **retry safeguard**: any retry (`attempts>=1`) skips text extraction entirely and goes vision-only, so a retry cannot reproduce the same parser crash | after 3rd attempt: `document_processing_jobs.status='failed'`, doesn't block siblings |
| `document-worker` → `document-worker` self-chain (`triggerNext`) | fire-and-forget fetch silently rejected (auth mismatch, malformed URL — **this exact bug was found and fixed once already**, see `index.ts:313-330` comment) | now logs `trigger_next_rejected` on non-2xx (previously silent) | none automatic beyond the external recovery cron's `find_batches_with_claimable_work` | batch stalls in `running` until recovery re-fires it, or forever if recovery is disabled (**current state**) |
| Stage 1/2 Claude call (smooth-responder) | any Anthropic failure | `classifyAnthropicError` + `withTimeoutAndRetry` (1 retry, only for `network_interruption`/`rate_limited`/`overloaded`) | per-batch: a failed batch doesn't abort the whole run, `continue`s to the next batch (unless billing-halt) | file(s) in that batch land in `failedToLoadSiblings`, surfaced to the builder |
| Stage 3 (Scope Reasoning) | same classification system; also **wall-clock budget exhaustion** | `bailForWallClockBudget` (as of migration 053, now persists `stall_stage`/`stall_reason`/`stall_count` to `document_processing_batches` instead of silently returning) | recovery cron's `find_stuck_batches_needing_classification_retry` retriggers the whole batch; **as of migration 053, a retry with `scope_reasoning_completed_at` already set skips Stage 3 entirely** | previously: infinite silent retry loop (§7); now: bounded by `MAX_RECOVERY_ATTEMPTS=3` per file, but **recovery is currently fully disabled**, so today a stall just sits there indefinitely with no automatic resolution at all |
| Stage 6 (Estimate Generation) | same + wall-clock | same | same as above | same |
| Billing failure (`credit_exhausted`/`authentication_failed`) | `isBillingHaltClassification` | `haltForBilling()` — marks file `failed` immediately, stops all further Anthropic calls in that run | none — deliberately not retried | `files.intake_status='failed'`, clear `failure_reason` |
| `job_intake_locks` never released | smooth-responder invocation killed uncleanly before its `finally` runs | `LOCK_NO_PROGRESS_STALE_MS` (6min)/`LOCK_STALE_MS` (16min) steal logic in `tryAcquireJobLock`, only triggered by a **new** upload to the same job; independently, recovery cron step 3b (`release_stale_job_intake_lock`) — **currently disabled** | a builder who doesn't retry gets no automatic recovery right now | job stays locked, no processing possible for that job, until a manual DB fix or a new upload triggers the steal path |

### 3.4 Edge cases explicitly handled in code (confirmed, not inferred)
- Incremental upload to a job that already has facts/scope/a quote: merges rather than restarts (`mergeFacts`, upsert-with-`onConflict` on `scope_items` and `quote_line_items`).
- Oversized single PDF: page-chunked (`pdf-chunk.ts`) rather than dropped.
- Text-dense vs. vision-necessary documents: routed differently to control token cost (`isTextDense`/`hasUsableText`).
- Duplicate document re-upload: caught by `mergeFacts`'s `duplicateNewFactIndexes`, skips redundant insert.
- Multi-generation fact supersession (v1→v2→v3): collapsed to one v2→v3 change; v1 is dropped from the *diff* output, not from storage (`superseded=true` row remains, documented limitation, not fixed by design).

### 3.5 Edge cases NOT handled / UNKNOWN
- What happens if a builder deletes a `jobs` row (via `DELETE` — **no such route was found in `app/api/jobs/`**, only `activate`; **UNKNOWN whether job deletion is possible at all** through any code path found in this audit) while a `document_processing_batches` run is in flight for it — orphaned rows, cascading FK behavior **not verified against migration 001's actual FK definitions in this pass**.
- Storage bucket size/type limits at the Supabase project level — **UNKNOWN**, not configured in any migration.
- Concurrent uploads to two *different* jobs by the same builder — no cross-job contention exists in the lock design (locks are per-`job_id`), confirmed correct by design, not a bug.

---

## 4. AI Architecture Audit

### 4.1 Models in use
Exactly one model, everywhere: `claude-sonnet-4-6` (hardcoded string literal, confirmed at `smooth-responder/index.ts:557`; `CLAUDE.md` states the same for edge functions and does not name a different model for the Next.js call sites — **the Next.js-side call sites' exact model string was not individually re-verified for all 10 in this pass**, flagged as a quick follow-up check, not a structural risk).

### 4.2 When API calls happen / what triggers them
| Trigger | Call site | User-initiated or automatic? |
|---|---|---|
| Builder sends a chat message | `chat/route.ts` `extractActions()` (intent classification) | User-initiated, rate-limited 60/min/builder |
| `project_question` intent | `chat/route.ts` `handleProjectQuestion()` | User-initiated |
| Demo-mode keyword-match fallback failing to route | `chat/route.ts` `routeDemoMessage()`'s Claude fallback | User-initiated |
| Document upload reaching Stage 1/2 | `smooth-responder` batch loop | User-initiated (upload), but can be **re-fired automatically by the recovery cron** with no new user action — this is the crux of §4.5 |
| Scope Reasoning (Stage 3) | `smooth-responder` | Same — user-initiated upload OR automatic recovery retrigger |
| Estimate Generation (Stage 6) | `smooth-responder` | Same |
| Document classification (`classify-document`) | manual document-type classification | User-initiated |
| Email draft generation | `email-draft/route.ts` | User-initiated |
| Email sync parse/simulate | `email-sync/parse`, `email-sync/simulate` | Automated (inbound email) / demo trigger |
| Scope-hints pattern fallback | `estimation/scope-hints/route.ts` | User-initiated, only after the seeded-pattern table misses |
| Rate PDF extraction | `rates/extract-pdf/route.ts` | User-initiated |
| Estimation history seeding fallback | `estimation/history/route.ts` | User-initiated |

### 4.3 Expected token usage
- Stage 1/2 (Document Intelligence): `max_tokens=16000` per batch, up to `MAX_BATCHES=3` batches per invocation, each up to 20MB of vision content or a solo forced-retry batch. Genuinely large — a single batch can include multiple full document images.
- Stage 3 (Scope Reasoning): `max_tokens=16000`, input scales with `factsForPrompt` — capped at `MAX_FACTS_IN_PROMPT=200` via `selectFactsBalancedBySource`. **This audit did not compute an exact token estimate for a 200-fact prompt** — `smooth-responder/index.ts`'s own `callTool` diagnostic logging (`approxInputTokens = Math.ceil((systemChars+userContentChars)/4)`, a rough chars/4 heuristic, confirmed at `index.ts:544`) is the only in-code estimator, and it is explicitly labeled "temporary diagnostic logging," not a durable metric. **Real production token counts are UNKNOWN without querying Anthropic's own usage dashboard or these logs directly.**
- Stage 6 (Estimate Generation): `max_tokens=16000`, same fact block plus scope block, no wall-clock-specific cap distinct from Stage 3's fact budget.
- Chat intent classification: small, single-message payload — comparatively cheap per call, but frequent (every chat message).

### 4.4 Potential runaway cost scenarios — this is the section the task specifically asked to investigate

**A. Wall-clock deadlock retry loop (the incident traced and partially fixed this session).**
Root cause, confirmed in code: `smooth-responder`'s `WALL_CLOCK_SAFETY_MS` (340,000ms) is checked before Stage 3 (needs 220,000ms) and again before Stage 6 (needs 150,000ms). `220,000 + 150,000 = 370,000 > 340,000`. On any project where Stage 3 genuinely takes ≳190 seconds (plausible for a large fact base — the incident that motivated this audit involved 189 facts across 13 trades), Stage 6 can **never** be reached in the same invocation, no matter how many times it's retried, because the arithmetic doesn't change between attempts. Before migration 053, `bailForWallClockBudget` only logged and returned — no terminal DB state was written, so the run "exited cleanly," which deleted `job_intake_locks`, which made the recovery cron's `find_stuck_batches_needing_classification_retry` treat the batch as "never reached smooth-responder" and retrigger it on essentially every cron tick (`document_processing_batches.updated_at` was stale from long before Stage 3 ever started, so the 3-minute grace period was already satisfied the instant the lock was deleted). **Confirmed live in production logs** (shown to this session by the user): `recovery_classification_retriggered` firing every ~60 seconds for the same 3 files, `recovery_attempts` climbing, each retrigger re-running the full Stage 3 Claude call. This is bounded — `MAX_RECOVERY_ATTEMPTS=3` per file (migration 040/051) eventually marks the file permanently `failed` — but "bounded at 3 full Stage-3 calls per affected upload, silently, with no visibility to the builder or a clear failure reason" is still real, avoidable spend that happened in production before being caught.

**B. The `find_and_fail_abandoned_files` revert loop (second incident, same day, currently unresolved).**
Independent of (A). Production logs showed `find_and_fail_abandoned_files` (migration 046, recovery step 3c) re-marking the *same two files* `intake_status='failed'` on **every single cron tick** (once a minute), each time reporting `previous_status: 'processing'` — meaning something resets `files.intake_status` back to a non-terminal value between ticks, and the function's own candidate query (`intake_status IN ('uploaded','queued','processing')`) matches it again next tick. **This does not call Anthropic** (confirmed via `ai_recovery_enabled: false` in the same production logs — `AI_RECOVERY_DISABLED` was already `true` when this was observed), so it is not a cost incident, but it is unbounded, non-converging load running every minute indefinitely, and — more importantly for this audit — **it means something in the derived-status recompute machinery (plausibly migration 052's `recompute_file_intake_status`, per the code's own comment at `route.ts:139`) can fight with a direct write from another code path, in a way nobody has yet root-caused.** This is exactly the kind of "impossible state" the task asked this audit to identify (§5.6). **Current mitigation: the entire recovery cron is disabled** (`DOCUMENT_RECOVERY_DISABLED = true`), which stops the symptom but also disables the everyday, harmless recovery this system exists for.

**C. Structural risk that remains even after both fixes above:** the recovery cron's design pattern — *read current DB state cold, decide what needs re-triggering, fire it* — has no concept of "this exact batch was already retried N times very recently and is still failing for the same reason." The per-file `MAX_RECOVERY_ATTEMPTS` cap (3) is the only backstop, and it is keyed per-*file*, not per-failure-*type* — a file that fails for a totally different reason on attempt 4 (after 3 attempts at an unrelated problem) is still capped, potentially masking a fixable, different issue as "permanently failed" after an unrelated earlier problem burned the retry budget. **This is a design tension, not a bug** — worth naming for whoever redesigns this system (§9).

**D. Multi-builder concurrent usage.** Per-builder chat rate limit is 60 requests/60s (`chat/route.ts:3160`), enforced via `checkRateLimit` — DB-backed atomic counter in real mode. **No cross-builder aggregate cap exists anywhere in the codebase** — if 50 builders each upload a large document set within the same minute, that's 50 concurrent `smooth-responder` invocations, each making up to 3 large Claude calls, with no global concurrency ceiling, no global spend ceiling, and no alerting on aggregate spend velocity (the "Alerting... not yet wired to a paging system" gap `CLAUDE.md` itself discloses under "Independent Intake Recovery Service"). This is a **real, currently-unmitigated scenario** for "could multiple builders accidentally create excessive API usage" — the honest answer is: **yes, nothing prevents it, and nothing would alert anyone until an Anthropic bill arrived.**

### 4.5 Can previous uploads interfere with new uploads? Answered directly.
**Yes, by design, in two ways — one intentional and safe, one a real risk surface:**
1. **Intentional:** `job_intake_locks` deliberately serializes all processing for one `job_id` — a second file uploaded to a job whose first file is still mid-pipeline waits (`queued` SSE state) rather than racing. This is correct and necessary (migration 030 exists specifically because an earlier version allowed two concurrent unlocked runs).
2. **Risk surface:** the incremental-upload fact-merge logic (`mergeFacts`, §3.4) means a later document's extraction can *supersede* an earlier document's fact if the model judges them to conflict — even when the earlier fact was correct and the later extraction is a spurious near-duplicate (documented as a known theoretical risk in `CLAUDE.md`'s migration 050 note: *"re-running Stage 1/2 on an unchanged document can spuriously supersede a perfectly good fact with a differently-worded (but not actually different) restatement, since mergeFacts treats any value mismatch as a real correction."* Migration 050's `extraction_status='complete'` gate exists specifically to stop an *unchanged* document from ever being reclassified, which closes the most obvious trigger for this — but it does not stop a **genuinely new, different document** from superseding a good fact via an imperfect model judgment call. This is inherent to the design (evidence-based reconciliation is explicitly preferred over a rigid append-only model), not a bug, but it is a real way "previous uploads interfere with new uploads" and should be understood as such.

### 4.6 Can completed estimates be retriggered? Answered directly.
**Not spontaneously** — the recovery cron's discovery queries (`find_stuck_batches_needing_classification_retry`, `find_stale_job_intake_locks`) all key on non-terminal state (`b.status IN ('completed','completed_with_failures','failed')` — note: batch-terminal, referring to the *document extraction* batch, not the quote — combined with `NOT EXISTS job_intake_locks`). Once a quote is actually built (`document_processing_batches.quote_id` set, `files.intake_status='extracted'`), nothing in the recovery system re-triggers it — confirmed by reading every recovery query in `route.ts` and the migration SQL. **However:** a *new* document uploaded to a job that already has a completed quote **does** re-run Stage 3+6 over the merged fact base by design (the incremental-upload path) — this is intentional re-estimation, not accidental retriggering, but it does mean "the estimate for job X" is not immutable once generated; every subsequent upload to that job can change it.

### 4.7 Duplicate processing — can it occur?
- **Document extraction:** no — `claim_next_document_job` uses `FOR UPDATE SKIP LOCKED`, a real DB-level mutual exclusion; two workers cannot claim the same `document_processing_jobs` row (unit-tested per `document-queue-reliability-check.mjs`, confirmed by its stated purpose).
- **Classification/Scope/Estimate stages:** guarded by `job_intake_locks`, a plain unique-constraint INSERT — same guarantee, weaker staleness recovery (fixed windows, not row-level locking across the whole run, since the "run" is a Deno isolate with no way to be queried for liveness — `CLAUDE.md`'s own honest admission: *"There is no separate 'is a worker still physically running' check anywhere in this system... that staleness window IS the proxy for it."*
- **Line items:** `quote_line_items` has a unique index on `(quote_id, trade_category_id, description)` (migration 030) and inserts use `upsert(..., { onConflict: ..., ignoreDuplicates: true })` — confirmed as a real backstop, not the primary defense (the primary defense is the job lock).
- **Net assessment:** the concurrency-safety primitives are genuinely sound (atomic claims, real unique constraints as backstops). The *risk* is not duplicate DB writes — it's duplicate/redundant **Claude calls** during a legitimate-looking retry, which is exactly incident (A) above.

---

## 5. Database / State Machine Review

### 5.1 Full table inventory (from `lib/types/database.types.ts` + migrations; types-file gaps noted per §2.3)

| Table | Purpose | Key status/lifecycle field | Migration introduced |
|---|---|---|---|
| `builders` | Builder account/profile | — | 001 |
| `clients` | Builder's customers | — | 001 |
| `jobs` | Core project entity | `status`: quoting→quoted→active→complete→archived | 001, +029, +035 |
| `quotes` | Estimate/quote document | `status`: draft→pending_review→sent→approved\|rejected | 001, +012, +014, +039 |
| `quote_line_items` | Per-trade line items | `assumption_status`, `is_assumption` | 001, +012 |
| `files` | Uploaded documents | `intake_status` (see §5.2), `intake_stage`, `intake_pct` | 001, +015, +016, +028, +030, +032, +040, +042, +052 |
| `assumptions` | Unresolved/resolved quantity gaps | `resolution_type` null=unresolved | 001 |
| `variations` | Scope changes post-quote | `status`: draft→pending→approved\|rejected | 001, +018 |
| `invoices` | Client invoices | `status`: draft→sent→overdue→paid | 001 |
| `invoice_schedule` | Milestone-based invoice plan | — | 005 |
| `job_milestones` | Activation milestones | — | 005 |
| `job_workers` | Job↔worker assignment | — | 007 |
| `job_tasks` | Task list per job | — | 024 |
| `workers` | Worker/staff records | `status`: invited→active | 001, +025 |
| `communication_history` | Email/comms log | — | 001 |
| `proof_events` | Hash-chained audit trail | — | 005 |
| `api_rate_limits` | Atomic per-key rate counter | — | 021 |
| `cost_rates` | 630 platform default rates | — | 017 |
| `builder_learned_rates` | Tier-1 auto-captured rates | — | 011, +023 |
| `builder_rate_preferences` | Tier-2 manual override | — | 011 |
| `builder_supplier_rates` | Tier-3 imported prices | — | 011 |
| `network_rate_aggregates` | Tier-5 anonymised P50 | — | 011, +020 |
| `trade_categories` | 13 immutable trades | — | 001 |
| `trade_subcategories` | 82 finer codes, seeded but unread | — | 011 |
| `project_memory` | Completed/active job history for similarity + parametric estimator | `status`: completed\|active | 011 |
| `cost_reconciliation` | Actual vs quoted per line | — | 011 |
| `builder_estimation_profiles` | Learned builder preferences | — | 011 |
| `scope_intelligence_patterns` | 5 seeded renovation gap patterns | — | 011 |
| `project_documents` | Document map (Stage 1) | `extraction_status`: pending→complete\|invalidated | 026, +050 |
| `project_facts` | Evidence-backed fact base (Stage 2) | `superseded` bool, never deleted | 026, +031 |
| `scope_items` | Per-trade scope (Stage 3) | — | 026 |
| `clarifying_questions` | Blocking/non-blocking gaps (Stage 4/5) | `status`: open→answered | 026 |
| `job_intake_locks` | Mutex — one active run per job | existence = locked | 030, +033, +037(`release_stale_job_intake_lock`) |
| `document_processing_batches` | One row per upload attempt | `status`: pending→running→completed\|completed_with_failures\|failed | 034, +050(`quote_id`), +053(`scope_reasoning_completed_at`, `stall_*`) |
| `document_processing_jobs` | One row per document | `status`: pending→running→completed\|failed | 034, +037(`locked_by`) |
| `intake_recovery_runs` | Audit log per cron execution | — | 037, +040, +046 |
| `worker_sessions` | Worker portal session token | — | 025 |

**NOT in `database.types.ts`** (confirmed by direct grep, §2.3): `job_intake_locks`, `document_processing_batches`, `document_processing_jobs`, `intake_recovery_runs`, `worker_sessions`.

### 5.2 `files.intake_status` — deep dive (explicitly requested)

```
                    ┌─────────────┐
                    │  uploaded   │  ← set by POST /api/upload
                    └──────┬──────┘
                           │ GET /api/intake/[fileId] triggers pipeline
                           ▼
                    ┌─────────────┐
                    │ processing  │  ← set by smooth-responder at pipeline start
                    │             │    (LEGACY direct-invocation path only;
                    │             │     queue-model path never writes this
                    │             │     literal value — see below)
                    └──────┬──────┘
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
        ┌───────────┐ ┌──────────┐   ┌─────────────┐
        │ extracted │ │ needs_   │   │   failed    │
        │           │ │  info    │   │             │
        └───────────┘ └────┬─────┘   └─────────────┘
                            │ builder answers via /clarify
                            └──────────► back to Stage 3 (resume:true)
```

**Two independent write mechanisms for the same column, confirmed in code:**
1. **Legacy / no-`parentJobId`:** `smooth-responder`'s `fail()` and success paths write `files.intake_status` directly with a literal string.
2. **Queue-model / `parentJobId` set (the normal path today):** `intake_status` is *derived*, via `recompute_file_intake_status(file_id)` (migration 052), from `document_processing_jobs.status` + `document_processing_batches` state + open blocking `clarifying_questions`. It is invoked at every real transition point across three different files (`document-worker/index.ts`, `smooth-responder/index.ts`, `app/api/cron/intake-recovery/route.ts`) rather than being a single-writer column.

**This is exactly the kind of state-machine problem the task asked to identify.** A column with two independent write paths, one of them a multi-call-site *derived* recomputation rather than a single authoritative writer, is inherently harder to reason about than a plain state machine — and it is **directly implicated in the currently-unresolved second incident** (§4.4-B), where something is resetting this derived value back to `'processing'` in a way nobody has yet traced. The architecture is a deliberate, well-reasoned response to a real prior bug (sibling files never getting a real status — migration 052's own stated purpose), but it traded "single writer, simple to reason about" for "correct per-file status in a multi-document batch," and the current live incident is arguably the cost of that trade surfacing.

### 5.3 Processing batches — lifecycle diagram

```
document_processing_batches.status:
  pending ──► running ──┬──► completed              (all children completed)
                         ├──► completed_with_failures (mixed, ≥1 completed)
                         └──► failed                 (all children failed)

document_processing_jobs.status (per document, child of a batch):
  pending ──► running ──┬──► completed
                         ├──► pending (requeue, catchable failure, attempts<3)
                         ├──► pending (stale reclaim, locked_at>3min, external)
                         └──► failed (attempts>=3)
```
`recompute_parent_batch_status` (pure function, unit-tested as `deriveParentBatchStatus`) derives the parent from children atomically on every child transition — this one is a clean, single-writer derivation and was not implicated in either incident.

### 5.4 Estimation records
`quotes` is the terminal artifact; `quote_line_items` children carry `is_assumption`/`assumption_status` (`unresolved`|`excluded`|null) written once by `applyValidationGates()` at extraction time and never re-derived (a deliberate, sound design — `CLAUDE.md`'s own framing: *"the gate is computed once... and persisted... never re-derived,"* confirmed by reading `lib/estimating/gates.ts` directly, no logic drift found between the canonical spec and its Deno mirror was checked in this pass — **flagged as UNKNOWN, worth a byte-diff check** since the two copies (`lib/estimating/gates.ts` and a Deno copy inside `smooth-responder`, per `CLAUDE.md`) are maintained by hand in two places).

### 5.5 Recovery tables
`job_intake_locks` (mutex, not a status field), `document_processing_batches`/`_jobs` (above), `intake_recovery_runs` (append-only audit log, no lifecycle — pure history). **Fragility identified:** several recovery-discovery queries key on the *absence* of a row (`NOT EXISTS job_intake_locks`) combined with a staleness *timestamp comparison* on an unrelated table (`document_processing_batches.updated_at`, which is not touched during Stage 3-6 at all). This is precisely the mechanism that produced incident (A) in §4.4 — a timestamp that looks stale for reasons unrelated to the actual thing being measured (Stage 3/6 progress) is not a reliable staleness signal. Migration 053 patches this for the wall-clock case specifically (by finally writing *something* on a stall) but the general pattern — "staleness of an unrelated column as a proxy for liveness of a process with no other way to query its liveness" — remains the load-bearing assumption underneath the entire recovery system, not something migration 053 structurally fixes.

### 5.6 AI failure records
`files.ai_failure_classification` / `ai_failure_count` (migration 042), incremented atomically via `record_ai_failure` RPC (migration 043) with a per-classification consecutive-occurrence cap (`maxConsecutiveOccurrences`). **Confirmed gap, stated explicitly in `CLAUDE.md` and verified by reading the code path directly:** a wall-clock bail (`bailForWallClockBudget`) is deliberately **not** routed through this system — it's treated as a scheduling condition, not a content/model failure. This is a reasonable design distinction, but it means **there are now two separate, non-unified failure-tracking systems** (`ai_failure_count` for genuine Anthropic errors, `document_processing_batches.stall_count` as of migration 053 for wall-clock bails) with no single place that answers "how many times has this specific piece of work failed, for any reason." An operator diagnosing a stuck job must know to check both.

### 5.7 Identified state-machine problems — direct answer to the task's explicit ask

- **Impossible/contradictory states:** the live, unresolved `find_and_fail_abandoned_files` revert loop (§4.4-B) is, by definition, evidence of an impossible-in-theory state actually occurring: a file repeatedly observed at `intake_status='processing'` with no `job_intake_locks` row and no active worker — a state the system's own invariants say shouldn't be reachable (a lock should exist for any genuinely-processing file), yet is being observed and re-corrected every minute in production. **This is the single highest-priority open item this audit surfaces** — not fixed, not fully root-caused, currently worked around by disabling recovery entirely.
- **Missing transitions:** `files.intake_status` has no explicit `stalled`/`recovering` state — a wall-clock bail (prior to migration 053) was indistinguishable, at the `files` row level, from a run that simply hadn't reached its next stage yet. Migration 053 adds this information to `document_processing_batches`, not to `files.intake_status` itself, so the *file's own* status still can't directly express "stalled, awaiting recovery."
- **Duplicate processing paths:** confirmed and enumerated: (1) legacy-direct vs. queue-model write paths for `files.intake_status` (§5.2); (2) two independent recovery-attempt counters (`ai_failure_count` vs. the new `stall_count`, §5.6); (3) `document-worker` and `smooth-responder` are triggered via two different call shapes (`{file_id,job_id,builder_id,resume}` vs `{parent_job_id}`) depending on caller, each exercising a genuinely different code branch inside `runPipeline` (confirmed at `index.ts:881` `if (!resume)` and the `parentJobId` branch within it).
- **Stale records blocking new work:** `job_intake_locks` is the textbook example — by design, a stale lock blocks *all* future processing for a job until either a new upload's steal-logic fires or the (currently disabled) recovery cron's step 3b runs. **Right now, with both kill switches on, a stale lock has no automatic remedy at all except a new upload attempt from the builder**, which itself only works if the lock is stale enough (6/16-minute windows) by the time that upload happens.

---

## 6. Code Inventory

Given the size of this codebase (49 API routes, 34 components, 30 lib files, 3 edge functions, 53 migrations), this section lists every file the audit read or verified directly, with purpose, key functions, and a risk rating. Files not read in full are marked accordingly rather than guessed at.

### 6.1 Core intake/estimating pipeline (read in full this session)

| File | Purpose | Key functions | Dependencies | Rating |
|---|---|---|---|---|
| `app/api/upload/route.ts` | Create file record + signed Storage upload URL | `detectFileType`, `sanitizeFilename`, `uniqueStoragePath`, `POST` | Supabase Storage, `files` table | **Safe** — small, single-purpose, ownership-checked |
| `app/api/intake/[fileId]/route.ts` | SSE trigger + poll for the estimating engine | `tryAcquireJobLock`, `releaseJobLock`, `createDocumentProcessingBatch`, `fetchBatchJobStatuses`, `GET` | `job_intake_locks`, `document_processing_*`, `smooth-responder`, `document-worker`, `lib/pricing`, `lib/estimating/qa`, `lib/project-context` | **Risky (complex, not unsafe)** — 898 lines, hand-rolled REST calls (not the Supabase JS client) throughout for lock/batch operations, significant implicit state carried across SSE reconnects via query-string params (`started_at`, `last_progress_at`). Correct as far as this audit could trace, but a genuinely hard file to safely modify without deep context. |
| `app/api/intake/[fileId]/clarify/route.ts` | Resume path after a blocking clarifying question | `acquireLockOrWait`, `POST` | `job_intake_locks`, `project_facts`, `clarifying_questions`, `smooth-responder` | **Safe** — small, clear, bounded wait |
| `supabase/functions/smooth-responder/index.ts` | The reasoning engine — Stages 1/2/3/4/6, quote building | `runPipeline`, `callTool`, `fail`, `haltForBilling`, `recordAiFailure`, `bailForWallClockBudget`, `hasWallClockBudget` | Anthropic SDK, `pipeline-logic.ts`, `pdf-text.ts`, `pdf-chunk.ts`, ~15 tables | **Risky** — 1900+ lines, the single most load-bearing and most-incident-prone file in the codebase (see §7). Recently modified (migration 053 work) but **not yet verified end-to-end against a real production upload** — this audit found the fix well-reasoned and internally consistent but confirms `CLAUDE.md`'s own stated verification status: unverified live. |
| `supabase/functions/document-worker/index.ts` | Per-document extraction, one Edge Function invocation per document | `processOneDocument`, `triggerNext`, `triggerClassification`, `Deno.serve` handler | Anthropic-free (text extraction only), Storage, `document_processing_jobs` RPCs | **Risky (fragile self-chaining)** — the self-chain mechanism (`EdgeRuntime.waitUntil` + fire-and-forget HTTP self-POST) has already had one confirmed, fixed bug (malformed self-URL, §3.3) and is structurally the kind of pattern (a distributed computation held together by successful HTTP calls between ephemeral, unqueryable isolates) that is unusually easy to break silently. |
| `supabase/functions/smooth-responder/pipeline-logic.ts` | Pure, dependency-free logic: batch splitting, fact merging, timeout classification, wall-clock stall formatting | `splitIntoBatches`, `mergeFacts`, `selectFactsForPrompt`, `selectFactsBalancedBySource`, `classifyAnthropicError`, `withTimeoutAndRetry`, `shouldGiveUp`, `documentPhaseProgress`, `formatWallClockStallReason` | none (by design) | **Safe** — the one genuinely well-tested file in the whole pipeline (126 unit tests), shared identically between Deno and Next.js via a relative `.ts` import specifically to guarantee this. This is a real architectural strength worth preserving in any rebuild. |
| `app/api/cron/intake-recovery/route.ts` | Independent recovery cron | `GET`, 5 numbered recovery steps | ~8 RPCs, `document-worker`, `smooth-responder` | **Currently disabled, high-complexity when enabled** — 601 lines, two kill switches both currently `true`. The single file most in need of a redesign per this audit's own findings (§9). |
| `lib/estimating/gates.ts` | Canonical validation-gate spec | `applyValidationGates`, `inferLegacyGate` | none | **Safe** — small, pure, matches its own documentation exactly |
| `lib/pricing.ts` | 5-tier rate resolution, quote totals | `priceLineItems`, `ensureQuotePriced`, `recomputeQuoteTotals`, `captureLearnedRates`, `applyMargin`, `normalizeUnit` | `cost_rates` + 4 other rate tables | **Not fully read this session** — skimmed exports only; core financial-correctness logic, should be prioritized for a close read in any follow-up audit given it directly determines client-facing prices |
| `lib/proof.ts` | Hash-chained audit trail | `recordProofEvent`, `verifyProofChain`, `getJobProofEvents` | `proof_events` table (real mode), in-memory (demo) | **Not fully read this session** — exports skimmed only |
| `lib/project-context.ts` | Fact retrieval/ranking for chat Q&A and knowledge caching | `buildProjectContext`, `assembleProjectContext`, `persistContext`, `persistProjectUnderstanding`, `buildActiveFactsQuerySpecs` | `pipeline-logic.ts` (shared `selectFactsForPrompt`), `project_facts` | **Not fully read this session** — has its own dedicated test file (`project-context.test.ts`), a positive signal |
| `lib/auth/api-auth.ts` | Builder identity resolution | `getAuthenticatedBuilderId`, `isDemoMode` | Supabase auth-helpers | **Safe** — read in full, small, matches documentation exactly, the internal service-role trust mechanism is a deliberate and reasonable (if high-blast-radius-if-leaked) design |
| `lib/rate-limit.ts` | Per-key rate limiting | `checkRateLimit`, `rateLimitedResponse` | `api_rate_limits` table (real), in-memory (demo) | **Safe** — read in full |

### 6.2 Other API routes (existence + purpose confirmed via directory listing and route naming; contents not individually read this session — flagged as UNKNOWN in detail, safe/risky rating withheld)

`app/api/jobs/*`, `app/api/quotes/*`, `app/api/variations/*`, `app/api/workers/*`, `app/api/assumptions/*`, `app/api/email-draft/*`, `app/api/email-sync/*`, `app/api/estimation/*` (except `pricing.ts`/`gates.ts` above), `app/api/rates/*`, `app/api/join/[token]/*`, `app/api/classify-document/*`, `app/api/dashboard/*`, `app/api/cron/morning-brief/*`, `app/api/cron/network-rates/*` — **38 route files not individually read in this pass.** `chat/route.ts` (3403 lines) was surveyed at the structural level (rate limit, intent switch, 3 Anthropic call sites confirmed) but not read line-by-line; its individual `handle*` functions were not each independently verified. **This is the single largest gap in this audit's coverage** and should be the first target of any follow-up pass, given `chat/route.ts`'s size and centrality.

### 6.3 Frontend components (existence confirmed via directory listing; contents not read this session)

All 34 `.tsx` files under `components/` were enumerated but not opened. Two specific, material findings from cross-referencing imports (not full reads):
- `components/dashboard/AIInsightCard.tsx`, `JobCard.tsx`, `Timeline.tsx` — **actively imported and used** (`JobSnapshotPanel.tsx`, `ChatInterface.tsx`), contradicting `CLAUDE.md`'s claim that `components/dashboard/` "no longer exists." The directory exists with three different, live files — the four *specific* files `CLAUDE.md` names as deleted (`UniversalDropZone.tsx`, `AIRecommendationsSection.tsx`, `NeedsAttentionSection.tsx`, `RecentActivityFeed.tsx`) are indeed absent, but the documentation's framing ("no longer exists") is misleading about the directory as a whole.
- `components/job/tabs/TasksTab.tsx` — **exists on disk but has zero imports anywhere in the codebase** (confirmed by grep — only self-references found). `CLAUDE.md` states `components/job/tabs/` "contains only `ProofTab.tsx` now," which is also inaccurate: `TasksTab.tsx` is present and appears to be genuine dead code (or a half-finished feature) not mentioned anywhere in the documentation.

### 6.4 Discrepancies between `CLAUDE.md` and the actual repository — consolidated

This matters directly for the task's instruction to "not make assumptions" — `CLAUDE.md` is detailed and largely trustworthy for the migration history and the intake pipeline (everything independently verified matched), but it is **stale or inaccurate in at least these specific, confirmed ways:**
1. `components/dashboard/` claimed non-existent; actually exists with 3 live, imported files (§6.3).
2. `components/job/tabs/` claimed to contain only `ProofTab.tsx`; actually also contains an unreferenced `TasksTab.tsx` (§6.3).
3. `lib/estimation-engine.ts` (the parametric "estimate from history" engine powering `/estimate`) is **not mentioned anywhere in `CLAUDE.md`**, despite backing a fully separate, shipped user-facing feature (§1.5).
4. `lib/job-activity.ts`, `lib/job-attention.ts`, `lib/estimating/readiness.ts` are not mentioned in `CLAUDE.md`'s component/lib tables, despite being real, in-use, well-commented modules.
5. `lib/types/database.types.ts` is described as "keep in sync with migrations manually" with no caveat; in practice it is significantly out of sync (§2.3) and — separately — effectively unused for type safety on most of the codebase's actual Supabase calls, a fact `CLAUDE.md` does not disclose.
6. **Not a discrepancy but worth flagging:** `CLAUDE.md` itself documents, in detail and with dates, at least four distinct production incidents in its own recent history (the wall-clock deadlock, the abandoned-files revert loop, an earlier billing-credit-exhaustion spend incident, and a `getworka.com`/Vercel hosting misunderstanding that "cost real debugging time"). The document is unusually honest about its own past inaccuracy — which is a point in its favor as a source, but also means it should be treated as a *living incident log*, not a stable spec, when auditing current system health.

---

## 7. Current Known Problems — Debugging History

### 7.1 What we thought was wrong (chronological, from `CLAUDE.md`'s own incident log + this session)
1. **Early:** "PDF extraction is broken" — the user's own framing at the start of this audit explicitly ruled this out (*"PDF extraction is confirmed working... 189 facts across 13 trades"*), and this audit found no evidence contradicting that; extraction and classification (Stages 1/2) appear structurally sound.
2. **Sibling-file status corruption** — files other than the batch's primary/anchor never got a real `intake_status`. **Proven and fixed** (migration 052, `recompute_file_intake_status`).
3. **Retry caps / runaway recovery not enforcing** — a JS-side SELECT-then-UPDATE race let the same file retry unboundedly. **Proven and fixed** (migrations 043, 051 — atomic RPCs replacing non-atomic JS read-modify-write).
4. **Anthropic billing failure not halting the pipeline** — a credit-exhaustion error was logged but didn't stop further calls in the same run. **Proven and fixed** (`haltForBilling`, migration 042).
5. **Wall-clock budget deadlock** (this session's primary finding) — **proven**, root-caused to specific line numbers, partially fixed (migration 053: Stage 3 checkpoint + stall observability). **Not yet re-enabled in production** (`AI_RECOVERY_DISABLED=true`) and **not yet verified end-to-end against a real upload**, by this audit's own explicit assessment in `CLAUDE.md`.
6. **`find_and_fail_abandoned_files` revert loop** (found the same day, second incident) — **confirmed occurring in production logs, root cause NOT proven.** The leading hypothesis (an interaction with migration 052's derived-status recompute) is explicitly labeled unconfirmed in the code's own comments. **This is the single highest-priority unresolved item.**

### 7.2 What is still unresolved (direct list)
- The abandoned-files revert loop's root cause (§7.1.6).
- Whether migration 053's Stage-3-checkpoint fix actually converges retries in a real multi-document production upload — **explicitly unverified**, per this session's own commit message and `CLAUDE.md`'s new "Verification status" note.
- Whether `pg_cron`'s one-time Vault secret setup (migration 038) was ever actually completed in production — **UNKNOWN**, no live DB access.
- Whether Railway is genuinely still the production host, or whether that fact (documented as previously wrong once already) has drifted again — **UNKNOWN**, not re-verified live in this audit.
- Whether all 49 API routes correctly enforce `builder_id` ownership on every query — **not exhaustively checked** in this audit.
- `lib/pricing.ts` internal correctness (the actual client-facing dollar figures) — **not read in depth** in this audit.

### 7.3 Highest-probability root causes (this audit's own assessment, for anything still open)
- **Abandoned-files revert loop:** most likely candidate, based on the code actually read, is a genuine interaction between `recompute_file_intake_status` (which derives `intake_status` from `document_processing_jobs`/`document_processing_batches`/`clarifying_questions`) and `find_and_fail_abandoned_files`' direct write — if some other trigger (a stale/duplicate `document_processing_jobs` row still sitting at `pending`, or a `document-worker` self-chain that fires *after* the file was marked failed and doesn't check for that) causes a recompute to run again after the abandoned-file mark, it would flip the status back to `processing` and reproduce exactly the observed symptom. **This is a hypothesis consistent with the evidence, not a confirmed finding** — it requires live DB access to `document_processing_jobs` rows for the two affected `file_id`s to confirm or refute.

---

## 8. Risk Assessment

### 8.1 Technical health score: **C- (functional but fragile)**

The core reasoning/extraction pipeline demonstrably works (189 facts, 13 trades, confirmed by the user before this audit began) and the concurrency-safety primitives underneath it (`FOR UPDATE SKIP LOCKED`, atomic RPCs, unique constraints) are genuinely sound engineering. But the system has needed **at least six emergency production interventions** in its recent history (per `CLAUDE.md`'s own incident log plus this session's two), several of them spend-related, and **the automatic recovery system that exists specifically to make this pipeline self-healing is, as of this audit, entirely disabled** — meaning the system currently has no fallback if a job gets stuck other than a builder manually retrying. That combination — real, recent, repeated financial-risk incidents, and the primary safety net currently switched off — is not a healthy state, even though no data has been lost and the concurrency model itself hasn't failed.

### 8.2 Critical issues (act on first)
1. **Recovery system fully disabled in production** (§4.4). No automatic remedy exists today for a stuck upload beyond a fresh upload attempt.
2. **The abandoned-files revert loop is unresolved** and is the stated reason recovery can't safely be re-enabled.
3. **No cross-builder spend ceiling or alerting** (§4.4-D) — the system has already had at least one confirmed uncontrolled-spend incident (referenced in migration 040's own history) and the structural gap that allows a repeat (no aggregate rate limit, no spend alerting) has not been closed, only the specific mechanism of the last incident.

### 8.3 High-risk areas
- `job_intake_locks`/recovery staleness logic — proxy-based liveness detection with no way to directly query whether a Deno isolate is still running (§5.5), the root architectural cause behind most of the incident history.
- `files.intake_status` dual-write-path design (§5.2) — directly implicated in the open incident.
- `lib/types/database.types.ts` staleness (§2.3) — currently latent (no type errors because nothing uses the typed client for these tables), but a real landmine for anyone who *does* start using the typed client without first fixing the file.
- Untested breadth: 38 of 49 API routes and all 34 components were not read in this audit; `chat/route.ts` (3403 lines, 3 Anthropic call sites, ~30 intent handlers) received only structural review.
- `lib/pricing.ts` — the component with the most direct financial-correctness stakes (what a client is actually charged) received the least scrutiny in this audit.

### 8.4 Technical debt
- Two independent failure-tracking systems (`ai_failure_count` vs. `stall_count`) with no unified view.
- Two independent write mechanisms for `files.intake_status`, gated on an implicit flag (`parentJobId` presence) rather than a single consistent design.
- Hand-maintained duplicate logic (`lib/estimating/gates.ts` and its Deno mirror inside `smooth-responder`) — not verified byte-identical in this audit, a real drift risk over time.
- Zero component/integration test coverage — only pure-function logic is tested.
- `CLAUDE.md` itself, while unusually detailed, has confirmed stale sections (§6.4) — documentation drift is itself a debt item given how load-bearing this file evidently is for engineers (and AI agents) working on this codebase.

### 8.5 Things that could cause financial loss
- Uncontrolled/repeated Anthropic spend from retry loops (has already happened at least twice, per the incident history).
- No aggregate multi-builder spend ceiling (§4.4-D).
- Any latent `lib/pricing.ts` bug affecting `applyMargin`/`recomputeQuoteTotals` would directly misquote clients — **not ruled out, not confirmed, simply not deeply audited this pass.**

### 8.6 Things that could break customer trust
- A builder's upload silently stalling with the recovery system off and no proactive notification to the builder that anything is wrong (the SSE client will eventually show a timeout error at worst, but a builder who isn't watching the screen gets nothing).
- Any quote sent to a client with an under-priced or missing line item that `deriveQuoteReadiness()`'s `blocked` state was supposed to catch — this audit did not attempt to break that gate, but did not independently verify it either.
- The proof/audit-trail system (`lib/proof.ts`) failing silently on a genuinely consequential action — by design (`recordProofEvent` never throws), which is the right call for not blocking the underlying action, but means a gap in the audit trail is possible and would only be discovered if someone actually needed the trail and found it incomplete.

---

## 9. Recommended Reset Plan

Per the task's explicit instruction, this is a plan, not a patch — no code changes accompany this document.

### 9.1 What should be frozen (do not touch until root-caused)
- **The recovery cron kill switches** — leave `DOCUMENT_RECOVERY_DISABLED`/`AI_RECOVERY_DISABLED` at `true` until the abandoned-files revert loop is root-caused with live DB access. Re-enabling either without that risks reproducing an active, currently-unresolved incident.
- **`smooth-responder`'s wall-clock timeout constants** (`220_000`, `150_000`, `340_000`) — migration 053 changed the *control flow* around these numbers, not the numbers themselves, deliberately (per the task's own earlier instruction this session: no timeout changes). Any further change to these specific values should happen only with real production timing data on how long Stage 3 actually takes on large projects, which this audit does not have.
- **The migration numbering sequence** — 53 migrations with no gaps or prefix collisions is a genuinely fragile-but-currently-correct state (per the documented `008_`-prefix incident); any new migration must get the next free integer, never reuse one.

### 9.2 What should be deleted or refactored
- `components/job/tabs/TasksTab.tsx` — confirmed dead code (§6.3). Either wire it up or delete it; leaving unreferenced, undocumented files increases the surface area anyone auditing this codebase has to account for.
- `lib/types/database.types.ts` — either commit to actually using it (migrate every server route to `createClient<Database>`, which would require first bringing the file up to date with all missing tables and would likely surface real latent bugs) or stop pretending it's a source of truth and document plainly that it isn't. The current in-between state is worse than either extreme.
- The dual write-path for `files.intake_status` (§5.2) — this should converge to exactly one mechanism. Given the derived-recompute approach is more correct for the multi-document-batch case (the whole reason migration 052 exists), the likely right direction is retiring the legacy direct-invocation path's inline writes entirely, not the reverse — but this requires confirming the legacy path (`parentJobId` absent) is actually still reachable/used in production before removing it. **UNKNOWN whether the legacy path is dead code or still load-bearing** — check call sites before touching.
- The two independent failure-tracking columns (`ai_failure_classification`/`ai_failure_count` vs. `stall_stage`/`stall_reason`/`stall_count`) should be unified into one "why did this fail, how many times" view before any further recovery-logic work is built on top of either.

### 9.3 What should be rebuilt cleanly
- **The recovery cron's discovery mechanism.** The core design flaw underlying essentially every incident traced in this audit is the same: *staleness of an unrelated timestamp as a proxy for liveness of a process that cannot otherwise be queried.* A clean rebuild should give the pipeline an explicit, single, authoritative "what stage is this run at, and when did it last make real progress" signal — written by exactly one code path, read by every discovery query — rather than the current pattern of several different tables' timestamps each serving as an implicit proxy for a different thing. Migration 053's `stall_stage`/`stall_reason`/`stall_count` on `document_processing_batches` is a step in this direction but is additive to, not a replacement of, the existing patchwork.
- **`app/api/cron/intake-recovery/route.ts` itself** — 601 lines, five sequential steps, two kill switches, hand-rolled REST calls in places, RPC calls in others. This is the single file most in need of a ground-up redesign rather than incremental patching, given it's already been emergency-modified at least three times in its recent history per the commit log this session surfaced.

### 9.4 Minimum architecture needed for a stable production version
1. **One authoritative liveness/progress signal per in-flight run**, queryable without inferring from unrelated timestamps.
2. **One write path per status column** — no column should be writable from two independently-reasoned-about code branches.
3. **A real root cause for the abandoned-files loop**, confirmed against live data, before recovery is re-enabled.
4. **An aggregate spend ceiling and alert**, independent of the per-builder rate limit, given the demonstrated history of spend incidents.
5. **A completed, honest pass over the 38 unread API routes** for the ownership/auth-filter check this audit could not complete, given that a missing `builder_id` filter is a direct data-isolation failure (Non-Negotiable Safety Rule #5) and this audit found no reason to assume it's been done elsewhere.
6. **`lib/pricing.ts` under the same scrutiny this audit gave the intake pipeline** — it is the one component that, if wrong, misquotes real clients real money, and it received the least attention here.
7. **`CLAUDE.md` (or its replacement) treated as an incident log that requires active reconciliation with the repository, not a static spec** — the discrepancies found in §6.4, while individually minor, indicate the document is already drifting from the code it describes, and this codebase's evident complexity means that drift compounds quickly.

---

*End of audit. No code was modified in the production of this document.*
