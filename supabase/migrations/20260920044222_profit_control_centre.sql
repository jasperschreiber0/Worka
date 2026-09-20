-- Additive control centre. Existing estimate execution and the 13 trades are unchanged.
create unique index jobs_id_builder_control_key on public.jobs(id,builder_id);
create unique index workers_id_builder_control_key on public.workers(id,builder_id);
create table public.job_control_plans (
  job_id uuid primary key,
  builder_id uuid not null references public.builders(id) on delete cascade,
  confirmed_revision bigint check(confirmed_revision >= 0),
  confirmed_at timestamptz,
  cash_received numeric(12,2) check(cash_received between 0 and 999999999),
  cash_paid numeric(12,2) check(cash_paid between 0 and 999999999),
  cash_as_of date,
  start_on date, finish_on date, lead_worker_id uuid,
  updated_at timestamptz not null default now(),
  foreign key(job_id,builder_id) references public.jobs(id,builder_id) on delete cascade,
  foreign key(lead_worker_id,builder_id) references public.workers(id,builder_id),
  check((start_on is null and finish_on is null) or (start_on is not null and finish_on is not null and finish_on>=start_on)),
  check((cash_received is null and cash_paid is null and cash_as_of is null) or (cash_received is not null and cash_paid is not null and cash_as_of is not null))
);
create index job_control_plans_builder_idx on public.job_control_plans(builder_id);
create index job_control_plans_worker_idx on public.job_control_plans(lead_worker_id,builder_id);
create table public.worker_compliance_records (
 id uuid primary key default gen_random_uuid(), builder_id uuid not null references public.builders(id) on delete cascade,
 worker_id uuid not null, kind text not null check(kind in ('licence','insurance','SWMS','classification review')),
 evidence text not null check(length(trim(evidence)) between 1 and 2000), expires_on date,
 reviewed_at timestamptz not null default now(),
 foreign key(worker_id,builder_id) references public.workers(id,builder_id) on delete cascade,
 unique(worker_id,kind)
);
create index worker_compliance_builder_idx on public.worker_compliance_records(builder_id);
create table public.worker_compliance_events (
 id uuid primary key default gen_random_uuid(), builder_id uuid not null references public.builders(id) on delete cascade,
 worker_id uuid not null, kind text not null, evidence jsonb not null, created_at timestamptz not null default now(),
 foreign key(worker_id,builder_id) references public.workers(id,builder_id) on delete cascade
);
create index worker_compliance_events_builder_idx on public.worker_compliance_events(builder_id,worker_id);
do $$ declare t text; begin
 foreach t in array array['job_control_plans','worker_compliance_records','worker_compliance_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy own_builder_read on public.%I for select to authenticated using (builder_id=(select auth.uid()))',t);
 end loop;
end $$;

