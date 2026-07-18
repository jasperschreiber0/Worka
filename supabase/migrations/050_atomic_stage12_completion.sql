-- 050_atomic_stage12_completion.sql
-- Architectural fix, not a timeout fix. Root-caused across two review passes
-- this session: retries were rebuilding Stage 1/2 execution state from
-- scratch instead of resuming durable state, because no single durable
-- signal existed for "has this document already been classified." Three
-- overlapping, none-authoritative signals existed instead:
--   - files.intake_status — file-scoped, but only ever reaches 'extracted'
--     for the single PRIMARY file of a fully-successful end-to-end run
--     (see app/api/intake/[fileId]/route.ts's .eq('id', fileId) write) —
--     never for siblings, never on a partial success.
--   - document_processing_jobs.status — scoped to parent_job_id, and every
--     retry mints a brand-new document_processing_batches row
--     (createDocumentProcessingBatch has no history check), so this
--     signal's own history is discarded every retry.
--   - project_documents / project_facts — the only genuinely durable,
--     cross-retry-visible state, but written as three sequential,
--     non-atomic steps (project_documents upsert -> an external Voyage AI
--     HTTP call for embeddings -> project_facts insert). An external kill
--     landing between steps 1 and 3 — precisely the failure mode this
--     session spent hours chasing — leaves project_documents claiming
--     "classified" while project_facts for that file is empty or partial.
--     Worse: even without a kill, this table was never READ as a resume
--     signal anywhere — existingDocs (index.ts) is loaded but used only to
--     build prompt context, never to skip already-done work.
--
-- Fix: one durable per-file signal (project_documents.extraction_status),
-- only ever set to 'complete' inside one atomic function that also writes
-- the corresponding project_facts rows — so the completion marker cannot
-- exist unless the facts it claims to represent are actually committed.
-- This closes a real, pre-existing project_facts correctness bug too, not
-- just a performance one: mergeFacts (pipeline-logic.ts) supersedes a fact
-- whose category+key matches but whose value differs even trivially
-- (non-deterministic LLM rewording of an unchanged document), so blind
-- reclassification was already capable of spuriously superseding a
-- perfectly good fact — independent of the wasted Anthropic spend.

-- ─── Durable per-file completion state ─────────────────────────────────────
-- 'pending' (default): never successfully classified, or explicitly
--   invalidated for a deliberate re-read. Eligible for (re)processing.
-- 'complete': classification succeeded AND its facts are committed — set
--   ONLY inside persist_document_classification below, atomically with the
--   facts themselves. The one signal every retry/batch-planning decision
--   should consult.
-- 'invalidated': the escape hatch (never delete the row — same
--   never-delete-only-supersede philosophy as project_facts.superseded,
--   preserving audit history) — a future builder-requested re-read, or a
--   prompt/schema version bump, flips a file back here via
--   invalidate_document_classification. Treated identically to 'pending'
--   for eligibility purposes (anything != 'complete' needs processing).
ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'complete', 'invalidated'));

-- Evidence-based backfill, not a blanket flag flip: a pre-existing
-- project_documents row is only trusted as 'complete' if it actually has
-- at least one matching project_facts row. This self-heals any row that
-- was already left in the "false complete" state this migration exists to
-- prevent going forward, rather than grandfathering it in as trusted.
UPDATE project_documents
SET extraction_status = 'complete'
WHERE EXISTS (
  SELECT 1 FROM project_facts WHERE project_facts.source_document_id = project_documents.id
);

COMMENT ON COLUMN project_documents.extraction_status IS
  'Durable Stage 1/2 completion signal, one per file. Only ever set to ''complete'' inside persist_document_classification, atomically with the project_facts rows it depends on — see migration 050''s header for the non-atomic-write bug this closes. Batch planning (app/api/intake/[fileId]/route.ts and smooth-responder/index.ts) must check this before creating new document_processing_jobs or re-attempting Stage 1/2 for a file.';

-- ─── persist_document_classification ───────────────────────────────────────
-- Replaces three sequential JS-side writes (project_documents upsert ->
-- project_facts insert, with an external Voyage embeddings call in
-- between) with one atomic function call. Postgres commits a plpgsql
-- function's effects as a single transaction on success, or rolls back
-- entirely on any unhandled exception — so from the caller's perspective,
-- either the whole classification (document metadata + all its facts)
-- lands, or none of it does. This is what makes checking
-- extraction_status = 'complete' actually safe as a resume signal:
-- previously an external kill mid-write could leave a project_documents
-- row with no corresponding facts; now that combination is structurally
-- unreachable, because both are written by the same atomic operation.
--
-- Embeddings are computed in JS before calling this (Voyage is an external
-- HTTP call, not something SQL can do) and passed in already-attached to
-- each fact in p_facts — this function only persists what's already been
-- decided (mergeFacts' supersession/dedup logic also stays in JS, since it
-- needs the in-memory facts array; only the DB writes move here).
--
-- p_documents: jsonb array of {file_id, document_type, discipline,
--   revision, issue_date, scale, page_count, drawing_title, readability,
--   ocr_quality, trade_relevance, is_duplicate, is_superseded, notes} —
--   same fields index.ts's documentInserts already builds.
-- p_facts: jsonb array of {source_file_id (nullable — resolved against the
--   documents upserted in this same call), category, key, value,
--   page_reference, evidence, confidence, embedding (nullable jsonb array
--   of floats, cast to vector(512))}.
-- p_superseded_ids: project_facts.id[] to mark superseded, exactly as
--   JS's mergeFacts already computes today.
--
-- Returns {documents: [{file_id, project_document_id}], fact_ids: [uuid,...]}
-- (fact_ids ordered to match p_facts input order, so JS can zip them back
-- onto its own factsToInsert array exactly like the old insertedIds[i]
-- pattern it replaces).
CREATE OR REPLACE FUNCTION persist_document_classification(
  p_job_id uuid,
  p_documents jsonb,
  p_facts jsonb,
  p_superseded_ids uuid[] DEFAULT '{}'
)
RETURNS jsonb AS $$
DECLARE
  v_doc jsonb;
  v_fact jsonb;
  v_project_document_id uuid;
  v_documents_out jsonb := '[]'::jsonb;
  v_fact_ids_out jsonb := '[]'::jsonb;
  v_fact_id uuid;
