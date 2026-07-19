# WORKA_MIGRATION_PLAN.md

**Purpose:** map every current status field, cron, retry mechanism, recovery path, and database field in the live intake/estimating pipeline onto the `estimate_runs` design proposed in `WORKA_TARGET_ARCHITECTURE.md`, and produce a phased, rollback-capable path to get there. No code is changed by this document.

**Governing constraint for every decision below:** *do not optimize for simplicity at the expense of estimate accuracy.* Where §5 of `WORKA_TARGET_ARCHITECTURE.md` made a simplification call, this document re-examines it specifically against that constraint — and reverses one of them (§6). The primary objective, restated as the actual test applied throughout: **would this change make an incorrect or incomplete builder estimate more likely, or make uncontrolled API spend more likely — and if either answer is "maybe," don't do it yet.**

---

## 1. Full Inventory Mapping

Every current mechanism, mapped to its target-architecture equivalent, with a migration verdict. "Verdict" here means the *eventual* disposition — not the timing (timing is §7).

### 1.1 Status fields

| Current field | Current values | Target equivalent | Verdict |
|---|---|---|---|
| `files.intake_status` | `uploaded, processing, extracted, needs_info, failed` | `estimate_runs.status` (run-level, not file-level) for everything except `uploaded`, which stays on `files` since it describes the *file*, not a run | **MIGRATE** — meaning changes: `files` keeps only `uploaded` as a real fact about the file; every downstream value moves to the run |
| `files.intake_stage` / `intake_pct` | free-text stage name + percent | `estimate_runs.status` (the 9-state enum) for the coarse stage; fine-grained "which document, which batch" detail moves to `run_documents` | **REPLACE** — the target design has no percent-complete concept at all; recommend keeping a *simple derived* percent in the SSE presentation layer only (a lookup table from `status` → approximate %), never persisted, since persisting it was never the source of truth anyway |
| `files.failure_stage` / `failure_reason` | free text | `estimate_runs.failure_category` (enum) + `failure_reason` (text) | **MIGRATE**, tightened to an enum for `failure_category` so failures are queryable/aggregable, not just readable |
| `files.ai_failure_classification` / `ai_failure_count` | per-file, persists across runs | folds into `estimate_runs.retry_count` + the specific `claude_call_failed` events in `run_events` (per-run, not persisted separately per file) | **REPLACE** — see §6.2 for why this is not a pure win and needs a companion decision |
| `files.intake_recovery_attempts` | int, cron-incremented | no longer needed — the orchestrator's reclaim rule is generic and doesn't accumulate a separate "recovery attempt" count distinct from `estimate_runs.retry_count` | **DELETE** (folded into `retry_count`) |
| `files.skipped_sibling_filenames` / `failed_sibling_filenames` | text[] on the primary file only | `run_documents` rows with `status='failed'`, queryable per-document, not string arrays on one anchor file | **REPLACE** — strictly better: today's version is unqueryable prose; the target is real rows |
| `files.intake_batch_index` / `intake_batch_count` | per-file batch progress | `run_events` `stage_transition`/`claude_call_started` events already carry this; no persisted column needed | **DELETE** |
| `document_processing_batches.status` | `pending, running, completed, completed_with_failures, failed` | `estimate_runs.status` (the batch *is* the run in the target design) | **REPLACE** |
| `document_processing_batches.scope_reasoning_completed_at` (migration 053) | timestamp checkpoint | no longer needed — in the target design, Scope is its own state (`scoping`) with its own durable output (`scope_items` rows already exist the moment the state advances); there is no "was Scope already done" ambiguity to checkpoint separately, because the run's `status` itself *is* that checkpoint | **DELETE** |
| `document_processing_batches.stall_stage` / `stall_reason` / `stalled_at` / `stall_count` (migration 053) | wall-clock stall bookkeeping | folds into `run_events` (`reclaim` event type) — a reclaim is just another logged event, not a separate bookkeeping column | **REPLACE** |
| `document_processing_jobs.status` | `pending, running, completed, failed` | `run_documents.status` (same four values, same meaning) | **MIGRATE** — this one is nearly 1:1, lowest-risk migration in the whole plan |
| `document_processing_jobs.attempts` / `locked_by` / `locked_at` | retry + claim bookkeeping | `run_documents.attempts` / `claimed_by` / `claimed_at` | **MIGRATE** — 1:1 |
| `quotes.status` | `draft, pending_review, sent, approved, rejected` | **unchanged**, this is a business/approval state machine, not a pipeline-execution one — out of scope for this migration entirely | **KEEP, NOT IN SCOPE** |

