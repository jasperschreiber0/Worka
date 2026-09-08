-- Production security hardening.
--
-- These tables are server-operated. The application uses the service-role
-- client for scheduled recovery, estimating, and Xero routes; browsers must
-- not query or mutate them directly. RLS remains enabled as defence in depth
-- for any non-service-role path.

ALTER TABLE public.intake_recovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_spend_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_knowledge_defaults ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.intake_recovery_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_operations FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_spend_daily FROM anon, authenticated;
REVOKE ALL ON TABLE public.system_status FROM anon, authenticated;
REVOKE ALL ON TABLE public.builder_knowledge_defaults FROM anon, authenticated;

-- Xero data is accessed only by authenticated server routes using the
-- service-role client. Remove the broad default table privileges, including
-- TRUNCATE, from browser roles. RLS policies remain useful for future
-- invoker-based server paths and are intentionally unchanged.
REVOKE ALL ON TABLE public.xero_connections FROM anon, authenticated;
REVOKE ALL ON TABLE public.xero_import_items FROM anon, authenticated;
REVOKE ALL ON TABLE public.xero_sync_runs FROM anon, authenticated;

-- PUBLIC inherits EXECUTE on newly created functions. The scheduled cron job
-- runs as postgres, while the application server can use service_role. Keep
-- registration trigger semantics intact, but make the HTTP recovery trigger
-- unavailable as a browser-callable RPC.
REVOKE EXECUTE ON FUNCTION public.trigger_intake_recovery() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_intake_recovery() TO postgres, service_role;

-- handle_new_user() is a trigger function, not an RPC. Explicitly remove its
-- inherited PUBLIC execute privilege while retaining execution by the trigger
-- mechanism and the owning database role.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres, service_role;

-- Verified internal server callers only; retain SECURITY INVOKER semantics.
REVOKE EXECUTE ON FUNCTION public.record_intake_recovery_attempt(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_intake_recovery_attempt(uuid, integer, text) TO postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.record_ai_spend(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_spend(uuid, numeric) TO postgres, service_role;
