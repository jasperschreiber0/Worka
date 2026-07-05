-- ─── 019 Clarifying-questions step (Stage 2) ─────────────────────────────────
-- Tracks whether the builder engaged with the essential open questions before
-- pricing. When the step is skipped, every downstream output is visibly labelled
-- "Indicative / Budget-Range Only" (driven by project_scope.is_indicative).

alter table public.project_scope
  add column if not exists clarification_status text not null default 'pending';
  -- pending  — questions surfaced, not yet engaged
  -- skipped  — builder skipped to an indicative estimate (forces is_indicative)
  -- answered — builder worked through the questions
