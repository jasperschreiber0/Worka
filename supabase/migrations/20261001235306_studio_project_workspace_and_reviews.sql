-- Additive storage for the connected studio. No existing Worka tables are changed.
create table if not exists public.studio_workspaces (
 id text primary key, owner_id uuid not null references auth.users(id), name text not null,
 version integer not null check(version>0), document jsonb not null, updated_at timestamptz not null default now()
);
create index if not exists studio_workspaces_owner on public.studio_workspaces(owner_id);
alter table public.studio_workspaces enable row level security;
-- Writes go through the validated server API, never directly from a browser.
revoke all on public.studio_workspaces from anon,authenticated;
grant all on public.studio_workspaces to service_role;
create table if not exists public.studio_reviews (
 token_hash text primary key, owner_id uuid not null references auth.users(id),
 project_id text not null references public.studio_workspaces(id), document jsonb not null
);
create index if not exists studio_reviews_owner on public.studio_reviews(owner_id,project_id);
alter table public.studio_reviews enable row level security;
revoke all on public.studio_reviews from anon,authenticated;
grant all on public.studio_reviews to service_role;
create or replace function public.studio_add_feedback(review_hash text,entry jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 update public.studio_reviews set document=jsonb_set(document,'{feedback}',(document->'feedback')||jsonb_build_array(entry))
 where token_hash=review_hash and (document->>'revoked')::boolean=false and (document->>'expiresAt')::timestamptz>now()
 and jsonb_array_length(document->'feedback')<100;
 if not found then raise exception 'Review unavailable or full'; end if;
end; $$;
revoke all on function public.studio_add_feedback(text,jsonb) from public,anon,authenticated;
grant execute on function public.studio_add_feedback(text,jsonb) to service_role;