### 1.2 Cron / trigger mechanisms

| Current mechanism | Purpose | Target equivalent | Verdict |
|---|---|---|---|
| `.github/workflows/intake-recovery-cron.yml` (every 5 min) | secondary trigger for the recovery route | replaced by the single `advance_runs()` tick — but see §7 for why the *pattern* of "two independent trigger paths" (GitHub Actions + pg_cron) should be **kept**, just pointed at the new tick function, not deleted | **REPLACE target, KEEP pattern** |
| `supabase/migrations/038_intake_recovery_pg_cron.sql` (pg_cron, every minute) | primary trigger for the recovery route | replaced by pg_cron calling `advance_runs()` on the same or tighter interval | **REPLACE** |
| `app/api/cron/intake-recovery/route.ts` (601 lines, 5 steps, 2 kill switches) | the recovery logic itself | replaced entirely by the orchestrator's reclaim step (§3 of the target doc) | **DELETE** (after migration — this is the single largest deletion, see §2) |
| `intake_recovery_runs` table | per-cron-run audit log | `run_events` already provides this at finer granularity (per-run, not per-cron-tick); a lightweight `orchestrator_ticks` table (tick timestamp, runs claimed, runs reclaimed, duration) is still worth keeping as a *system-health* view distinct from any one run's own log | **REPLACE**, narrower scope |
| `.github/workflows/supabase-functions-deploy.yml` / `supabase-migrate.yml` | deploy automation | unaffected by this migration — deploys whatever code/migrations exist | **KEEP, NOT IN SCOPE** |
| `.github/workflows/intake-pipeline-health-check.yml` | synthetic end-to-end plumbing check | needs updating to assert against `estimate_runs` instead of `files.intake_status`, but the *practice* (a scheduled synthetic check) is good and should continue | **MIGRATE** (update assertions, keep the mechanism) |
| `.github/workflows/document-queue-reliability-check.yml` | concurrency-primitive test (claim races, stale reclaim, etc.) | needs updating to test `run_documents`/`estimate_runs` claim logic instead of `document_processing_jobs`, but again the *practice* is valuable and should continue, arguably expanded to cover the new orchestrator's reclaim rule directly | **MIGRATE** (update target, keep the mechanism) |

### 1.3 Retry mechanisms

