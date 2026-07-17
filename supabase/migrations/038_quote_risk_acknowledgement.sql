-- Risk acceptance audit trail for quote sending — not an override log.
-- A REVIEW_REQUIRED quote can only be sent once the builder has consciously
-- acknowledged the specific risks identified for THIS quote version; a
-- revised quote is a new row (see POST /api/quotes/[quoteId]/revise) and
-- naturally starts with both columns null, so acceptance never silently
-- carries over to a different set of line items.

alter table quotes
  add column risk_acknowledged_at timestamptz null,
  add column risk_acknowledgement_snapshot jsonb null;

comment on column quotes.risk_acknowledged_at is
  'When the builder consciously accepted outstanding REVIEW_REQUIRED risks before sending this exact quote version. Null if never acknowledged, or if the quote was sent while in READY state (nothing to accept).';

comment on column quotes.risk_acknowledgement_snapshot is
  'Risk-acceptance audit record — captures exactly what was known and accepted at the moment of acknowledgement (quote_id, version, overall_confidence, exposure breakdown, top_risks, review_items, affected line items), self-contained enough to reconstruct what was accepted without needing to cross-reference current quote state. Immutable once written; a later re-send (a new revised quote row) gets its own timestamp+snapshot, this one is never overwritten in place.';
