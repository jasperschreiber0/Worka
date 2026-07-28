-- 082_notifications.sql
-- Adds a genuinely new entity: `notifications`. One of the two items the
-- AI-native redesign's interaction spec explicitly flagged as needing new
-- backend (the other, suppliers, landed in migration 081).
--
-- Populated from one shared chokepoint (recordProofEvent, lib/proof.ts) —
-- every consequential job action already routes through that function
-- (quote sent, variation submitted/approved/rejected, job activated, etc),
-- so hooking notification creation there means every existing call site
-- gets a notification for free with zero new call sites to remember to add.
-- This mirrors the codebase's existing "single shared implementation, not
-- duplicated per call site" pattern (see gates.ts / selectFactsForPrompt).

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id  uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  job_id      uuid        REFERENCES jobs(id) ON DELETE CASCADE,
  type        text        NOT NULL,
  title       text        NOT NULL,
  body        text,
  entity_type text,
  entity_id   uuid,
  read        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE notifications IS 'Builder-facing notification feed (migration 082). Cached/derived-style: written by createNotification() (lib/notifications.ts), called from recordProofEvent() so every existing proof-event call site produces a notification automatically. Never the source of truth for anything else — proof_events remains the audit trail; this is a read/unread UI feed over the same underlying actions.';
COMMENT ON COLUMN notifications.type IS 'Mirrors the proof event_type that produced it (e.g. variation_submitted, quote_sent, job_activated) plus a few notification-only types not tied to a proof event (e.g. clarifying_question_needed).';
COMMENT ON COLUMN notifications.entity_type IS 'job | variation | invoice | quote — matches the Alert.entity_type convention already used elsewhere in the app (see CLAUDE.md ChatResponse.Alert).';

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_own_builder" ON notifications
  FOR ALL USING (builder_id = auth.uid()) WITH CHECK (builder_id = auth.uid());

CREATE INDEX IF NOT EXISTS notifications_builder_unread_idx ON notifications(builder_id, read, created_at DESC);

NOTIFY pgrst, 'reload schema';
