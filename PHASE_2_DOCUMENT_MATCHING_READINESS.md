# Phase 2 Document Matching — Readiness Note

Status: **not started, deliberately.** This note exists to define what Phase 2 (reliable
cross-session matching for documents that are the *same real-world drawing* but not
byte-identical — a re-export, a re-scan, a metadata-only re-save) needs before it's built, and to
record why it isn't built yet.

Phase 1 (migrations 062–063) ships deterministic, byte-identical duplicate detection: SHA-256 of
raw file bytes, scoped per job, checked before extraction. It catches exact re-uploads — the
`16 Alfred Street` test-fixture case (`CLAUDE.md`, "What a real project's document set actually
contains") — but nothing else. Two PDFs that differ by even one byte (re-exported from a different
tool, a re-scan at a different DPI, a single-page annotation added) hash differently and are
treated as entirely unrelated documents today. Closing that gap is Phase 2's job.

## Why this isn't being built yet

Earlier in this effort, "Gate 6" (Stage 3 filtering on Claude's per-batch
`is_duplicate`/`is_superseded` flags) was nearly shipped as part of a fast MVP, on the assumption
that near-duplicate detection was cheap to bolt on. That assumption was wrong on inspection: those
flags are only reliable *within a single upload batch* — Claude never sees a document from a prior
session, so the flags never fire cross-session, which is exactly the case that matters. Building
Phase 2 on assumption instead of evidence would very likely repeat that mistake in a new shape
(some other heuristic — filename similarity, page-count matching, whatever seems obviously right —
that turns out not to hold against what documents actually get re-uploaded in production).

The corrective: measure first. `document_duplicate_detection_summary()`
(`supabase/verification/health_monitoring_views.sql`, migration 063) is now live and queryable —
it just has no real production traffic behind it yet, since Phase 1 hasn't been running in
production. This note exists to state, precisely, what to look at once it does.

## Current available signals

Everything below already exists in the schema — Phase 2 needs to *decide how to combine them*, not
invent new extraction:

| Signal | Where | Notes |
|---|---|---|
| `content_hash` | `files` (migration 062) | Exact-byte match only — Phase 1's whole mechanism. Zero signal for near-duplicates by design. |
| `file_size_bytes` | `files` (migration 063) | Coarse pre-filter — two files differing by more than a few KB are unlikely to be the same drawing re-exported. |
| `filename` | `files` | Weak signal alone (`drawing.pdf` uploaded twice with different content is explicitly NOT a duplicate — see Phase 1's own test suite), but a strong *corroborating* signal alongside others (e.g. `plan-v2.pdf` vs `plan-v3.pdf`). |
| `document_type`, `discipline`, `drawing_title`, `revision`, `issue_date`, `scale`, `page_count` | `project_documents` (migration 026) | Claude-extracted metadata, per document, per upload batch. Revision + drawing_title together are the strongest existing signal for "same drawing, later version" — but only populated for documents that reached Stage 1/2 classification, so a document skipped as an exact duplicate (Phase 1) never gets these fields filled in for the *duplicate* row, only the original's. |
| `is_duplicate` / `duplicate_of_file_index`, `is_superseded` / `superseded_by_file_index` | `project_documents` (migration 026, Claude Stage 1 output) | Real signal, but batch-scoped only — see the Gate 6 mistake above. Could become a candidate *feature* for Phase 2's matching decision, but must never be the sole or primary signal for a cross-session decision. |
| `project_facts.evidence` / extracted text | `project_facts`, and `document_processing_jobs.result.text` for text-dense documents | Full text is available for text-dense docs; vision-only docs have no persisted text to diff against. Asymmetric coverage — any matching approach using text similarity needs to handle "no text available" as a real, common case, not an edge case. |
| `embedding` (Voyage, `vector(512)`) | `project_facts.embedding` (migration 031) | Exists at the *fact* level, not the *document* level, and only when `VOYAGE_API_KEY` is configured (optional, best-effort). Would need a document-level embedding (e.g. of extracted text, or a summary) to be useful for document matching directly — not currently computed. |
| `created_at`, `upload_batch_id` | `files` | Establishes ordering/session boundaries — necessary for "which one is the original" once a match is found (mirrors `decideDuplicateFile`'s existing earliest-wins tie-break). |

## Unknowns requiring production measurement

These cannot be answered from the codebase or from this session — they need real usage data
through `document_duplicate_detection_summary()` and, once built, a near-duplicate-specific
telemetry pass:

- **Duplicate rate.** What fraction of uploads are exact duplicates in practice (not just the
  known test-fixture case)? This sets the ceiling on how much Phase 1 alone is already worth, and
  whether Phase 2's added complexity is justified by the remaining gap.
- **Common non-identical duplicate shapes.** Are near-duplicates mostly re-exports (byte-different,
  content-identical), mostly genuine revisions (content meaningfully different, same drawing
  identity), or mostly unrelated documents that happen to share superficial similarity (same
  filename convention, same page count)? Each shape wants a different matching strategy, and
  guessing which dominates is exactly the mistake Gate 6 already made once.
- **False positive risk.** What does it cost, concretely, when two *different* documents get
  merged as "the same drawing"? Given `mergeFacts` supersedes on any value mismatch (see migration
  050's own header), a false-positive match could spuriously supersede a correct fact with an
  unrelated document's differently-worded content — this needs to be measured/bounded before any
  matching heuristic ships, not discovered after.
- **Document families with highest ambiguity.** Which document types are most likely to produce
  ambiguous matches — e.g. window/door schedules across revisions, FF&E schedules re-exported per
  meeting, generic boilerplate specification pages reused across a builder's own project template?
  Real upload history is the only way to find this; it cannot be enumerated from first principles.

## What Phase 2 should NOT do until the above is known

- Ship a similarity heuristic (filename, page count, or otherwise) calibrated against zero real
  duplicate examples.
- Reuse `project_documents.is_duplicate`/`is_superseded` as a cross-session signal without first
  confirming (via the measurements above) that batch-scoped Claude output correlates with true
  cross-session duplication often enough to be worth the false-positive risk.
- Touch Stage 3 filtering, fact merging, or estimation behaviour — Phase 1's constraints
  (`is_duplicate`/`is_superseded` untouched, no LLM judgement, no Stage 3 changes) still apply until
  Phase 2 has evidence, a design, and its own explicit sign-off.

## The purpose of this note

To prevent building heuristic document matching before understanding the data — the same
discipline Phase 1 was corrected onto after the Gate 6 review. When `document_duplicate_detection_summary()` has real production weeks behind it, revisit this note with actual numbers in the "unknowns" table above, and only then design Phase 2.
