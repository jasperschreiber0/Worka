-- 099_invoicing_v1.sql
-- Invoicing v1 — Real Cash Tracking. Closes the last broken link in the
-- economic loop: Estimate -> Contract -> Variations -> Actual Cost -> Margin
-- -> Invoiced -> Paid. `invoices` already had the right schema for this
-- (migration 001) — status lifecycle, due_date, sent_at, paid_at, RLS — but
-- has never had a single production writer; `invoice_schedule` (migration
-- 005) is a billing PLAN (label/percentage/amount/due_trigger) that already
-- has an `invoice_id` FK pointing at `invoices`, but nothing has ever set it.
--
-- No new tables. `invoices` becomes the canonical, authoritative invoice
-- entity; `invoice_schedule` stays exactly what it already was — a plan a
-- real invoice can optionally be created from, connected via the FK that
-- already existed.

-- 1. `invoices` needs a human-readable label ("Deposit", "Frame stage", or a
--    freeform description for a manual invoice) and a per-job reference
--    number for display — neither existed. Both nullable: existing rows
--    (migration 002's seed data) are untouched.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS invoice_number text;

COMMENT ON COLUMN invoices.description IS
  'Stage/description shown to the builder, e.g. "Deposit" (copied from an invoice_schedule row) or a freeform manual description. Not client-facing copy — no template/PDF generation reads this.';
COMMENT ON COLUMN invoices.invoice_number IS
  'Per-job, app-generated reference (e.g. "INV-1", "INV-2") — not a global sequence. Deterministic, small mechanism only: computed from the count of existing invoices for the job at creation time, deliberately not a database sequence/settings system.';

-- 2. Durable, DB-enforced guard against two invoices somehow claiming the
--    same reference number within one job (the app already prevents this by
--    construction — see lib/invoices.ts's generateInvoiceNumber — this is
--    the backstop, same pattern as quote_line_items_variation_id_unique in
--    migration 098). Partial: most historical seed rows have no
--    invoice_number and must stay free to all be NULL.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_job_id_invoice_number_unique
  ON invoices (job_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- No other schema change. `invoices.status` already supports
-- draft/sent/overdue/paid (migration 001) — v1 only ever writes
-- draft/sent/paid; 'overdue' stays a legal-but-unused value, derived at read
-- time from `status = 'sent' AND due_date < today` rather than stored, so it
-- can never go stale between a cron tick and a builder looking at the page.
-- `invoice_schedule.invoice_id` (migration 005) is the existing plan ->
-- invoice link; v1 sets it exactly once per schedule row, atomically, the
-- same "only the first caller wins" pattern already used for variation
-- approval (migration 098) and job locks (migration 030).