| Current mechanism | Scope | Target equivalent | Verdict |
|---|---|---|---|
| `withTimeoutAndRetry` (`pipeline-logic.ts`) | 1 retry, transient-classification-gated, shared across every Claude call site in the whole app | **unchanged**, reused as-is inside every new stage handler | **KEEP** |
| `classifyAnthropicError` / `isRetryableClassification` / `maxConsecutiveOccurrences` | failure taxonomy | **unchanged**, this is genuinely correct logic | **KEEP** |
| `retry_or_fail_document_job` (migration 034) | per-document extraction retry, 3 attempts, backoff | becomes the orchestrator's generic per-`run_documents` retry, capped at **2** attempts (§6 of the target doc — a 3rd identical-strategy attempt cannot succeed where the first two didn't) | **REPLACE**, tightened |
| `record_ai_failure` (migration 043) | atomic per-file failure counter | folds into `estimate_runs.retry_count`, incremented by the same atomic-compare-and-swap pattern the orchestrator already uses for every transition — no separate RPC needed | **REPLACE** |
| `record_intake_recovery_attempt` (migration 051) | atomic per-file recovery-attempt counter | same as above — one counter (`estimate_runs.retry_count`), not two separate ones (`ai_failure_count` and `intake_recovery_attempts`) tracking overlapping concepts | **DELETE** (subsumed) |
| Solo-batch-forcing on `ai_failure_count>=1` (Stage 1/2) | "retry alone, not bundled with siblings" | no longer applicable — Extraction is already per-document in the target design (§1.2 of the target doc), there is no "bundled batch" for a single document to be pulled out of | **DELETE** (problem doesn't exist in target design) |

### 1.4 Recovery paths

| Current mechanism | What it catches | Target equivalent | Verdict |
|---|---|---|---|
| `job_intake_locks` staleness steal (`tryAcquireJobLock`, triggered only by a *new* upload) | a dead `smooth-responder` run's abandoned lock | orchestrator's reclaim step (§3 of target doc), runs on a fixed schedule independent of any new upload | **REPLACE** — strictly better: today's version only fires when a builder happens to retry; the target fires every 15-30s regardless |
| `reclaim_stale_document_jobs` (migration 036) | a `document_processing_jobs` row stuck `running` | same orchestrator reclaim step, applied to `run_documents` | **REPLACE** |
| `recompute_stalled_batches` | defense-in-depth batch-status re-derivation | no longer needed — there's no separate batch-status to drift from its children, because `estimate_runs.status` is written directly, not derived | **DELETE** |
| `find_batches_with_claimable_work` | discover a batch whose worker chain died | orchestrator reclaim step | **REPLACE** |
| `release_stale_job_intake_lock` (migration 045) | safe lock-only release without re-triggering | folds into the orchestrator's reclaim (which both releases *and* re-dispatches in one step, since there's no separate "just release, don't retrigger" mode needed — the whole point of removing the self-chain design is that re-triggering is never dangerous, it's just re-discovering current state) | **DELETE** (problem doesn't exist in target design — see §6.1 for the one honest caveat) |
| `find_and_fail_abandoned_files` (migration 046) — **the currently-unresolved revert-loop source** | files stuck non-terminal with no lock | no longer needed as a *separate* mechanism — a run stuck in a non-terminal state with an expired claim is exactly what the reclaim step already looks for, using one rule instead of a second, independently-reasoned-about one that can (and did) disagree with the first | **DELETE** — this is the single most consequential deletion in this plan, since it removes the exact mechanism implicated in the still-unresolved incident from `WORKA_SYSTEM_AUDIT.md` §7 |
| `find_stuck_batches_needing_classification_retry` (migration 052) | a batch that finished extraction but never reached `smooth-responder` | orchestrator reclaim step | **REPLACE** |
| `MAX_RECOVERY_ATTEMPTS` cap (3, per file) | stop retrying a deterministically-failing file forever | `estimate_runs.retry_count` cap (2, per run, per §6.2 below — see the explicit accuracy correction) | **MIGRATE**, redefined at the run level |
| `AI_RECOVERY_DISABLED` / `DOCUMENT_RECOVERY_DISABLED` kill switches | emergency stop for the recovery cron | the orchestrator needs its **own** kill switch (a single `ORCHESTRATOR_PAUSED` flag, checked at the top of every tick) — this is not optional to drop, see §5 | **KEEP THE CONCEPT**, single switch instead of two |

### 1.5 Database tables — disposition summary

| Table | Verdict | When |
|---|---|---|
| `job_intake_locks` | **DELETE** | Phase 5, after bake period |
| `document_processing_batches` | **DELETE** (data migrated to `estimate_runs` first) | Phase 5 |
| `document_processing_jobs` | **DELETE** (data migrated to `run_documents` first) | Phase 5 |
| `intake_recovery_runs` | **DELETE** (superseded by `run_events` + `orchestrator_ticks`) | Phase 5 |
| `files.intake_status`/`intake_stage`/`intake_pct`/`intake_batch_index`/`intake_batch_count`/`intake_recovery_attempts`/`ai_failure_classification`/`ai_failure_count` columns | **DELETE columns** (not the table — `files` keeps `filename`, `storage_path`, `file_type`, `job_id`, `builder_id`, `upload_batch_id`) | Phase 5 |
| `estimate_runs` (new) | **CREATE** | Phase 0 |
| `run_documents` (new) | **CREATE** | Phase 0 |
| `run_events` (new) | **CREATE** | Phase 0 |
| `orchestrator_ticks` (new, added in this plan) | **CREATE** | Phase 0 |
| `project_documents`, `project_facts`, `scope_items`, `clarifying_questions` | **KEEP, unchanged schema** — these are the evidence/fact layer, not the run-tracking layer, and are not implicated in any incident | not touched |
| `quotes`, `quote_line_items` | **KEEP schema, CHANGE write semantics** (versioned inserts instead of in-place upsert — target doc §7) plus **one new required column**, see §6.3 | Phase 3-4 |

---

## 2. What Can Be Deleted Safely

"Safely" is defined precisely: **a deletion is safe only once nothing in production reads the deleted thing, verified by a bake period with zero reads logged, not by code review alone.** Ordered by how confidently that bar can be met:

