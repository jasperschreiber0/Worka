-- ============================================================
-- Quote client-approval share tokens
--
-- Mirrors migration 018 (variations.share_token_hash/share_token_expires_at)
-- exactly, for the same reason: the public /approve/quote/[quoteId] page
-- must never trust the raw quote UUID as if it were a secret. Only the
-- SHA-256 hash of the client-facing token is stored — the raw token lives
-- solely in the share link URL.
--
-- approved_by mirrors variations.approved_by (present in the original
-- schema for variations, migration 001) — quotes never had an equivalent
-- column since quotes.status only ever reached 'approved' via the
-- builder-side job-activation route until now.
-- ============================================================

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS share_token_hash text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS share_token_expires_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS approved_by text;

CREATE INDEX IF NOT EXISTS quotes_share_token_hash_idx ON quotes (share_token_hash);

COMMENT ON COLUMN quotes.share_token_hash IS
  'SHA-256 hex hash of the client-facing quote-approval token. NULL until a share link has been generated. Verified (not a builder session) is what authorises the public GET/PATCH on /api/quotes/[quoteId]/approve.';
COMMENT ON COLUMN quotes.share_token_expires_at IS
  'Share link expiry. The public approve route rejects a token past this timestamp.';
COMMENT ON COLUMN quotes.approved_by IS
  'Client-supplied name recorded when a quote is approved via the public share-token flow. NULL for quotes approved only through job activation (the pre-existing builder-side path).';

NOTIFY pgrst, 'reload schema';
