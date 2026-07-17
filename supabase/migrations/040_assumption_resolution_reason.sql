-- Structured "why" for assumption resolutions — Phase 2B of the learning
-- loop foundations. Complements assumptions.original_value/resolution_note
-- (migration 039) with a controlled-vocabulary reason code, so corrections
-- can eventually be attributed (WorkA error / external change / builder
-- judgement — see lib/estimating/attribution.ts) without free-text parsing.

alter table assumptions
  add column resolution_reason text null;

comment on column assumptions.resolution_reason is
  'Controlled vocabulary, validated in application code (app/api/assumptions/[quoteId]/resolve/route.ts) — never a DB CHECK constraint, so existing rows and older clients are never invalidated:
  - scope_missing
  - document_unclear
  - builder_adjustment
  - market_rate_change
  - client_change
  - ai_extraction_error
  - other
  Optional — never required.';
