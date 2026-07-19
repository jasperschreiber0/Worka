# WORKA_TARGET_ARCHITECTURE.md

**Purpose:** a first-principles redesign of the document→estimate pipeline, written as reference material for evolving the existing system — not a rewrite mandate. No code was changed to produce this document.

**The question this document answers:** *What is the simplest possible system that reliably turns a builder's project documents into a trustworthy construction estimate?*

**The optimization target is not engineering elegance — it is a builder receiving a complete, trustworthy estimate every single time.** Simplicity is pursued here because it *serves* that goal (a simpler system is one where fewer things can silently go wrong between "documents uploaded" and "correct number produced"), not as an end in itself. Every simplification proposed below was checked against one question — *does this make it more or less likely the builder gets a correct, complete estimate, or gets nothing with a clear reason why* — and rejected if the answer was "less likely," even when the more cautious option costs an extra AI call, an extra retry, or an extra state. Concretely, this is why: `needs_clarification` is kept as a real, distinct state rather than collapsed away (guessing a missing quantity to save a state is never acceptable); every stage still gets a retry rather than failing on the first transient blip (fewer retries would be simpler but less reliable); quotes are fully versioned rather than patched in place specifically so nothing from a prior, possibly-still-correct estimate can be silently lost in a merge. Where a genuine tension exists between fewer moving parts and a stronger completeness/correctness guarantee, this document chooses the guarantee — that trade-off is called out explicitly wherever it comes up.

---

## 0. First Principles

If WorkA didn't exist today, here is what I would build, and why each piece earns its place.

A construction estimate is fundamentally: **read some documents → understand what they say → figure out what work they imply → put a number on that work → check the number makes sense.** That's five real steps. Everything else in a system like this — queues, locks, recovery crons, derived status columns — exists only to make those five steps survive real-world failure (a crashed process, a slow API, a corrupted file). The design goal is: **make the five steps as simple and observable as possible, and make failure-handling a property of one small, generic mechanism, not five bespoke ones.**

Two constraints are non-negotiable and shape everything below:
1. **Supabase Edge Functions meter CPU time per request (~2000ms) and cap isolate wall-clock lifetime (~400s).** This is a real platform constraint, not a design choice — any parsing-heavy work (raw PDF text extraction) must be isolated per-document so one bad file can't take down a batch. This constraint is *why* a queue-like mechanism is unavoidable — not optional cleverness.
2. **Accuracy over speed, reliability over cleverness.** Every design decision below is evaluated against: does this make it easier to trust the number, and easier to know what's happening when something goes wrong — not "is this fast" or "is this elegant."

---

## 1. The Ideal Pipeline

```
Upload  →  Extraction  →  Understanding  →  Scope  →  Estimate  →  Pricing+QA  →  Quote
 (no AI)     (no AI)         (AI)          (AI)       (AI)         (no AI)
```

Five real stages, three of which call an LLM. Extraction and Pricing+QA are deterministic and should never be allowed to look like AI stages in the state machine, logs, or cost accounting — conflating "this might fail because Claude is slow" with "this might fail because a rate lookup missed" is one of the current system's real sources of confusion, and it's avoidable.

### 1.1 Stage specifications

