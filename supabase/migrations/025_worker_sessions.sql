-- ============================================================
-- Worker portal sessions
--
-- The worker invite/join/portal pipeline was entirely disconnected: the
-- create-worker path wrote a real `workers` row with a real invite_token,
-- but /join/[token] never looked it up (always resolved to a hardcoded
-- demo invite) and /worker unconditionally rendered a hardcoded demo
-- worker to anyone who requested the URL, regardless of who — if
-- anyone — had completed onboarding.
--
-- Workers don't have full Supabase Auth accounts (no email/password), so
-- this adds a lightweight session token issued when a worker completes
-- the join flow: a random token, only its SHA-256 hash stored (same
-- pattern as the variation share tokens in migration 018), verified on
-- every /worker request via a signed cookie.
-- ============================================================

ALTER TABLE workers ADD COLUMN IF NOT EXISTS session_token_hash text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS session_token_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS workers_session_token_hash_idx ON workers (session_token_hash);

COMMENT ON COLUMN workers.session_token_hash IS
  'SHA-256 hex hash of the worker portal session token, issued on join. NULL until the worker has completed onboarding at least once.';
COMMENT ON COLUMN workers.session_token_expires_at IS
  'Worker portal session expiry — /worker requires a valid, unexpired token.';
