# WORKA_IMPLEMENTATION_READINESS.md

**Purpose:** a go/no-go readiness check on `WORKA_TARGET_ARCHITECTURE.md` and `WORKA_MIGRATION_PLAN.md` against the real codebase, organized around one question — *can this be built and rolled out without a window where it can silently produce a wrong builder quote or drain API credits?* No code is changed by this document. Two gaps not caught by either prior document are surfaced below (§4.1, §4.2) — this pass is not a restatement of the prior two, it is a stress-test of them.

---

## 1. Current Tables/Columns That Become Obsolete

Restated from `WORKA_MIGRATION_PLAN.md` §1.5, organized here by *what actually goes away* rather than by mapping direction:

**Tables, fully removed (Phase 5 only, after full bake — see §5):**
`job_intake_locks`, `document_processing_batches`, `document_processing_jobs`, `intake_recovery_runs`.

**Columns removed from `files`** (the table itself stays — it keeps `filename`, `storage_path`, `file_type`, `job_id`, `builder_id`, `upload_batch_id`, and a single `uploaded` boolean/flag if still needed):
`intake_status`, `intake_stage`, `intake_pct`, `intake_batch_index`, `intake_batch_count`, `intake_recovery_attempts`, `ai_failure_classification`, `ai_failure_count`, `skipped_sibling_filenames`, `failed_sibling_filenames`, `failure_stage`, `failure_reason`, `processing_batch_id`.

**Code/config that becomes dead**, not a DB object but load-bearing enough to list here explicitly: `app/api/cron/intake-recovery/route.ts` in its entirety (601 lines, both kill switches), the pg_cron schedule from migration 038, `.github/workflows/intake-recovery-cron.yml`'s current target, the duplicate Deno copy of `lib/estimating/gates.ts`, and every RPC named in migration-plan §1.4 (`reclaim_stale_document_jobs`, `recompute_stalled_batches`, `find_batches_with_claimable_work`, `release_stale_job_intake_lock`, `find_and_fail_abandoned_files`, `find_stuck_batches_needing_classification_retry`, `record_ai_failure`, `record_intake_recovery_attempt`).

---

## 2. New Tables Required