| Stage | Input | Output | Owner (who's allowed to write here) | Success criteria | Max runtime | Retry policy | AI cost |
|---|---|---|---|---|---|---|---|
| **Extraction** | one file (Storage object) | normalized text (or "vision required" flag) + page count, per document | one stateless extraction handler, invoked once per document | text pulled, or a definitive "this needs vision" determination made | 30s (CPU-bound parsing should never legitimately take longer) | 1 retry, vision-only on retry (never re-attempt the parser that may have crashed) | **zero** — no AI call in this stage, ever |
| **Understanding** | all documents' extracted content for one run | `project_facts` rows (evidence, confidence, source) + `project_documents` rows (classification) | one stateless understanding handler, one call per run (see §1.2 for why batching mostly disappears) | every document classified, facts extracted with evidence | 90s (small text-only inputs, see §1.2) | 1 retry, same input (a transient network/rate-limit error only) | 1 Claude call per run in the common case; only splits if the combined text genuinely exceeds a fixed size ceiling |
| **Scope** | all active facts for the job | `scope_items` (included/excluded per trade) + `clarifying_questions` | one stateless scope handler | every relevant trade has a scope entry; blocking gaps are named, not guessed | 90s | 1 retry | exactly 1 Claude call |
| **Estimate** | facts + scope | `quote_line_items` (quantities, no rates) | one stateless estimate handler | every in-scope trade has line items; unresolvable quantities are flagged, not invented | 90s | 1 retry | exactly 1 Claude call |
| **Pricing+QA** | line items | priced `quote_line_items`, `quotes.qa_report` | deterministic Next.js code (`lib/pricing.ts` + `lib/estimating/gates.ts`, unchanged) | every priceable item priced or explicitly excluded; QA risks surfaced | 5s | none needed — this is deterministic code, a genuine exception should be a bug, not a retry target | **zero** |

**Total AI calls for a successful run: 3 (Understanding, Scope, Estimate — one each).** The point of this small, fixed number isn't to minimize cost — it's that a run with three clearly-named, individually-reviewable AI calls is one a human can actually audit end to end ("here's what it read, here's what it concluded, here's what it priced") — an open-ended "up to `MAX_BATCHES` batches, each with its own retries" shape is harder to trust precisely because it's harder to fully account for. Fewer calls here is a trustworthiness property, not just an efficiency one.

### 1.2 Why "Understanding" mostly stops needing batching

Today, Stage 1/2 sends raw documents (often as vision blocks) directly to Claude, so a large upload can blow past a single call's byte budget — hence bin-packing, chunking, and up to 3 batches per run. **Separating Extraction from Understanding removes most of this problem at the source**: by the time Understanding runs, every document is already reduced to normalized text (or, for a genuinely un-text-able document like a hand-drawn sketch, a compact "this is a floor plan, page 1 of 3" vision block is still needed — but that's the exception, not the default). Most residential uploads (5-15 documents) will fit in **one** Understanding call. Only a genuinely large commercial upload needs to split, and when it does, the rule should be a fixed, simple one — "group documents into batches of at most K documents or B bytes, whichever comes first, process sequentially" — not dynamic bin-packing tuned against byte budgets. Simpler, and it was only ever complex because of a problem this redesign removes upstream.

---

## 2. State Machine

**One entity: `estimate_runs`.** One row per "attempt to turn this job's current document set into a quote." Not per-file, not per-batch — those are details of *how* a run executes, not separate things with their own status.

```
        ┌─────────┐
        │ queued  │  created; waiting for global concurrency budget
        └────┬────┘
             │ orchestrator claims it
             ▼
        ┌────────────┐
        │ extracting │  per-document, deterministic, parallel
        └────┬───────┘
             │ all documents terminal (done or failed)
             ▼
        ┌───────────────┐
        │ understanding │  1 Claude call (rarely more)
        └────┬──────────┘
             │
             ▼
        ┌─────────┐        ┌──────────────────────┐
        │ scoping │───────►│  needs_clarification  │  blocking gap found;
        └────┬────┘        └───────────┬───────────┘  builder must answer
             │ no blocking gap                      │ builder answers
             ▼                                       │ (creates a NEW run,
        ┌────────────┐                                │  see §5)
        │ estimating │◄───────────────────────────────┘
        └────┬───────┘
             ▼
        ┌────────────┐
        │ finalizing │  pricing + QA, deterministic
        └────┬───────┘
             ▼
        ┌──────────┐
        │ complete │  quote exists, builder can review/send
        └──────────┘

   (any state) ──failure──► ┌────────┐
                             │ failed │  terminal, always carries a
                             └────────┘  failure_reason + failure_category
```

**Nine states. Every one is mutually exclusive — a run is in exactly one at any moment, enforced by a single `status` column with a `CHECK` constraint, not inferred by joining tables.**

### 2.2 Why each state exists, and why not fewer

