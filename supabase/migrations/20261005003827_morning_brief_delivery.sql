-- Private delivery state; the scheduler alone reads and writes this outbox.
CREATE TABLE IF NOT EXISTS public.morning_brief_delivery (
  builder_id uuid PRIMARY KEY REFERENCES public.builders(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{"sent":{},"pending":null}'::jsonb,
  lease_token uuid,
  lease_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);
ALTER TABLE public.morning_brief_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.morning_brief_delivery FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.morning_brief_delivery TO service_role;
NOTIFY pgrst, 'reload schema';
