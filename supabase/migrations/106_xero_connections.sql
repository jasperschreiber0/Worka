-- One Xero connection per builder and organisation. Tokens are intentionally
-- kept out of the client and should be encrypted at rest before production use.
CREATE TABLE IF NOT EXISTS xero_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  organisation_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'needs_reauth')),
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  UNIQUE (builder_id, tenant_id)
);
ALTER TABLE xero_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "xero_connections_own_builder" ON xero_connections FOR ALL USING (builder_id = auth.uid());

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS xero_invoice_id text;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_xero_invoice_id_unique ON invoices (xero_invoice_id) WHERE xero_invoice_id IS NOT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS xero_contact_id text;
CREATE UNIQUE INDEX IF NOT EXISTS clients_xero_contact_id_unique ON clients (xero_contact_id) WHERE xero_contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS xero_import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES xero_connections(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('invoice', 'bill', 'contact')),
  description text NOT NULL,
  amount numeric(12,2),
  amount_paid numeric(12,2),
  external_status text,
  item_date date,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  trade_category_id int REFERENCES trade_categories(id),
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'mapped', 'ignored', 'imported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);
ALTER TABLE xero_import_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "xero_import_items_own_builder" ON xero_import_items FOR ALL USING (builder_id = auth.uid());

CREATE TABLE IF NOT EXISTS xero_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES xero_connections(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')), imported_count int NOT NULL DEFAULT 0, failed_count int NOT NULL DEFAULT 0,
  error_message text, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
ALTER TABLE xero_sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "xero_sync_runs_own_builder" ON xero_sync_runs FOR ALL USING (builder_id = auth.uid());
