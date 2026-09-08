create table public.document_analysis_parts (
 job_id uuid not null references public.jobs(id) on delete cascade,
 file_id uuid not null references public.files(id) on delete cascade,
 source_hash text not null,
 part_index integer not null check (part_index >= 0),
 part_count integer not null check (part_count between 1 and 20),
 payload jsonb not null,
 created_at timestamptz not null default now(),
 primary key(job_id,file_id,source_hash,part_index),
 check (part_index < part_count)
);
alter table public.document_analysis_parts enable row level security;
revoke all on public.document_analysis_parts from public,anon,authenticated;
grant all on public.document_analysis_parts to service_role;