1. **`find_and_fail_abandoned_files` (migration 046) and its call site** — safe to delete as soon as the orchestrator's reclaim step is live and has run in production for the bake period (§7, Phase 4→5 gate), *and* the currently-open revert-loop incident is confirmed to have stopped recurring. This is not safe to delete opportunistically before that confirmation — deleting the mechanism doesn't fix the underlying cause if the underlying cause turns out to be something else entirely (the root cause is still unconfirmed per the audit). Delete the *file/route*, but only after the *new* mechanism has independently demonstrated it doesn't reproduce the symptom.
2. **The recovery cron route and both kill switches** — safe once Phase 4 is complete and no traffic depends on it.
3. **`document_processing_batches`/`_jobs` tables** — safe once their data has been migrated (§3) and the new orchestrator has been the sole writer for the full bake period.
4. **`job_intake_locks`** — safe at the same point as #3, since nothing else reads it once the orchestrator owns claiming.
5. **The duplicate Deno copy of `lib/estimating/gates.ts`** — this one is safe *earlier and independently* of the rest of this plan: if gate evaluation moves to run exclusively in the Next.js Pricing+QA stage (target doc §8), the Deno copy becomes provably unused the moment that cutover happens, verifiable by removing it and confirming `smooth-responder`'s (or its replacement's) line-item output is byte-identical in shadow mode first.
6. **`vercel.json`'s inert cron entries** — unrelated to this migration but flagged in `WORKA_SYSTEM_AUDIT.md` §2.9 as already-dead; safe to delete independently, any time, zero coupling to this plan.

**Explicitly NOT safe to delete yet, despite being named in the target architecture doc:** the Voyage AI semantic-dedup integration. See §6.1 — this is walked back from the target doc's "DELETE (defer)" verdict.

---

## 3. What Must Be Migrated (not just deleted)

Deleting a table is easy; the data and in-flight state inside it is the actual risk. Concretely:

