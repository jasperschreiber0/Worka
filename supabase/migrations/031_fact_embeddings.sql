-- ============================================================
-- WorkA — P2 from the multi-document reasoning audit: a lightweight
-- embedding layer over project_facts, scoped to what "dozens of PDFs"
-- actually needs.
--
-- This is deliberately NOT a chunking/RAG pipeline over raw PDFs — vision
-- reads stay the extraction method (see CLAUDE.md's "Reasoning-First
-- Estimating Engine" section for why: plans and BOQs are dense in visual
-- information a text-chunk pipeline would flatten). What genuinely doesn't
-- scale as documents accumulate is the *fact list* itself: the same real
-- fact (floor area, room count, address) gets re-extracted with slightly
-- different phrasing/keys from every document that happens to restate it,
-- and every one of those was concatenated whole into every Stage 3/6
-- prompt. Embeddings let smooth-responder catch a near-duplicate fact at
-- write time (semantic match, not just the exact category+key match added
-- in migration 030) instead of letting the fact list — and the prompt built
-- from it — grow unbounded.
--
-- pgvector is already enabled (project_memory has used it since migration
-- 011) — no extension change needed here.
-- ============================================================

-- voyage-3-lite produces 512-dimension embeddings.
ALTER TABLE project_facts
  ADD COLUMN IF NOT EXISTS embedding vector(512);

COMMENT ON COLUMN project_facts.embedding IS
  'voyage-3-lite embedding of "[category] key: value", used only for at-write-time near-duplicate detection across documents in the same job (see smooth-responder). Best-effort — null when VOYAGE_API_KEY is unset or the embeddings call failed; those rows just fall back to the exact category+key supersession check from migration 030. No ANN index: per-job fact counts stay small enough (low hundreds even at "dozens of PDFs") that a job_id-scoped sequential scan is fine without one.';