-- Existing ownership policies alone did not check that a referenced job belongs to that tenant.
-- A restrictive policy composes with every existing permissive policy, including future additions.
do $$ declare t text; begin
 foreach t in array array['job_cost_entries','job_labour_hours','variations','invoices'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy control_job_tenant_guard on public.%I as restrictive for all to authenticated using (builder_id=(select auth.uid()) and exists(select 1 from public.jobs j where j.id=job_id and j.builder_id=(select auth.uid()))) with check (builder_id=(select auth.uid()) and exists(select 1 from public.jobs j where j.id=job_id and j.builder_id=(select auth.uid())))',t);
 end loop;
end $$;

create function public.save_job_control_plan(p_builder uuid,p_job uuid,p_revision bigint,p_confirm boolean,p_plan jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare revision bigint; s job_profitability_settings; prior job_control_plans; worker uuid; begin
 select profitability_revision into revision from jobs where id=p_job and builder_id=p_builder for update;
 if not found then raise exception 'Job not found';end if;
 if p_revision is null or revision<>p_revision then raise exception 'Financial records changed. Refresh and review again';end if;
 if p_confirm is null then raise exception 'Confirm the forecast basis';end if;
 worker:=(p_plan->>'lead_worker_id')::uuid;
 if worker is not null and not exists(select 1 from workers where id=worker and builder_id=p_builder) then raise exception 'Worker not found';end if;
 if (p_plan->>'cash_as_of')::date>current_date then raise exception 'Actual cash cannot be dated in the future';end if;
 if p_confirm then
  select * into s from job_profitability_settings where job_id=p_job and builder_id=p_builder;
  if s.original_contract is null or coalesce(jsonb_array_length(s.baseline_items),0)=0 then raise exception 'Capture the original priced estimate in Financial gate first';end if;
  if coalesce(s.settings->>'taxReconciled','false')<>'true' then raise exception 'Confirm the GST basis in Financial gate first';end if;
  if exists(select 1 from jsonb_array_elements(s.baseline_items) r where coalesce(r->>'assumption_status','')<>'excluded' and r->>'total' is null) then raise exception 'Resolve missing baseline prices';end if;
  if coalesce(s.settings->>'labourIncluded','false')<>'true' and exists(select 1 from job_labour_hours where job_id=p_job and builder_id=p_builder and hourly_rate is null and hours>0) then raise exception 'Cost all labour hours first';end if;
 end if;
 select * into prior from job_control_plans where job_id=p_job and builder_id=p_builder;
 insert into job_control_plans(job_id,builder_id,confirmed_revision,confirmed_at,cash_received,cash_paid,cash_as_of,start_on,finish_on,lead_worker_id)
 values(p_job,p_builder,case when p_confirm then revision else null end,case when p_confirm then now() else null end,
 (p_plan->>'cash_received')::numeric,(p_plan->>'cash_paid')::numeric,(p_plan->>'cash_as_of')::date,(p_plan->>'start_on')::date,(p_plan->>'finish_on')::date,worker)
 on conflict(job_id)do update set confirmed_revision=excluded.confirmed_revision,confirmed_at=excluded.confirmed_at,
 cash_received=excluded.cash_received,cash_paid=excluded.cash_paid,cash_as_of=excluded.cash_as_of,start_on=excluded.start_on,finish_on=excluded.finish_on,lead_worker_id=excluded.lead_worker_id,updated_at=now();
 insert into proof_events(builder_id,job_id,event_type,description,metadata)values(p_builder,p_job,'approval','Builder saved forecast, cash and capacity assumptions',jsonb_build_object('before',to_jsonb(prior),'after',p_plan,'source_revision',revision,'forecast_confirmed',p_confirm));
end $$;
revoke all on function public.save_job_control_plan(uuid,uuid,bigint,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.save_job_control_plan(uuid,uuid,bigint,boolean,jsonb) to service_role;

create function public.record_worker_compliance(p_builder uuid,p_worker uuid,p_kind text,p_evidence text,p_expires date)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior worker_compliance_records;begin
 perform 1 from workers where id=p_worker and builder_id=p_builder for update;
 if not found then raise exception 'Worker not found';end if;
 select * into prior from worker_compliance_records where worker_id=p_worker and kind=p_kind;
 insert into worker_compliance_records(builder_id,worker_id,kind,evidence,expires_on)values(p_builder,p_worker,p_kind,p_evidence,p_expires)
 on conflict(worker_id,kind)do update set evidence=excluded.evidence,expires_on=excluded.expires_on,reviewed_at=now();
 insert into worker_compliance_events(builder_id,worker_id,kind,evidence)values(p_builder,p_worker,p_kind,jsonb_build_object('before',to_jsonb(prior),'evidence',p_evidence,'expires_on',p_expires,'builder_confirmed',true));
end $$;
revoke all on function public.record_worker_compliance(uuid,uuid,text,text,date) from public,anon,authenticated;
grant execute on function public.record_worker_compliance(uuid,uuid,text,text,date) to service_role;
notify pgrst,'reload schema';