- **`queued`** — exists because of the global concurrency limit (§4). Without a hard concurrency ceiling, "queued" would be unnecessary (everything could start immediately); with one, it's the honest name for "created but deliberately not started yet," and it's a real, useful thing for a builder to see ("your upload is queued behind 3 others") rather than a fake "processing" state that isn't actually doing anything.
- **`extracting`** vs **`understanding`** — kept separate because they have fundamentally different failure characteristics and different owners: extraction is CPU-bound, per-document, no AI, sub-30s, cheap to retry; understanding is a single AI call, network/latency-bound, more expensive to retry. Merging them would hide which kind of problem occurred behind one ambiguous state.
- **`scoping`** vs **`estimating`** — kept separate because they're genuinely different reasoning tasks with different prompts and different outputs (scope narrative vs. line items), and because `needs_clarification` can only be reached from `scoping` — collapsing them would make it unclear which stage's output a blocking question refers to.
- **`needs_clarification`** — not a failure. It's the one state where the system is deliberately, correctly waiting on a human, per the product's own "never invent a quantity" rule. Keeping it distinct from `failed` is essential — conflating "I'm stuck and need you" with "I'm broken" would be a real product regression.
- **`finalizing`** — merges pricing and QA (both deterministic, both fast, both non-AI) into one state deliberately, because the user's own instruction is "fewest possible states" and there's no meaningful operational difference between "resolving rates" and "checking quality" from a support engineer's point of view — both are "the deterministic wrap-up phase." If pricing failures turn out in practice to need distinct visibility from QA findings, split this later — start merged, split only if evidence demands it.
- **`complete`** / **`failed`** — the two terminal states. Every run ends in exactly one of these, always.

**Explicitly not a state:** "processing" (too vague to be useful — replaced by naming which of the five real stages is active), "retrying" (a retry is an internal detail of a stage's own execution, not a top-level state a builder or support engineer needs to distinguish from the stage itself being in progress), "stalled"/"stuck" (this is a *judgment* the orchestrator makes about a state, not a state itself — see §3).

### 2.3 Sub-entity: `run_documents`

One row per document per run: `run_id`, `file_id`, `status` (`pending`/`extracting`/`done`/`failed`), `attempts` (max 2), `claimed_at`. This is real, necessary detail — a run with 10 documents needs to know which 8 succeeded and which 2 didn't — but it is explicitly **not** a second state machine for the same concept `estimate_runs.status` tracks. It's a child table describing *how the `extracting` state is going*, nothing more. No code anywhere derives `estimate_runs.status` from `run_documents` — the run's own status is written directly, once, by the orchestrator, when every `run_documents` row for it reaches a terminal state.

### 2.4 What replaces `job_intake_locks`

Nothing separate. `estimate_runs` gets two columns: `claimed_by` (an opaque worker/invocation id) and `claimed_at`. "Is this run locked" is just "is `claimed_at` recent, for the stage it's currently in." One row, two columns, no separate table, no separate staleness-window tuning per table.

---

## 3. The Orchestrator — the one mechanism that replaces five

This is the single biggest structural change from the current system, and it's the answer to nearly every "would I build this today?" question the brief asked.

**Design:** one function, `advance_runs()`, invoked on a fixed heartbeat (pg_cron, every 15-30 seconds — tight enough that a stuck run is noticed almost immediately, cheap enough to run forever). Each tick:

1. **Reclaim.** For every non-terminal run/document whose `claimed_at` is older than *that stage's own max runtime* (fixed constants from §1.1's table — 30s for extraction, 90s for the AI stages), clear the claim. This single rule, applied uniformly, replaces `job_intake_locks` staleness windows, `document_processing_jobs` stale-reclaim, `find_stale_job_intake_locks`, and `find_and_fail_abandoned_files` — all four existing mechanisms collapse into one `WHERE claimed_at < now() - stage_max_runtime` clause.
2. **Claim.** For every unclaimed run/document in a workable state, atomically claim it (`UPDATE ... SET claimed_by=$1, claimed_at=now() WHERE status=$2 AND (claimed_at IS NULL OR claimed_at < $3) RETURNING *` — a compare-and-swap, so two ticks racing each other can never double-claim the same row), up to the global concurrency ceiling (§4).
3. **Dispatch and await.** For each claimed unit of work, call its stage handler directly and **wait for the result** — no fire-and-forget HTTP self-chaining. If the handler throws or times out inside this tick, the claim is simply left to expire naturally and get reclaimed next tick (or the tick after) — there is no separate "did my trigger arrive" question to debug, because nothing is triggered; everything is *discovered* fresh, every tick, from the database's own current state.
4. **Write the result.** Exactly one `UPDATE ... SET status='next_stage' WHERE status='current_stage' AND id=$1` per completed unit of work — this is what makes a transition happen exactly once even if the same run is (rarely, at the edge of a reclaim window) picked up twice: the second attempt's `UPDATE` simply matches zero rows and no-ops, because the first attempt already moved the status past the `WHERE` clause's condition. **This is how "exactly once" is actually achieved in a system with uncatchable process kills — not by promising it never races, but by making every transition idempotent under a compare-and-swap.**

