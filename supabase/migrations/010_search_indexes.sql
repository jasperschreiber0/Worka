-- Enable trigram extension for efficient ILIKE searches
create extension if not exists pg_trgm;

-- GIN indexes for case-insensitive substring search on jobs.address and clients.name
-- These prevent full table scans when using ilike('%term%') in handleJobQuery and worker_onboarding
create index if not exists idx_jobs_address_trgm on jobs using gin (address gin_trgm_ops);
create index if not exists idx_clients_name_trgm on clients using gin (name gin_trgm_ops);
create index if not exists idx_workers_name_trgm on workers using gin (name gin_trgm_ops);
