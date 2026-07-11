-- ============================================================
-- Variation client-approval share tokens
--
-- The public /approve/variation/[variationId] page previously trusted the
-- raw variation UUID as if it were a secret share link — anyone who saw or
-- guessed the UUID could approve/reject/flip any builder's variation with
-- no verification at all. This adds a hashed, expiring, single-variation
-- share token that the share/route.ts endpoint issues and the public
-- GET/PATCH endpoints verify before allowing any client-facing action.
--
-- Only the SHA-256 hash is stored — the raw token lives solely in the
-- share link URL, the same pattern used for password-reset/API-key tokens.
-- ============================================================

ALTER TABLE variations ADD COLUMN IF NOT EXISTS share_token_hash text;
ALTER TABLE variations ADD COLUMN IF NOT EXISTS share_token_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS variations_share_token_hash_idx ON variations (share_token_hash);

COMMENT ON COLUMN variations.share_token_hash IS
  'SHA-256 hex hash of the client-facing approval token. NULL until a share link has been generated. Verified (not the builder session) is what authorises the public PATCH.';
COMMENT ON COLUMN variations.share_token_expires_at IS
  'Share link expiry. Public GET/PATCH reject a token past this timestamp.';