**Why this replaces the recovery cron entirely, not supplements it:** in the current system, "normal progress" and "recovery" are two different code paths (a self-chaining HTTP trigger for the happy path, a separate cron with five discovery queries and two kill switches for the unhappy path) that can disagree with each other — which is exactly what produced this month's incidents (a wall-clock bail that "recovery" interpreted as "never started" and re-triggered forever; an abandoned-file reset loop nobody could explain). Here, **there is only one path.** The orchestrator doesn't know or care whether a run is "new" or "recovering" — it just looks at current state and does the next correct thing. A crashed worker and a run that legitimately hasn't started yet look identical to this mechanism, and are handled identically. This eliminates an entire category of bug: *disagreement between the forward-progress mechanism and the recovery mechanism*, because there's only one mechanism.

---

## 4. Cost Control

**No bug should be able to spend unlimited API credits. Four independent, layered limits:**

1. **Per-run AI call ceiling.** A run makes at most 3 Claude calls in the successful path (Understanding, Scope, Estimate — one each), plus at most 1 retry each = **6 calls, hard ceiling, enforced in code** (`estimate_runs.ai_calls_made` incremented atomically before each call; if a 7th would be needed, the run fails with `ai_budget_exceeded` instead of calling). This number is small enough to reason about by hand.
2. **Per-run token/cost tracking.** Every Claude response includes `usage.input_tokens`/`usage.output_tokens` — persist both, plus a computed dollar estimate, to `run_events` (§6) on every call. Currently **nothing in the real system persists this anywhere** — it's a genuine, cheap, currently-missing win.
3. **Per-builder daily spend cap.** A running total (`builder_daily_ai_spend`, reset at UTC midnight) checked before a new run is allowed to start. Exceeding it doesn't silently queue the run forever — it fails fast with a clear, builder-visible message ("You've hit today's processing limit — try again tomorrow or contact support").
4. **Global daily spend circuit breaker.** One row, atomically updated, checked before *any* Claude call anywhere in the app (not just the estimating pipeline — chat, email-draft, everything). If the global ceiling is hit, every AI-calling route fails closed with a clear 503 until a human resets it or the day rolls over. **This is the single governance primitive most conspicuously missing from the current system**, and the one most directly responsible for preventing the next multi-builder, multi-hour spend incident, regardless of which specific bug causes it.

**Global concurrency limit:** the orchestrator's claim step (§3.2) never claims more than `MAX_CONCURRENT_RUNS` (e.g., 10) runs system-wide at once — this bounds worst-case simultaneous spend *velocity*, independent of the per-run and per-builder caps, which only bound spend *per unit of work*.

**No unbounded retries, anywhere.** Every stage gets exactly one retry, with a fixed timeout, for a narrowly-defined set of transient failure classes (network interruption, rate limit, provider overload — reusing the existing, genuinely well-designed `classifyAnthropicError`/`isRetryableClassification` logic from `pipeline-logic.ts` unchanged). A non-retryable failure fails the run immediately. **There is no path in this design where the same expensive call can be silently repeated more than twice, ever, by construction** — not because a cap was added on top of an otherwise-unbounded mechanism, but because the mechanism itself has no unbounded loop to cap.

---

## 5. Observability

**One support-engineer query answers everything:**

```sql
SELECT * FROM estimate_runs WHERE id = $1;
SELECT * FROM run_documents WHERE run_id = $1;
SELECT * FROM run_events WHERE run_id = $1 ORDER BY ts;
```

