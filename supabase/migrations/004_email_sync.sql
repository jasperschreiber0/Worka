-- Session 13: Email sync state tracking

ALTER TABLE builders ADD COLUMN IF NOT EXISTS email_provider text CHECK (email_provider IN ('gmail', 'outlook'));
ALTER TABLE builders ADD COLUMN IF NOT EXISTS email_connected_at timestamptz;
ALTER TABLE builders ADD COLUMN IF NOT EXISTS email_sync_enabled bool NOT NULL DEFAULT false;

-- Email sync state tracking
CREATE TABLE IF NOT EXISTS email_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE UNIQUE,
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  last_synced_at timestamptz,
  sync_cursor text,  -- Gmail historyId or Outlook deltaLink
  connected_at timestamptz NOT NULL DEFAULT now(),
  is_active bool NOT NULL DEFAULT true
);

ALTER TABLE email_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "email_sync_own" ON email_sync_state FOR ALL USING (builder_id = auth.uid());