BEGIN
  CREATE TEMP TABLE _doc_id_map (file_id uuid PRIMARY KEY, project_document_id uuid) ON COMMIT DROP;

  FOR v_doc IN SELECT * FROM jsonb_array_elements(p_documents)
  LOOP
    INSERT INTO project_documents (
      job_id, file_id, document_type, discipline, revision, issue_date, scale,
      page_count, drawing_title, readability, ocr_quality, trade_relevance,
      is_duplicate, is_superseded, notes, extraction_status
    )
    VALUES (
      p_job_id,
      (v_doc->>'file_id')::uuid,
      v_doc->>'document_type', v_doc->>'discipline', v_doc->>'revision',
      NULLIF(v_doc->>'issue_date', '')::date, v_doc->>'scale',
      NULLIF(v_doc->>'page_count', '')::int, v_doc->>'drawing_title',
      v_doc->>'readability', v_doc->>'ocr_quality',
      COALESCE((SELECT array_agg(x::int) FROM jsonb_array_elements_text(COALESCE(v_doc->'trade_relevance', '[]'::jsonb)) x), '{}'),
      COALESCE((v_doc->>'is_duplicate')::boolean, false),
      COALESCE((v_doc->>'is_superseded')::boolean, false),
      v_doc->>'notes',
      'complete'
    )
    ON CONFLICT (file_id) DO UPDATE SET
      job_id = EXCLUDED.job_id, document_type = EXCLUDED.document_type, discipline = EXCLUDED.discipline,
      revision = EXCLUDED.revision, issue_date = EXCLUDED.issue_date, scale = EXCLUDED.scale,
      page_count = EXCLUDED.page_count, drawing_title = EXCLUDED.drawing_title,
      readability = EXCLUDED.readability, ocr_quality = EXCLUDED.ocr_quality,
      trade_relevance = EXCLUDED.trade_relevance, is_duplicate = EXCLUDED.is_duplicate,
      is_superseded = EXCLUDED.is_superseded, notes = EXCLUDED.notes,
      extraction_status = 'complete'
    RETURNING id INTO v_project_document_id;

    INSERT INTO _doc_id_map (file_id, project_document_id)
    VALUES ((v_doc->>'file_id')::uuid, v_project_document_id)
    ON CONFLICT (file_id) DO UPDATE SET project_document_id = EXCLUDED.project_document_id;

    v_documents_out := v_documents_out || jsonb_build_object('file_id', v_doc->>'file_id', 'project_document_id', v_project_document_id);
  END LOOP;

  IF p_superseded_ids IS NOT NULL AND array_length(p_superseded_ids, 1) > 0 THEN
    UPDATE project_facts SET superseded = true WHERE id = ANY(p_superseded_ids);
  END IF;

  FOR v_fact IN SELECT * FROM jsonb_array_elements(p_facts)
  LOOP
    INSERT INTO project_facts (
      job_id, category, key, value, source_document_id, page_reference, evidence, confidence, embedding
    )
    VALUES (
      p_job_id,
      v_fact->>'category', v_fact->>'key', v_fact->>'value',
      (SELECT project_document_id FROM _doc_id_map WHERE file_id = NULLIF(v_fact->>'source_file_id', '')::uuid),
      v_fact->>'page_reference', v_fact->>'evidence',
      COALESCE((v_fact->>'confidence')::numeric, 70),
      CASE WHEN jsonb_typeof(v_fact->'embedding') = 'array' THEN (v_fact->'embedding')::text::vector ELSE NULL END
    )
    RETURNING id INTO v_fact_id;

    v_fact_ids_out := v_fact_ids_out || to_jsonb(v_fact_id);
  END LOOP;

  RETURN jsonb_build_object('documents', v_documents_out, 'fact_ids', v_fact_ids_out);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION persist_document_classification IS
  'Atomically persists Stage 1/2 output — project_documents (extraction_status=complete) and project_facts together, replacing three sequential non-atomic JS writes. Either the whole classification for this batch lands, or none of it does — see migration 050 header for the false-completion bug this closes.';

-- ─── invalidate_document_classification ────────────────────────────────────
-- The escape hatch (goal 3 of this migration): flips a file's durable
-- completion state back so the next retry/upload processes it again,
-- WITHOUT deleting project_documents or its existing project_facts (same
-- never-delete, only-supersede philosophy already used throughout this
-- pipeline). Not wired to any UI yet — no product flow currently calls
-- this — but exists as the structural primitive for a future
-- builder-requested "re-read this document" action, or a deliberate
-- reclassification after a prompt/schema version change.
CREATE OR REPLACE FUNCTION invalidate_document_classification(p_file_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE project_documents SET extraction_status = 'invalidated' WHERE file_id = p_file_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION invalidate_document_classification IS
  'Escape hatch: resets a file''s durable Stage 1/2 completion state without deleting its project_documents/project_facts history, so a future retry reprocesses it. Not yet called from any UI flow — see migration 050 header.';