`run_events` is new: an append-only log (`run_id`, `ts`, `event_type`, `detail jsonb`) written at every real transition — `run_created`, `document_claimed`, `document_completed`, `document_failed`, `claude_call_started` (with prompt purpose + estimated input size), `claude_call_completed` (with token counts + duration + cost), `claude_call_failed` (with classification), `stage_transition` (from→to), `run_completed`, `run_failed` (with reason). This replaces scattered `console.log` JSON lines across three separate files (today's actual observability mechanism) with **one queryable table**, and directly answers every question the brief listed:

| Question | Answered by |
|---|---|
| What stage is this estimate in? | `estimate_runs.status` |
| What is it waiting for? | `status='needs_clarification'` → open `clarifying_questions`; else `claimed_by`/`claimed_at` shows active work |
| Why did it fail? | `estimate_runs.failure_reason` + `failure_category`, plus the exact `claude_call_failed`/`document_failed` event in `run_events` |
| How much AI has been spent? | `estimate_runs.ai_calls_made` + sum of `run_events` token/cost fields |
| How many retries occurred? | count of `claude_call_started` events per stage in `run_events` |
| Which worker owns it? | `claimed_by` |
| How long has it been running? | `created_at`/`claimed_at` vs `now()` |

No guessing, no cross-referencing five tables, no reading Deno function logs in the Supabase dashboard.

---

## 6. Failure Design

| Failure | Handling |
|---|---|
| **Claude timeout** | Fixed per-stage timeout (§1.1), `AbortController`-backed (reuse existing mechanism, it's correct). One retry if the failure classifies as transient; otherwise the run fails immediately with `failure_category='ai_timeout'`. |
| **API outage** (Anthropic down) | The global circuit breaker (§4.4) trips on repeated `overloaded`/`network_interruption` classifications across *any* run within a short window, not per-run — new stage dispatches skip the Claude call and requeue the run (stays `queued`-equivalent) for a fixed cooldown instead of every in-flight run separately hammering a downed provider and separately failing. |
| **Corrupted PDF** | Caught at Extraction (deterministic, per-document, isolated) — that one `run_documents` row is marked `failed`, extraction of siblings continues unaffected, Understanding proceeds with whatever documents succeeded. Exactly today's `completed_with_failures` idea, but now a property of one simple child table, not a derived batch-status function. |
| **Worker crash** | The orchestrator's reclaim rule (§3, step 1) picks it back up on the next tick once `claimed_at` exceeds that stage's fixed max runtime — at most ~30-90 seconds of delay, never longer, never "stuck until someone notices." |
| **Server restart** | No different from a worker crash from the orchestrator's point of view — there is no special-cased "was this a restart or a crash" logic anywhere, because the reclaim rule doesn't need to know the difference. |
| **Duplicate upload** (same file twice) | Content-hashed (SHA-256) at upload time; a second upload of byte-identical content to the same job is detected and the builder is told, rather than relying on the AI's semantic dedup to catch it after an expensive Understanding call. A new, simple, deterministic check — not present in the current system. |
| **Duplicate job** (same address twice) | Keep the existing DB-enforced partial unique index (migration 022) exactly as-is — already deterministic, already correct, nothing to change. |
| **Partial completion** | Every stage's output is durably persisted the moment it completes (facts after Understanding, scope after Scope, line items after Estimate) — a run that fails at Estimate has *already* saved its Understanding and Scope output. A builder-triggered retry creates a **new** `estimate_runs` row that can reuse those already-computed artifacts if the document set is unchanged (see §7's versioning model) rather than either silently redoing everything or silently reusing possibly-stale state without the builder knowing a retry happened at all. |
| **Pricing failure** | Not a run failure — an individual line item with no resolvable rate keeps `rate=null`, is excluded from totals, and is visible to the builder as an assumption to resolve. Exactly today's design, already correct, unchanged. |

**Recovery is never inferred from a timestamp comparing an unrelated column.** Every reclaim decision in this design compares a claim's own `claimed_at` against that specific stage's own known max runtime — never "this batch's row hasn't been touched in a while, so let's assume something downstream must be stuck," which is precisely the reasoning pattern that caused this month's incidents.

---

## 7. Quotes Are Versioned Outputs, Not Mutated State

One more simplification worth naming explicitly: today, an incremental upload to a job that already has a quote **mutates that quote in place** (upsert-with-`ignoreDuplicates` on line items, careful "don't re-insert what's already there" bookkeeping). This redesign instead makes each completed run produce a **new** `quotes` row (with `previous_run_id` linking it to its predecessor), and the builder always sees the latest run's output. This removes an entire class of merge/upsert logic — a full INSERT is simpler to reason about and to test than a conditional upsert — at essentially no extra AI cost, since Scope and Estimate already reason over the *entire* merged fact base on every incremental upload today anyway (this isn't a new cost, just a different, simpler place to write the result). It also gives WorkA Proof a genuinely complete version history for free, which is a product win, not just an engineering one.

---

## 8. Compare Against Current WorkA

