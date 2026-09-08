CREATE TABLE public.xero_oauth_transactions (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  builder_id uuid NOT NULL REFERENCES public.builders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
ALTER TABLE public.xero_oauth_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_oauth_transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.xero_oauth_transactions TO service_role;
CREATE INDEX xero_oauth_transactions_expiry_idx ON public.xero_oauth_transactions(expires_at);

-- DELETE locks the matched row: exactly one caller can return true.
CREATE FUNCTION public.consume_xero_oauth_state(p_state_hash text, p_builder_id uuid)
RETURNS boolean LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  WITH consumed AS (
    DELETE FROM public.xero_oauth_transactions
    WHERE state_hash = p_state_hash AND builder_id = p_builder_id
      AND expires_at > clock_timestamp()
    RETURNING state_hash
  ) SELECT EXISTS (SELECT 1 FROM consumed);
$$;
REVOKE EXECUTE ON FUNCTION public.consume_xero_oauth_state(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_xero_oauth_state(text, uuid) TO service_role, postgres;