Sketched to actual-implementation detail (the prior two documents named these tables but didn't specify columns — that specificity belongs in a readiness check, not a design doc):

```sql
create table estimate_runs (
  id                    uuid primary key default gen_random_uuid(),
  job_id                uuid not null references jobs(id),
  builder_id            uuid not null references builders(id),
  status                text not null check (status in (
                          'queued','extracting','understanding','scoping',
                          'needs_clarification','estimating','finalizing',
                          'complete','failed')),
  claimed_by            text,
  claimed_at            timestamptz,
  created_at            timestamptz not null default now(),
  completed_at          timestamptz,
  ai_calls_made         int not null default 0,
  ai_cost_cents_estimate numeric not null default 0,
  -- per-stage retry accounting (§6.2 of the migration plan — NOT one shared counter)
  retry_count_extraction    int not null default 0,
  retry_count_understanding int not null default 0,
  retry_count_scoping       int not null default 0,
  retry_count_estimating    int not null default 0,
  failure_category      text check (failure_category in (
                          'ai_timeout','ai_provider_error','ai_billing_halt',
                          'ai_budget_exceeded','extraction_failed',
                          'ambiguous_retry_blocked','unknown')),
  failure_reason         text,
  previous_run_id        uuid references estimate_runs(id),
  quote_id               uuid references quotes(id)
);

create table run_documents (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references estimate_runs(id),
  file_id     uuid not null references files(id),
  status      text not null check (status in ('pending','extracting','done','failed')),
  attempts    int not null default 0,
  claimed_by  text,
  claimed_at  timestamptz,
  error_message text
);

create table run_events (
  id         bigserial primary key,
  run_id     uuid not null references estimate_runs(id),
  ts         timestamptz not null default now(),
  event_type text not null,  -- run_created, document_claimed, document_completed,
                              -- document_failed, claude_call_started,
                              -- claude_call_completed, claude_call_failed,
                              -- stage_transition, reclaim, run_completed, run_failed
  detail     jsonb not null default '{}'
);

create table orchestrator_ticks (
  id             bigserial primary key,
  ts             timestamptz not null default now(),
  runs_claimed   int not null default 0,
  runs_reclaimed int not null default 0,
  duration_ms    int not null,
  errors         jsonb not null default '[]'
);

alter table quotes add column is_current boolean not null default false;
create unique index quotes_one_current_per_job on quotes(job_id) where is_current;
```

Plus two governance tables not named as tables in either prior document (they described the *concept* of per-builder/global spend limits without specifying storage — this is the gap a readiness pass exists to close):

```sql
create table ai_spend_daily (
  builder_id  uuid,          -- null row = global total
  day         date not null,
  cost_cents  numeric not null default 0,
  call_count  int not null default 0,
  primary key (builder_id, day)
);

create table system_status (
  key         text primary key,   -- 'ai_circuit_breaker', 'orchestrator_paused'
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
```

---

## 3. Existing User Flows Affected

| Flow | Component(s) | Effect |
|---|---|---|
| Document upload progress | `UploadPanel.tsx`, `IntakeProgress.tsx`, SSE route | Reads a different data source (`estimate_runs`/`run_documents` instead of `files.intake_status`/`intake_stage`) — **must produce an identical or better builder-facing experience**, not just an equivalent backend. See §4.2 for a gap in how this is sequenced. |
| Blocking clarifying questions | `ClarifyingQuestionsPanel.tsx`, `POST /api/intake/[fileId]/clarify` | The `needs_clarification` state maps directly; the clarify route's answer-then-resume logic is preserved conceptually but now creates a **new** `estimate_runs` row per §7 of the target doc's versioned-quote model, not a `resume:true` re-invocation of the same run — this is a real behavior change worth the product team explicitly signing off on, not just an implementation detail. |
| Incremental upload to a job with an existing quote | Upload flow + `AssumptionReview.tsx` | Currently mutates the existing quote in place; target design always produces a new versioned `quotes` row. `quotes.is_current` must be correctly set for the builder to see the right number — **this is the single flow most likely to show a builder a wrong number if `is_current` logic has a bug**, since it's the one place two quotes for the same job legitimately coexist. |
| Job Snapshot risk list | `JobSnapshotPanel.tsx` | Per `WORKA_SYSTEM_AUDIT.md`, this reads per-file `intake_status` for "N plans uploaded but not yet processed" messaging — must be repointed at `run_documents`. |
| Chat `review_assumptions` intent | `app/api/chat/route.ts` | Same dependency on file-level status, per the audit's own note — must be repointed. |
| Quote review / send | `QuoteView.tsx`, `SendQuoteModal.tsx`, `deriveQuoteReadiness()` | Must read the `is_current` quote, not "most recent by `created_at`" — see the flow above. `deriveQuoteReadiness()` itself is unaffected (operates on a resolved quote's line items, agnostic to how that quote was selected). |
| "What WorkA read" panel (`quotes.document_contribution`) | `QuoteView.tsx` | Must continue to be populated by the new Understanding/Estimate handlers in the same shape — a silent gap here wouldn't break anything mechanically but would quietly remove a real trust-building feature. |
| Morning Brief | `lib/morning-brief.ts`, `morning-brief` edge function | Reads job/quote state, not intake-pipeline state directly — **low risk**, but must be checked for any `files.intake_status` reference before those columns are dropped in Phase 5. |
| WorkA Proof / audit trail | `lib/proof.ts`, `ProofTab.tsx`, Proof Pack export | Unaffected in mechanism (still hash-chains `proof_events`), but the *content* of what gets recorded around estimate generation should be reviewed once run versioning exists — a builder disputing a quote may reasonably ask "which run produced this," and Proof should be able to answer that from `estimate_runs.id`. |
| Worker portal, variations, invoicing, rates management | — | **Not affected.** None of these read intake-pipeline state; confirmed by the audit's own inventory of what actually consumes `files.intake_status`. |

---

## 4. Migration Risks

Everything from `WORKA_MIGRATION_PLAN.md` §5 still applies (orchestrator SPOF, the crash-after-call-before-write race, circuit-breaker miscalibration, content-hash edge cases, versioned-quotes without a pointer, polling latency, unvalidated reclaim thresholds) and is not repeated here. Two additional risks, found by re-reading the migration plan specifically against the "cannot drain API credits" requirement rather than the "cleaner architecture" framing it was written under:

### 4.1 Shadow mode (Phase 1), as specified, doubles real AI spend — this directly contradicts the stated goal

`WORKA_MIGRATION_PLAN.md` §7 Phase 1 says: *"the existing pipeline runs unchanged... In parallel, feed the same inputs through the new orchestrator."* Read literally, this means **every real builder upload during the shadow-mode phase triggers Understanding/Scope/Estimate Claude calls twice** — once for the legacy pipeline (the real result) and once for the new orchestrator (comparison only). For a phase whose whole purpose is building confidence before real risk is taken, this quietly introduces the exact risk category the entire redesign exists to prevent: unbounded extra spend, for validation, on top of production traffic. **This must be corrected before Phase 1 starts, not treated as an acceptable cost of validation:**
- Shadow mode should run against a **capped, explicitly budgeted sample** of real uploads (e.g., 10% of traffic, itself subject to its own line item in `ai_spend_daily`), not 100%.
- Prefer **record-and-replay** over live dual-calling where feasible: capture the legacy pipeline's actual inputs (the fact block, the scope block) and replay them into the new handlers asynchronously, off the critical path, on a schedule that respects the same spend caps as everything else — this validates the new handlers' *logic* without doubling live spend for every real upload.
- Whichever approach is chosen, shadow-mode spend must appear in the same `ai_spend_daily`/global-circuit-breaker accounting as real traffic, not be exempted from it as "just testing."

### 4.2 Phase 3 (stage cutover) has no compatibility bridge specified, and needs one before a single real builder is routed through it

The migration plan sequences Phase 3 (cut over Understanding/Scope/Estimate, per-builder flag) *before* Phase 4 (cut over the SSE presentation layer). Read together, this means: for any builder flagged into Phase 3, the actual pipeline work happens through the new orchestrator and writes to `estimate_runs`/`run_documents` — **but that builder's `IntakeProgress.tsx` SSE connection is still polling `files.intake_status`/`intake_stage`**, per Phase 4 not having happened yet. Nothing in either prior document specifies what bridges this gap. Without an explicit bridge, the first real builder routed through Phase 3 sees a progress bar that never moves — which is functionally a **stuck estimate** from that builder's point of view, even though the backend is working correctly. **Required, not optional, before Phase 3 goes live for even one builder:** a compatibility write inside each new stage handler that also updates the legacy `files.intake_status`/`intake_stage`/`intake_pct` columns as a byproduct of every real transition, so the existing SSE route and UI keep working, unmodified, until Phase 4 formally cuts them over. This is a small, mechanical addition, but its absence is a launch-blocking gap, not a polish item.

---

## 5. Rollback Strategy

Consolidated from `WORKA_MIGRATION_PLAN.md` §7, stated as a standalone strategy:

- **Phases 0-1:** rollback is deleting unused tables / disabling a flag. Zero production coupling — these phases cannot break anything by construction, since nothing user-facing depends on them yet.
- **Phase 2 (Extraction):** rollback is flipping the dispatch source back to the legacy `document-worker` self-chain. The legacy code path must remain **untouched and deployed** throughout this phase specifically so this flip is instant, not a redeploy.
- **Phase 3 (Understanding/Scope/Estimate):** rollback is per-builder, per-stage, via feature flag — this is the load-bearing rollback property of the whole plan and **must be drilled once for real, on a real (volunteer) builder, before it's trusted** — a rollback mechanism that has only ever been unit-tested is not a proven rollback mechanism.
- **Phase 4 (SSE layer):** rollback is redeploying the previous route file — standard code rollback, no data implications, since §4.2's compatibility bridge means the legacy route was never actually broken by Phase 3.
- **Phase 5 (deletion):** **the only phase without a code-level rollback.** Explicitly requires a schema backup taken immediately before this phase's migrations run, treated as a mandatory checked step. This is why Phase 5 is gated behind the longest bake period (two weeks minimum, matching the audit's own bar) and is executed as a sequence of small, individually-reviewable deletions (§7 of the migration plan lists the exact order), never one large deletion commit.
- **Cross-cutting:** the `ORCHESTRATOR_PAUSED` kill switch (§8 below) is not a rollback mechanism for a specific phase — it's an emergency stop for the whole new system, usable at any point in Phases 2-5, mirroring the exact `AI_RECOVERY_DISABLED`/`DOCUMENT_RECOVERY_DISABLED` pattern that has already been used four times in this system's real incident history. It must exist from Phase 2 onward, not be added reactively during an incident the way its predecessor was.

---

## 6. How We Prevent Each Named Risk

### 6.1 Duplicate Claude calls
- Every stage transition is a single atomic `UPDATE ... WHERE status = $current` — a second concurrent attempt to advance the same run matches zero rows and no-ops.
- **The one race this doesn't close** (crash after a successful Claude call, before the result is written) is addressed by writing a `claude_call_started` event *before* the call; the orchestrator's reclaim logic checks for a recent unmatched `claude_call_started` with no paired `claude_call_completed`/`failed` and treats that run as `failure_category='ambiguous_retry_blocked'` — requiring a human decision — rather than blindly retrying. **This is a required Phase-1 build item, not a stretch goal** (migration plan §5.2 named it as "worth making in Phase 1, not deferred" — this readiness pass upgrades that to a hard requirement given the explicit priority of this task).
- Per-run AI call ceiling (6) makes the *maximum possible* damage from any single run's failure mode small and known in advance, regardless of which specific race caused it.

### 6.2 Uncontrolled API spend
- Per-run ceiling (6 calls) and per-stage retry caps (capped independently, per §6.2 of the migration plan, so a legitimate retry in one stage isn't denied by an unrelated earlier stage's retry).
- `ai_spend_daily` per-builder and global rows, checked before any new run/stage dispatch — **not mid-call**, so a run already inside a Claude call is never cut off mid-flight into an ambiguous state.
- `system_status.ai_circuit_breaker` — a single global flag, tripped automatically on a spend-velocity or repeated-provider-error signal, checked by every stage dispatch **and, per §4.1 above, by shadow mode's own spend too.**
- Global concurrency limit on simultaneously in-flight runs, bounding worst-case spend *velocity* independent of per-run/per-builder caps.
- **Coverage gap, called out explicitly:** as designed, this only covers the 3 estimating-pipeline call sites. The other 7 Anthropic call sites in the app (`chat/route.ts` ×3, `email-draft`, `classify-document`, `email-sync/parse`, `email-sync/simulate`, `estimation/scope-hints`, `estimation/history`, `rates/extract-pdf`) are **not protected by this migration unless Phase 6 is done, and Phase 6 is currently scoped as independent/parallel, not required.** If "uncontrolled API spend" is being treated as a hard requirement (per this task's framing, it is), a circuit breaker that only watches 3 of 10 call sites is not actually a global breaker — see §7 for why this changes Phase 6's priority classification.

### 6.3 Incomplete estimates
- `needs_clarification` remains a first-class state — the system is designed to stop and ask rather than guess, unchanged from today.
- Voyage AI semantic fact de-duplication is **kept**, reversing the target doc's original deletion call (migration plan §6.1) — removing it was judged, on reflection, to raise real risk on exactly the large multi-document projects where completeness matters most.
- Per-stage-attempt retry accounting (§6.2 of the migration plan) means a run isn't prematurely failed — and thus produces no estimate at all — because of retry budget consumed by an unrelated earlier stage's transient failure.
- `quotes.document_contribution` reporting is preserved by requirement (§3 above), so a document that contributed nothing to the estimate stays visible and flaggable, not silently dropped.
- Content-hash upload dedup is required to warn-and-allow-override, never silently skip (migration plan §5.4) — a silently-skipped deliberate re-upload is itself an incompleteness bug this migration would otherwise introduce.

### 6.4 Stuck estimates
- The orchestrator's single reclaim rule, run on a fixed heartbeat, replaces every current bespoke staleness mechanism — closes the exact incident class documented in `WORKA_SYSTEM_AUDIT.md` §7.
- Two independent trigger paths (pg_cron + GitHub Actions) for the tick itself, plus a health check alerting if no tick has fired within N minutes — required from the moment the orchestrator goes live (§7 below), not added after an incident.
- `ORCHESTRATOR_PAUSED` kill switch for a clean, deliberate stop if something looks wrong, mirroring the pattern that has already proven necessary four times in this system's real history.
- §4.2's compatibility bridge specifically prevents a *presentation-layer* stuck-looking estimate during Phase 3, distinct from a genuinely stuck backend.

### 6.5 Incorrect quotes
- `quotes.is_current`, enforced by a DB constraint (not application convention), read by every builder- and client-facing surface — the single most important addition against this specific risk, since it's the one mechanism that prevents a stale number from ever being presented as current.
- Validation gates (`lib/estimating/gates.ts`) run in exactly one runtime going forward (the deterministic Next.js finalizing stage), removing the hand-maintained-in-two-places drift risk that exists today between it and its Deno mirror.
- `lib/pricing.ts` is untouched by this migration — the actual rate-resolution and margin-application logic that determines a client-facing dollar figure carries zero redesign risk here.
- Versioned quotes (new row per run, never mutated in place) mean an incremental upload can never partially overwrite a previously-correct line item mid-write — either the new run's full output replaces `is_current`, or it doesn't, with no intermediate state a builder could see.

---

## 7. Priority Classification

Every proposed change, classified against **when a real builder's real upload could be affected by its absence** — not against implementation convenience.

**Definitions used below:** *Before builders* = before any real builder's upload is processed by a new-pipeline stage that calls Claude (i.e., before Phase 3 starts for even one volunteer builder — note Phase 2/Extraction makes no Claude calls at all in the target design, so it does not trigger this bar on its own). *Before beta* = before ramping past an initial small/internal/volunteer group to a wider cohort. *Can wait* = no correctness or spend exposure until Phase 5/6.

| Change | Classification | Why |
|---|---|---|
| `estimate_runs`/`run_documents`/`run_events`/`orchestrator_ticks` schema (Phase 0) | **Before builders** | Prerequisite for everything; zero risk to add early. |
| `quotes.is_current` + partial unique index | **Before builders** | Cheap, safe, and closes an incorrect-quote risk the moment it could first matter. |
| Orchestrator core (claim/reclaim/dispatch loop) | **Before builders** | The mechanism this entire migration is built around. |
| Redundant trigger paths for the orchestrator tick (pg_cron + GitHub Actions) | **Before builders** | Non-negotiable per migration plan §5.1 — a single trigger path is a new, avoidable single point of failure. |
| Orchestrator health check / no-tick alerting | **Before builders** | Silent total-system stall is worse than any single-run failure mode this migration otherwise fixes. |
| `ORCHESTRATOR_PAUSED` kill switch | **Before builders** | This system's own incident history shows an emergency stop is needed, repeatedly, in practice. |
| Per-run AI call ceiling + per-stage retry caps (§6.2 semantics) | **Before builders** | Direct spend-control requirement. |
| `claude_call_started`/`completed` pairing check (ambiguous-retry detection) | **Before builders** | Directly prevents the one duplicate-call race this architecture doesn't otherwise close. |
| Global `ai_circuit_breaker`, checked at stage-dispatch boundaries | **Before builders** | Core spend-control requirement; must exist before any real Claude call goes through the new path. |
| Shadow-mode spend cap / record-and-replay redesign (§4.1) | **Before builders** — in fact, before Phase 1 even starts | Shadow mode itself is real spend against real traffic under the current plan; it must be brought under the same governance as everything else before it runs at all. |
| Phase 3 compatibility bridge to legacy `files` columns (§4.2) | **Before builders** | Its absence produces a builder-visible stuck-estimate symptom on the very first real cutover, even with a fully correct backend. |
| Content-hash upload dedup with warn-not-silently-skip UX | **Before builders** | Prevents a new incompleteness bug this migration would otherwise introduce. |
| Per-builder daily spend cap (`ai_spend_daily`) | **Before beta** | Protects against a single builder/bug's runaway usage; less urgent than the global breaker for a small, known initial cohort, but required before wider, less-known traffic. |
| Extending the circuit breaker to all 10 Anthropic call sites (Phase 6), not just the 3 pipeline ones | **Before beta**, not "can wait" — **reclassified up from the migration plan's original "independent/parallel, not blocking"** | If uncontrolled spend is a hard requirement (it is, per this task), a breaker watching 3 of 10 call sites is incomplete by definition; it must cover all of them before a wider audience increases exposure through the other 7. |
| Rollback drill for Phase 3's per-builder flag (actually exercised, not just designed) | **Before beta** | Should be proven at least once before ramping past the initial volunteer cohort. |
| CI health-check workflows updated to assert against the new schema | **Before beta** | Should exist before wider real traffic relies on the new path, though not required for the very first volunteer builder. |
| Per-stage timeout constants validated against real shadow-mode timing data | **Before builders** for Phase 3's own thresholds | Using guessed thresholds against real spend risks reproducing the exact wall-clock-deadlock incident class this migration exists to close — this is why Phase 1's exit criterion in the migration plan requires measured, not assumed, timing data. |
| `is_current` consistently read by every surface (QuoteView, client portal, Morning Brief, Proof export) | **Before builders** | An incorrect-quote risk the moment a second quote for the same job could exist on the new path. |
| Historical `document_processing_batches`/`_jobs` backfill into new tables | **Can wait** | Audit-trail continuity only; nothing acts on this data. |
| Deleting old tables/columns/RPCs (Phase 5) | **Can wait** | Explicitly gated behind the full bake period by design — deleting early is the one irreversible mistake this whole plan is structured to avoid. |
| Deno gates-copy removal, `database.types.ts` regeneration | **Can wait** | Pure cleanup, zero correctness or spend exposure. |
| Voyage AI semantic dedup | **No action — already correct, keep as-is** | Not a change; explicitly not being removed (migration plan §6.1). |

---

*No code was modified in the production of this document.*
