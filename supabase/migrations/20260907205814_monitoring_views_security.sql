-- Operational monitoring views are server-only. Keep their definitions intact.
ALTER VIEW public.stuck_document_jobs SET (security_invoker = true);
ALTER VIEW public.failed_document_jobs_recent SET (security_invoker = true);
ALTER VIEW public.stuck_job_intake_locks SET (security_invoker = true);
REVOKE ALL ON public.stuck_document_jobs, public.failed_document_jobs_recent, public.stuck_job_intake_locks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stuck_document_jobs, public.failed_document_jobs_recent, public.stuck_job_intake_locks TO postgres, service_role;
