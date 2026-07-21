# Phase 2 Document Similarity — Human Review Process

Companion to `PHASE_2_DOCUMENT_MATCHING_READINESS.md`. That note explains what signals
exist and what's unknown; this one explains what to actually DO with the exported dataset
once real production pairs start coming out of `GET /api/admin/document-similarity-report`.

Nothing described here runs automatically. There is no labelling UI, no write-back
endpoint, no scheduled job. The report is a CSV/JSON export; a person opens it and fills
in a few columns by hand.

## What the tool gives you

For every candidate pair of documents within one job, the report returns:

- **`signals`** — the raw measurements: `filename_similarity`, `text_overlap`,
  `page_count_difference`, `size_similarity`, `title_match`. Any of these can be `null`
  when the underlying data isn't available (e.g. a vision-only document has no extracted
  text) — `null` always means "unknown," never "confirmed different."
- **`explanations`** — the same signals translated into plain English (e.g. "Same
  normalized filename", "85% extracted text overlap", "Different revision markers
  detected"). Deterministic, generated from the signals with no LLM call — every line is
  traceable back to a specific signal value.
- **`likely_category`** — a coarse starting bucket (`exact_duplicate`,
  `likely_same_document_different_export`, `likely_revision`, `possibly_related`,
  `unrelated`). A hint for where to look first, not a verdict.
- **`revision_markers_detected` / `revision_values`** — possible Rev/Issue/Version/date
  markers found in either filename (e.g. `["A", "B"]` from `plan-RevA.pdf` and
  `plan-RevB.pdf`). Deliberately unordered — the tool never claims to know which one is
  newer. `document_a_revision_markers` / `document_b_revision_markers` show which document
  each value came from.
- **`human_label`, `reviewed_by`, `reviewed_at`, `notes`** — always `null` in the export.
  These are the columns you fill in.

## How to review a pair

Open the CSV in a spreadsheet (or the JSON in whatever you're comfortable with), sorted
highest-`similarity_score`-first by default. For each pair, read `explanations` and
`likely_category`, glance at the raw `signals` if you want more detail, then answer one
question and record it in `human_label`:

| Answer | Meaning | Use when |
|---|---|---|
| **Same document** | Byte-different, but genuinely the same file (re-export, re-scan, re-save) — no meaningful content change | High text overlap, same page count, same/no revision marker, `likely_same_document_different_export` category |
| **Revision** | A real, later version of the same drawing — content has actually changed | Revision markers differ, same title, moderate-to-high text overlap, `likely_revision` category |
| **Addendum** | Related to the same drawing/topic but adds new information rather than replacing it (a supplementary sheet, a clarification note) — not a straightforward "same" or "later version" | Same title or strong text overlap, but the content reads as additive rather than a replacement |
| **Independent document** | Coincidental similarity only — different real-world documents that happen to share a filename, size, or a few phrases | `possibly_related` or `unrelated` category, or a closer look shows the content is actually unconnected |
| **Unsure** | You genuinely can't tell from the available signals/explanations | Anything ambiguous — better to mark this honestly than guess |

Fill in:
- `human_label` — one of the five answers above (free text is fine; keep it consistent so the results are aggregable, e.g. always exactly `same_document` / `revision` / `addendum` / `independent_document` / `unsure`).
- `reviewed_by` — your name or identifier.
- `reviewed_at` — the date you reviewed it.
- `notes` — anything that doesn't fit the label (e.g. "text overlap looks high but that's boilerplate spec language every document in this job shares" — exactly the kind of pattern the next section needs to know about).

`exact_duplicate` pairs (same `content_hash`) don't need review — Phase 1 already handles
them deterministically before extraction ever runs. They only appear in the export as a
calibration reference (a same-file pair should always look "obviously the same" to a human
too — if one doesn't, that's worth a note).

## What this dataset is for

The whole point of reviewing pairs by hand is to answer a question code can't answer on
its own: **how should Gate 3 decide "same real-world document" for documents that are NOT
byte-identical?** Once enough pairs are labelled, look at what actually correlates with
each answer:

- If **"Same document"** and **"Revision"** cleanly separate along a small number of
  signals (e.g. text overlap above some threshold + same page count almost always means
  "Same document," differing revision markers almost always means "Revision," and there's
  little overlap between the two) — Gate 3 can likely be **deterministic rules** over the
  existing signals, no new infrastructure needed.
- If the labels correlate with signals but not cleanly — lots of pairs near a threshold go
  either way — Gate 3 probably needs **similarity scoring** (a calibrated version of
  `similarity_score`, or a proper model) rather than a hard cutoff, accepting some
  uncertainty as a first-class part of the design.
- If reviewers frequently land on **"Addendum"** or **"Unsure"**, or disagree with each
  other on the same pair, that's evidence no automated signal (rules or scoring) can
  reliably resolve this class of pair — Gate 3 needs a **human confirmation** step for at
  least that subset, not full automation.

In practice the answer is likely to be a mix — deterministic rules for the clear cases,
scoring for the ambiguous middle, and a confirmation step reserved for whatever remains
unresolved. The labelled data is what tells you where those boundaries actually fall,
instead of guessing — which is the entire reason this measurement phase exists before any
Gate 3 code gets written (see the Gate 6 mistake documented in
`PHASE_2_DOCUMENT_MATCHING_READINESS.md` for what happens when that ordering is skipped).

## What this process explicitly does not do

- It does not change any estimate, quote, or fact base. Nothing reads `human_label`
  anywhere in the product.
- It does not feed back into `duplicate_of_file_id`, `project_documents`, or any part of
  Phase 1's detection. Reviewing a pair here has zero effect on what any builder sees.
- It is not a queue, a workflow tool, or a ticketing system — just an export and a set of
  columns to fill in by hand, then look at in aggregate once there's enough data.
