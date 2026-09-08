-- Both tables are accessed through reviewed service-role callers, not browser roles.
-- RLS alone does not protect TRUNCATE.
REVOKE ALL ON public.api_rate_limits, public.job_workers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_rate_limits, public.job_workers TO postgres, service_role;
