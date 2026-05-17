-- ─── Session 14: Job Activation Tables ──────────────────────────────────────

-- Job timeline milestones
CREATE TABLE IF NOT EXISTS job_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  due_date date,
  completed_at timestamptz,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Invoice schedule (progress claims)
CREATE TABLE IF NOT EXISTS invoice_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  label text NOT NULL,           -- "Deposit", "Frame stage", "Lock-up", "Completion"
  percentage int NOT NULL,       -- % of total contract value
  amount numeric(12,2) NOT NULL,
  due_trigger text NOT NULL,     -- "On contract signing", "Frame inspection passed", etc.
  invoice_id uuid REFERENCES invoices(id),  -- linked when invoice is created
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Proof feed (audit trail — every status change, approval, communication)
CREATE TABLE IF NOT EXISTS proof_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  event_type text NOT NULL,  -- 'job_activated', 'variation_approved', 'invoice_sent', 'email_received', etc.
  description text NOT NULL,
  metadata jsonb,            -- any extra structured data
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE job_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "milestones_own" ON job_milestones FOR ALL USING (builder_id = auth.uid());
CREATE POLICY "invoice_schedule_own" ON invoice_schedule FOR ALL USING (builder_id = auth.uid());
CREATE POLICY "proof_events_own" ON proof_events FOR ALL USING (builder_id = auth.uid());

CREATE INDEX ON job_milestones(job_id, sort_order);
CREATE INDEX ON invoice_schedule(job_id);
CREATE INDEX ON proof_events(job_id, created_at DESC);