| Subsystem | Verdict | Why |
|---|---|---|
| `job_intake_locks` table | **REPLACE** | Folded into `estimate_runs.claimed_by`/`claimed_at` — one row, not a separate mutex table with its own staleness-tuning. |
| `document_processing_batches` | **REPLACE** | A "batch" and a "run" are the same thing in this design; the separate entity was only ever needed because the old design let extraction and reasoning be triggered independently. |
| `document_processing_jobs` | **SIMPLIFY** | Becomes `run_documents` — same core idea (one row per document, atomic claim), stripped of the separate-batch-entity overhead. Retry count goes from 3 to 2 **not to save a call, but because a 3rd identical-strategy attempt has zero additional chance of succeeding** where the first two didn't (text-layer attempt, then vision-only fallback — there is no third strategy to try) — cutting a retry that cannot improve the outcome is not a completeness trade-off. If a genuine third extraction strategy is ever identified, this ceiling should rise to match, not stay at 2 for its own sake. |
| Recovery cron (`app/api/cron/intake-recovery/route.ts`, all 5 steps, both kill switches, `intake_recovery_runs`) | **DELETE** | Fully replaced by the orchestrator's built-in reclaim rule (§3). This is the single largest deletion in this plan, and the one the whole redesign is organized around — this file has been the site of at least four emergency interventions and is, by this document's own analysis, treating a symptom (lost self-chained triggers) that a different design doesn't produce in the first place. |
| `files.intake_status` + `recompute_file_intake_status`/`recompute_batch_file_intake_statuses` (migration 052) | **DELETE** | `files` goes back to being pure upload metadata (filename, storage path, type). Pipeline state lives only in `estimate_runs`/`run_documents`. No more derived-status recompute functions, no more two-write-path ambiguity. |
| `smooth-responder` (the 1900-line Deno monolith) | **REPLACE** | Split into four small, focused, idempotent stage handlers (Extraction already effectively exists as `document-worker` and needs the least change; Understanding/Scope/Estimate become their own simple functions), each invoked only by the orchestrator, never self-chaining. |
| `pipeline-logic.ts` (batch splitting, fact merge, Anthropic failure classification, timeout/retry wrapper) | **KEEP** | The best-designed part of the current system — pure, dependency-free, genuinely unit-tested, shared byte-for-byte across runtimes. This is the template the rest of the rebuild should follow, not something to change. Batch-splitting logic naturally simplifies once Extraction is upstream of Understanding (§1.2), but the *pattern* of "pure, tested, shared logic" is exactly right and should be extended, not replaced. |
| `lib/estimating/gates.ts` (validation gates) | **KEEP**, but **DELETE the duplicate Deno copy** | Run gates in exactly one runtime — the deterministic Pricing+QA stage in Next.js — since line items no longer need gate evaluation inside the AI-calling Deno function at all under this design. Removes a hand-maintained-in-two-places drift risk for free. |
| `lib/pricing.ts` (5-tier rate resolution) | **KEEP** | Deterministic, well-scoped, not implicated in any incident, not touched by this redesign. |
| Anthropic failure classification (`classifyAnthropicError`, `withTimeoutAndRetry`) | **KEEP** | Genuinely correct, reused as-is inside each new stage handler. |
| `ai_failure_classification`/`ai_failure_count` on `files` | **REPLACE** | Folds into `estimate_runs`' own `retry_count`/`failure_category` — one accounting unit per run instead of per-file drift. |
| Wall-clock budget bookkeeping (`WALL_CLOCK_SAFETY_MS`, `stall_stage`/`stall_count`, migration 053) | **DELETE** | Made structurally unnecessary — each stage is now its own independently-timed, independently-retried, independently-dispatched unit of work, not several stages racing a shared clock inside one long-lived function invocation. The problem this machinery patched cannot occur in this design. |
| `clarifying_questions` / needs-info pause | **KEEP** | Correct, valuable, maps directly onto the `needs_clarification` state. |
| `project_facts` / `project_documents` / `scope_items` / evidence+confidence model | **KEEP** | The core product differentiator. Not touched structurally; only the *write semantics* of the quote layer above it change (§7). |
| Exact-key fact merge/supersession (`mergeFacts`) | **KEEP** | Simple, deterministic, valuable, cheap. |
| Voyage AI semantic fact de-duplication | **DELETE (defer)** | An optional external dependency for a marginal improvement over the exact-key merge, with no evidence yet that it's paying for itself. "Every additional moving part must justify its existence" — this one hasn't, yet. Can be reintroduced later if production data shows the exact-key merge is genuinely insufficient at scale. |
| `lib/types/database.types.ts` | **SIMPLIFY** | Stop hand-maintaining it. Generate it from the live schema (`supabase gen types typescript`) as part of every migration deploy, and actually wire the typed client into new code as it's written — closing the current dead-typing gap as a byproduct of the rebuild, not a separate project. |
| SSE polling route (`app/api/intake/[fileId]/route.ts`) | **SIMPLIFY** | Keep SSE as the presentation mechanism (reasonable UX, no reason to change transport) — but it becomes a thin poller over `estimate_runs`/`run_documents`/`run_events`, with zero lock-acquisition or batch-creation responsibility of its own. The single riskiest file the audit flagged shrinks from ~900 lines of orchestration logic to a simple read-and-format loop. |
| Global/per-builder AI spend caps and circuit breaker | **NEW — does not exist today** | The single most important addition this redesign makes. Every other governance mechanism in the current system (per-file retry caps, per-classification occurrence limits) bounds *one bug's* damage after the fact; nothing today bounds aggregate spend across all builders and all bugs at once. |