1. **In-flight runs at cutover time.** At the moment any phase in §7 flips traffic from old to new, there will be jobs mid-pipeline under the old system. These must be allowed to **finish on the old system** — do not migrate an in-flight `document_processing_batches` row into a half-formed `estimate_runs` row. The cutover rule is: *new uploads* go to the new pipeline once a phase is live; *already-running* pipelines finish where they started. This avoids ever needing to write a live-state migration for the hardest case (a run mid-Claude-call).
2. **Historical `document_processing_batches`/`_jobs` rows**, once fully drained (nothing non-terminal remains) — migrate for audit-trail continuity, not because anything needs to act on them: a straightforward one-time backfill INSERT into `estimate_runs`/`run_documents` preserving `created_at`/`completed_at`/`status` history, run once, read-only afterward.
3. **`files.skipped_sibling_filenames`/`failed_sibling_filenames` history** — same treatment, backfilled into `run_documents` rows with `status='failed'` for historical runs, so existing Proof/audit views referencing "what was skipped" don't go blank.
4. **Every consumer of `files.intake_status`** — this is the one requiring real code changes across the app, not just backend migration: `IntakeProgress.tsx`, `JobSnapshotPanel.tsx`'s risk list, chat's `review_assumptions` handler (per `WORKA_SYSTEM_AUDIT.md`'s own note that this handler reads per-file status), and the SSE route itself all need to be repointed at `estimate_runs`/`run_documents` before the old columns can be dropped. **This is the largest actual engineering surface in the whole migration** — bigger than the backend redesign — and should be scoped and estimated as its own workstream, not treated as a footnote of the backend cutover.
5. **`quotes.document_contribution`** (migration 039's per-source-document fact accounting, surfaced in QuoteView's "What WorkA read" panel) — this is genuinely valuable, product-facing, and must be preserved by the new Understanding/Estimate handlers writing the same shape of report, not silently dropped in the simplification.

---

## 4. Failure Modes That Disappear

Mapped explicitly to the incidents documented in `WORKA_SYSTEM_AUDIT.md` §7, so each claim is falsifiable against a real, named prior incident rather than asserted in the abstract:

| Prior incident / failure mode | Why it cannot recur in the target design |
|---|---|
| Wall-clock deadlock (Stage 3 + Stage 6 budgets summing to more than the isolate ceiling) | Each stage is now its own independently-dispatched, independently-timed invocation — there is no shared wall clock across stages to exhaust, because nothing runs two stages in one invocation anymore. |
| `bailForWallClockBudget` silently returning with no terminal state | There is no wall-clock-budget concept in the target design at all — a stage either completes within its own fixed, small timeout or it doesn't, and either outcome is always written (§3 of target doc, step 4: exactly one `UPDATE` per completed unit of work, always). |
| Recovery cron re-triggering a batch that "never reached smooth-responder" every tick, forever, re-running Stage 3 each time at real cost | There is no separate "did the trigger arrive" question — the orchestrator doesn't infer anything from absence-of-a-lock combined with a stale unrelated timestamp; it reads `estimate_runs.status` directly, which is exactly and only ever what it actually is. |
| Abandoned-files revert loop (files repeatedly reset to `processing` by one mechanism, re-caught by another) | There is only one mechanism now, not two independently-reasoned-about ones that can disagree with each other. A single write path for `estimate_runs.status`, enforced by the compare-and-swap `UPDATE`, cannot be "fought" by a second mechanism, because there is no second mechanism. |
| Malformed self-chain URL silently dropping `document-worker`'s trigger (the bug already found and fixed once in `document-worker/index.ts`) | There is no self-chaining HTTP call at all in the target design — the orchestrator calls stage handlers directly and awaits them. An entire class of "the trigger fetch silently failed" bugs is structurally impossible because there's no trigger fetch. |
| `files.intake_status` dual-write-path ambiguity (legacy direct-invocation literal writes vs. queue-model derived recompute) | One column, one writer, one write mechanism (the orchestrator's atomic transition) — the legacy path doesn't exist in the target design, so there's nothing for a second path to disagree with. |
| Sibling files frozen at `uploaded` forever (the bug migration 052 fixed) | `run_documents` gives every document, not just a primary/anchor file, a real row and a real status from the moment the run is created — there's no "anchor file" concept to privilege. |

---

## 5. New Failure Modes This Architecture Introduces

This is the section the critical requirement most directly demands, and it is written to the same standard as the audit's own skepticism about itself — **the target architecture is not risk-free, and claiming otherwise would repeat the exact overclaiming the peer review caught in the audit.**

1. **The orchestrator becomes a new single point of failure.** Today, a `smooth-responder` invocation dying only affects the one run it was processing (plus whatever recovery eventually notices). If the orchestrator tick itself fails to fire — pg_cron misconfigured (the audit already flags this as **UNKNOWN, possibly never actually set up in production**), the Vault secret missing, the tick function throwing before it does anything — **every single in-flight run across every builder stalls simultaneously**, not just one. Mitigation, non-negotiable, not optional: **two independent trigger paths for the tick** (pg_cron *and* a GitHub Actions workflow calling the same endpoint, exactly the redundant-trigger pattern the current system already uses for the other crons), plus a health check that alerts if no tick has run in N minutes — this must ship *in the same phase* the orchestrator goes live, not as a follow-up.
2. **The crash-after-Claude-call-before-write race is bounded, not eliminated.** If a stage handler successfully calls Claude, then crashes before writing the result and advancing `status`, the orchestrator's reclaim will re-dispatch that stage — which calls Claude a **second time** for work that was already (expensively) done once. This exact race exists in the *current* system too (a bailed run gets retried) — it is not a regression, but the target doc's "no bug should be able to spend unlimited API credits" framing should not be read as "this specific race is solved," because it isn't. What actually bounds the damage is the small per-run call ceiling (§4 of target doc, 6 calls) and the per-run retry cap (2, §6.2 below) — this is risk-*mitigation*, not risk-*elimination*, and should be stated as such rather than implied away. If this turns out to matter in practice, the real fix is writing a `claude_call_started` event *before* the call and having the reclaim logic check for a very-recent unclaimed `claude_call_started` with no matching `claude_call_completed`/`failed` and treat that specific case as "ambiguous, needs human review" rather than blindly retrying — this is a real design addition worth making in Phase 1, not deferred.
3. **The global spend circuit breaker can itself cause an accuracy/availability failure if miscalibrated.** A breaker set too low fails legitimate work closed during a genuine high-volume period — which, for this product, means a builder gets no estimate at all with a generic "processing limit" message, which is arguably *worse* for trust than the current system's occasional-but-explained failures, if the threshold is wrong. This must ship with real usage data behind the initial threshold (not a guess), and with the breaker checked **only at stage-dispatch boundaries, never mid-call** — a run already inside a Claude call must be allowed to finish that call rather than being cut off, so the breaker never leaves a run in an ambiguous half-done state.
4. **Content-hash upload deduplication has a narrow but real false-negative-adjacent edge case.** It correctly never blocks a genuinely revised document (any byte change produces a different hash) — but it also means a builder who re-uploads the *exact same* file *on purpose* (e.g., after being told "try again" following an unrelated earlier failure) will be silently treated as a duplicate. This needs an explicit UX decision (warn-and-allow-override, not silently skip) — silently skipping a deliberate re-upload in the name of dedup is itself a new way to produce an incomplete estimate, which is precisely the failure category this whole migration is supposed to reduce.
5. **Versioned quotes, without a single explicit "current" pointer, are a new trust risk, not a pure improvement.** If a job accumulates multiple `quotes` rows across incremental uploads and nothing marks exactly one as authoritative, any UI or report that doesn't carefully filter risks showing a builder (or worse, a client) a stale number. **This must ship with a hard DB constraint** — a partial unique index ensuring at most one `is_current = true` quote per job — not left as an application-layer convention. This is called out as a required addition in §6.3, not an optional nice-to-have.
6. **Polling latency replaces push latency.** The orchestrator's 15-30 second tick means a run can sit "claimed but not yet actually started" for up to a tick interval, where today's self-chain fires (when it works) near-instantly. For a builder watching the SSE progress bar, this is a few extra seconds of apparent stall at each stage boundary — a real, if minor, UX regression versus the happy path of the current design, worth measuring, not worth blocking the migration over, but worth being honest about rather than presenting the new design as strictly faster.
7. **A single generic reclaim rule, applied uniformly, risks reclaiming (and re-billing) work that is still legitimately in progress if any one stage's real-world runtime distribution has a longer tail than the fixed constant assumes.** Today's system learned this exact lesson the hard way (Stage 3 needing 220s, not the original 150s, on a large real project). The target design's fixed per-stage timeouts (30s/90s/90s/90s) are **estimates, not measured facts** — they must be validated against real production timing data during the shadow-mode phase (§7, Phase 1) before being trusted as reclaim thresholds, or this redesign will reproduce the identical class of bug it was built to eliminate, just with new numbers.

---

## 6. Explicit Accuracy-First Corrections to the Target Architecture

Re-examining `WORKA_TARGET_ARCHITECTURE.md`'s own simplification calls against this document's governing constraint surfaced one reversal and two required additions that document did not specify tightly enough.

### 6.1 Reversal: Voyage AI semantic fact de-duplication — KEEP, do not delete

The target doc classified this **DELETE (defer)** on the grounds that "every additional moving part must justify its existence" and it hadn't been proven necessary. Re-examined against *this* document's stricter test — **would removing it make an incomplete estimate more likely** — the honest answer is: **possibly, yes, on exactly the large multi-document projects where estimate accuracy matters most.** The mechanism it guards against (the same real-world fact restated under two different `category`/`key` labels by two different documents, both competing for a slot in `MAX_FACTS_IN_PROMPT`) is a genuine, previously-identified failure mode, and the document-balanced fact selection that replaced pure confidence-ordering does not fully close it — it narrows the ceiling, per `CLAUDE.md`'s own documented limitation, it doesn't eliminate it. Deleting an accuracy safeguard to reduce dependency count, with no production evidence yet showing it's unnecessary, is exactly the trade this document's governing constraint prohibits. **Revised verdict: KEEP through the entire migration.** Revisit removal only after the new architecture has run in production long enough to show, from real `run_events` fact-selection telemetry, that the exact-key merge alone is sufficient — evidence-driven removal, not assumption-driven removal.

### 6.2 Addition: the per-run retry cap must not be blindly copied from the per-file cap

The current system's `MAX_RECOVERY_ATTEMPTS = 3` was tuned (through actual incident history) at the *file* level. The target design moves accounting to the *run* level, which is not the same unit — a run can touch many documents. Naively setting `estimate_runs.retry_count`'s cap to 2 (matching extraction's 2-attempt cap, §1.3) risks being **too aggressive** for a run's later, more expensive stages (Understanding/Scope/Estimate) if a transient, genuinely-retryable failure (network blip, rate limit) happens to occur twice by bad luck rather than because the work is fundamentally unretriable. **Required addition:** the retry cap must be tracked and enforced **per stage-attempt, not as one shared counter for the whole run** — a run that needed one retry during Extraction and one during Understanding has not "used up" a shared budget of 2 and thereby been denied a legitimate retry during Estimate. This is a small but real correctness detail the target doc left ambiguous and this plan is making explicit before implementation, precisely because getting the cap semantics wrong risks failing a recoverable run (an accuracy/completeness harm) in the name of a cost-governance number that was never validated at this granularity.

### 6.3 Addition: `quotes.is_current` is a required schema addition, not optional polish

As flagged in §5.5 — versioned quotes without an enforced single-current-quote invariant is a new trust risk the target doc's §7 did not fully specify. **Required, not optional:** `quotes.is_current boolean not null default false`, with a partial unique index `UNIQUE (job_id) WHERE is_current`, flipped atomically (old current → false, new current → true, in one transaction) every time a run completes. Every builder-facing and client-facing surface (QuoteView, the client approval portal, Morning Brief, Proof exports) must read `is_current = true`, never "most recent by `created_at`" — the two are almost always the same value but are not the same *guarantee*, and this system has already learned, repeatedly, that "almost always" is where its incidents live.

---

## 7. Phased Implementation Plan With Rollback Points

Same phase structure as `WORKA_TARGET_ARCHITECTURE.md` §9, now with concrete rollback mechanics for each phase and the corrections from §6 folded in.

### Phase 0 — Schema addition only
**Do:** create `estimate_runs`, `run_documents`, `run_events`, `orchestrator_ticks`, `quotes.is_current` (default `true` for every existing quote that is currently a job's latest, backfilled once). Nothing reads or writes the new tables from application code yet.
**Rollback:** `DROP TABLE`/`DROP COLUMN` — zero behavioral risk, nothing depends on these yet. This phase cannot break production by construction.
**Exit criterion:** schema exists, migration applied and verified via the existing `supabase/verification/schema_assertions.sql` pattern (extend it to cover the new tables), PostgREST schema cache reloaded.

### Phase 1 — Shadow mode
**Do:** build the orchestrator tick and all four stage handlers. For every real upload, the **existing pipeline runs unchanged and remains the source of truth for the builder-facing result.** In parallel, feed the same inputs through the new orchestrator, writing only to Phase 0's new tables. Compare fact counts/categories, scope trade coverage, and line-item counts between old and new for every shadow run. **Use this phase to measure real per-stage timing distributions** (§5, failure mode 7) before any timeout constant is trusted.
**Rollback:** disable the shadow-mode feature flag; zero user-visible effect either way, since shadow mode never influences a real outcome.
**Exit criterion:** shadow-run parity demonstrated across a meaningful sample (not "looks fine on 3 test jobs") — specifically, fact/scope/line-item counts within an agreed tolerance on at least the volume of one real week of production uploads, and measured per-stage timing distributions used to set (not guess) the reclaim thresholds.

### Phase 2 — Cut over Extraction only
**Do:** point the orchestrator's claim/dispatch at real `run_documents` rows for real uploads; reuse `document-worker`'s extraction logic (`extractPdfTextGated`, vision-selective processing, all unchanged) invoked by the tick instead of self-chaining. Understanding/Scope/Estimate continue on the legacy path, bridged by a compatibility write so the legacy `smooth-responder` still sees completed extraction results in the shape it expects.
**Rollback:** flip the dispatch source back to the legacy `document-worker` self-chain trigger — the legacy code path is untouched and still fully present, this is a routing change, not a code deletion.
**Exit criterion:** extraction success/failure rates and timing match or beat the legacy path over a full bake period (recommend two weeks, matching the audit's own stated bar for this system given its incident history), zero increase in documents landing in a failed/ambiguous state.

### Phase 3 — Cut over Understanding, then Scope, then Estimate — one stage at a time, per-builder feature flag
**Do:** ramp gradually (a handful of volunteer/internal builders → a percentage → everyone), one stage at a time, in the order listed (Understanding first, since its correctness is easiest to verify against Extraction's already-migrated output; Estimate last, since it's the stage whose output most directly becomes the number a client sees). Apply §6.2's per-stage-attempt retry accounting from the start, not retrofitted later.
**Rollback:** the feature flag is per-builder and per-stage — any builder can be reverted to the legacy pipeline for any one stage instantly, without affecting other builders or other stages. This is the single most important rollback property in the whole plan and should be validated (an actual rollback drill, not just a design claim) before ramping past the first volunteer builder.
**Exit criterion per stage:** output parity with the legacy pipeline on real traffic for the bake period, `run_events` showing zero unexplained reclaims, the circuit breaker (§5.3) validated against real timing data rather than a guess.

### Phase 4 — Cut over the SSE presentation layer
**Do:** `app/api/intake/[fileId]/route.ts` becomes a thin poller over `estimate_runs`/`run_documents`/`run_events` — no lock acquisition, no batch creation, no dual-write logic of its own. This can only happen once Phase 3 is complete for all four pipeline stages, since the SSE route needs one consistent state source to poll.
**Rollback:** keep the legacy SSE logic in the codebase (dead but present) until Phase 5; reverting this phase means redeploying the previous route file, a standard code rollback, not a data migration.
**Exit criterion:** zero increase in SSE-reported errors/timeouts versus the legacy route over the bake period; `IntakeProgress.tsx` and `ClarifyingQuestionsPanel.tsx` updated and manually verified against real builder-facing flows (upload, clarification, completion, failure), not just unit-tested.

### Phase 5 — Delete old machinery (the point of no return, treated as such)
**Do:** only after Phase 4's full bake period with zero stuck runs and zero unexplained reverts. Delete in this specific order, each as its own reviewable commit, **not one large deletion**: (a) the recovery cron route + both kill switches + `intake_recovery_runs`; (b) `job_intake_locks`; (c) `document_processing_batches`/`_jobs` (after the historical backfill in §3.2 is confirmed complete); (d) the `files` pipeline-state columns (after confirming, by grep and by a runtime check, that nothing still reads them — see §3.4's list of consumers that must already have been migrated in Phase 4); (e) the duplicate Deno gates copy; (f) `database.types.ts` regenerated properly (`supabase gen types typescript`) as part of this same phase, not left stale again.
**Rollback:** **this is the one phase where rollback means `git revert` plus restoring from a schema backup taken immediately before this phase's migrations run** — explicitly call this out to whoever executes this phase, and take that backup as a mandatory, checked step, not an assumption. Everything before this phase is reversible by a routing/flag change; this phase is reversible only by restoring deleted state, which is why it comes last and only after the longest bake period in the plan.
**Exit criterion:** N/A — this phase *is* the exit criterion for the whole migration.

### Phase 6 — Extend cost governance system-wide (independent, can run in parallel with any phase above)
**Do:** apply the per-run/per-builder/global circuit breaker (target doc §4) to every other Anthropic call site in the app (`chat/route.ts`'s three call sites, `email-draft`, `classify-document`, `email-sync/parse`, `email-sync/simulate`, `estimation/scope-hints`, `estimation/history`, `rates/extract-pdf`) — ten call sites total per the audit's own count, only three of which are inside the estimating pipeline this plan otherwise covers.
**Rollback:** each call site's breaker check is a simple, independently-revertible guard clause — no data migration, no phase dependency.
**Exit criterion:** a single global spend dashboard shows real, measured spend against real, evidence-based thresholds (not guessed ones) across all ten call sites, not just the three this migration otherwise touches — **this phase is the actual, complete answer to "uncontrolled API spend," and should not be considered done just because the estimating pipeline's three call sites are covered.**

---

## 8. Summary Answer to the Five Numbered Asks

1. **Safely deletable, in order of confidence:** `find_and_fail_abandoned_files` and the recovery cron (after Phase 4), `job_intake_locks`, `document_processing_batches`/`_jobs`, `intake_recovery_runs`, the duplicate Deno gates file, `vercel.json`'s inert crons (independent, anytime). **Not** the Voyage AI dedup (§6.1, reversed from the target doc).
2. **Must be migrated, not just deleted:** in-flight runs (finish on the old system, don't half-migrate); historical batch/job rows (backfill for audit continuity); every UI/handler consumer of `files.intake_status` (the largest real engineering surface in this plan); `quotes.document_contribution`'s reporting shape.
3. **Failure modes that disappear:** every incident named in `WORKA_SYSTEM_AUDIT.md` §7 — the wall-clock deadlock, the silent-bail-with-no-terminal-state bug, the recovery-cron retrigger storm, the abandoned-files revert loop, the malformed self-chain URL bug class, the dual-write-path ambiguity, and the frozen-sibling-file bug — all map to the same root cause (two independently-reasoned-about mechanisms that can disagree, or a proxy-based liveness signal), and all are closed by the same structural change (one mechanism, one direct write, no self-chaining), not by seven separate fixes.
4. **New failure modes introduced:** the orchestrator as a new single point of failure (mitigated by redundant triggers, mandatory not optional); the crash-after-call-before-write race (bounded, not eliminated — stated honestly); a miscalibrated circuit breaker causing legitimate-work failures (mitigated by stage-boundary-only checks and evidence-based thresholds); a content-hash dedup false-positive on deliberate re-uploads (needs a warn-not-silently-skip UX); versioned quotes without an enforced current-pointer (closed by the required `is_current` addition, §6.3); polling latency vs. push latency (minor, honest UX trade-off); reclaim thresholds that are estimates until validated against real shadow-mode timing data (§7 Phase 1 makes this validation a hard exit criterion, not optional).
5. **Phased plan with rollback points:** §7 above — six phases, five of which are cleanly reversible by a flag/routing change, one of which (Phase 5, deletion) is explicitly called out as the sole point of no return and gated behind the longest bake period in the plan.

---

*No code was modified in the production of this document.*