---

## 9. Migration Plan — Evolve, Don't Rewrite

The goal is a live system that stays functional throughout. No big-bang cutover.

**Phase 0 — Add, don't remove (low risk).**
Create `estimate_runs`, `run_documents`, `run_events` alongside every existing table. Nothing reads from them yet; nothing existing changes behavior.

**Phase 1 — Build the orchestrator and stage handlers in shadow mode.**
Write `advance_runs()` and the four stage handlers as new code. For every real upload, run the *existing* pipeline as today (unchanged, still the source of truth for the builder-facing result) **and**, in parallel, feed the same input through the new orchestrator/handlers, writing only to the new tables. Compare outputs (fact counts, categories, line-item counts, confidence) between old and new for every shadow run. This phase produces zero user-visible change and is purely a correctness-and-confidence-building exercise — don't proceed past it until shadow-run parity is genuinely demonstrated, not assumed.

**Phase 2 — Cut over Extraction only.**
Lowest-risk stage to migrate: it's the one closest to today's `document-worker`, already per-document, already isolated. Point the orchestrator's claim/dispatch loop at real `run_documents` rows for real uploads; `document-worker`'s actual extraction logic is reused almost unchanged, just invoked by the tick instead of self-chaining. Old Understanding/Scope/Estimate continue reading from the legacy tables as before, bridged by a small compatibility write.

**Phase 3 — Cut over Understanding, then Scope, then Estimate, one at a time, behind a per-builder or per-job feature flag.**
Ramp gradually (a handful of builders, then a percentage, then everyone), watching `run_events` for parity with the old pipeline's output quality at each step, not just "did it not crash."

**Phase 4 — Cut the SSE route over to polling the new tables**, once the full pipeline runs on the new orchestrator for 100% of new uploads and has held steady (zero stuck runs, zero unexplained reverts) for a defined bake period — two weeks of real production traffic is a reasonable bar given this system's incident history.

**Phase 5 — Delete the old machinery in one clean pass**, only after Phase 4's bake period: the recovery cron and both kill switches, `job_intake_locks`, `document_processing_batches`/`_jobs`, the migration-052 derived-status functions, the wall-clock-stall columns, the duplicate Deno gates copy, `ai_failure_classification`/`ai_failure_count` on `files`. Regenerate `database.types.ts` properly at the same time.

**Phase 6 — Extend cost governance system-wide.**
Apply the global circuit breaker and per-builder daily cap (§4) to every other Anthropic call site (chat, email-draft, classify-document, etc.), not just the estimating pipeline. This is independent of the pipeline migration and can happen in parallel, at any point — it's a pure addition, not a replacement of anything.

At every phase, the existing system keeps serving real builders unchanged until its replacement has demonstrated parity — the risk at each step is bounded to "the new thing might not work as well yet," never "the old thing stopped working."

---

## 10. Success Check

Would a new engineer understand this in under an hour? Walk it once more, plainly: *a builder uploads files; a row gets created saying "this needs to become a quote"; a tick that runs every 15 seconds looks at that row, figures out what's next, does it, and writes down what happened; if the tick's worker dies partway through, the next tick just picks the same row back up because nothing was ever "handed off" to begin with — it's re-derived fresh every time; every AI call is capped, timed, and logged; a support engineer runs one query and sees the whole story.* That's the whole system. Nothing above requires a diagram to explain over coffee, and nowhere in it does an engineer need to reason about two different tables disagreeing about whether something already happened — because nothing is ever asked twice in two different ways.

*No code was modified in the production of this document.*
