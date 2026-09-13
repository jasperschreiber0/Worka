-- Additive profitability layer; no changes to estimate execution/recovery.
alter table public.jobs add column profitability_revision bigint not null default 0;
create table public.business_financial_profiles (
  builder_id uuid primary key references public.builders(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  cash_flow jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table public.job_profitability_settings (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  builder_id uuid not null references public.builders(id) on delete cascade,
  baseline_quote_id uuid references public.quotes(id),
  baseline_items jsonb not null default '[]',
  original_contract numeric(12,2) check(original_contract >= 0),
  settings jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table public.profitability_candidates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  builder_id uuid not null references public.builders(id) on delete cascade,
  source_event_id uuid references public.proof_events(id),
  variation_id uuid unique references public.variations(id),
  title text not null, original_scope text, requested_change text,
  trade_category_id integer references public.trade_categories(id),
  estimated_cost numeric(12,2) check(estimated_cost >= 0), proposed_charge numeric(12,2) check(proposed_charge >= 0),
  status text not null default 'potential' check(status in ('potential','reviewing','priced','sent','approved','rejected','completed','unrecovered','recovered','not_a_change')),
  incurred numeric(12,2) not null default 0 check(incurred>=0),
  billed numeric(12,2) not null default 0 check(billed>=0),
  recovered numeric(12,2) not null default 0 check(recovered>=0),
  evidence text not null, confidence numeric check(confidence>=0 and confidence<=1),
  builder_confirmed boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.cost_import_batches (
 id uuid primary key default gen_random_uuid(), builder_id uuid not null references public.builders(id), job_id uuid not null references public.jobs(id),
 fingerprint text not null, source_name text not null, mapping jsonb not null, created_at timestamptz not null default now(), unique(job_id,fingerprint)
);
alter table public.job_cost_entries
 add column import_batch_id uuid references public.cost_import_batches(id),
 add column source_row integer,
 add column supplier text, add column invoice_ref text, add column category text, add column cost_code text,
 add column labour_hours numeric check(labour_hours>=0), add column labour_cost numeric check(labour_cost>=0),
 add column classification_confidence numeric check(classification_confidence between 0 and 1),
 add column source_ref text, add column import_metadata jsonb,
 add column variation_id uuid references public.variations(id);
create unique index cost_import_row_unique on public.job_cost_entries(import_batch_id,source_row) where import_batch_id is not null;
create table public.profitability_reviews (
 job_id uuid primary key references public.jobs(id), builder_id uuid not null references public.builders(id),
 context jsonb not null, review jsonb not null, evidence jsonb not null,
 confirmed_at timestamptz not null default now()
);
do $$ declare t text; begin
 foreach t in array array['business_financial_profiles','job_profitability_settings','profitability_candidates','cost_import_batches','profitability_reviews'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy own_builder_read on public.%I for select to authenticated using (builder_id = (select auth.uid()))',t);
 end loop;
end $$;
create index profitability_candidates_job_idx on public.profitability_candidates(builder_id,job_id);
create index profitability_reviews_builder_idx on public.profitability_reviews(builder_id);

-- Atomic batch import: retries cannot duplicate costs or leave partial imports.
create function public.import_profitability_costs(p_builder uuid,p_job uuid,p_fingerprint text,p_name text,p_mapping jsonb,p_rows jsonb)
returns uuid language plpgsql security invoker set search_path = public,pg_temp as $$
declare batch uuid; r jsonb; begin
 if not exists(select 1 from jobs where id=p_job and builder_id=p_builder) then raise exception 'Job not found'; end if;
 if jsonb_array_length(p_rows)<1 or jsonb_array_length(p_rows)>2000 then raise exception 'Import 1–2000 rows';end if;
 insert into cost_import_batches(builder_id,job_id,fingerprint,source_name,mapping) values(p_builder,p_job,p_fingerprint,p_name,p_mapping) returning id into batch;
 for r in select value from jsonb_array_elements(p_rows) loop
  insert into job_cost_entries(builder_id,job_id,description,amount,trade_category_id,incurred_on,cost_kind,import_batch_id,source_row,supplier,invoice_ref,category,cost_code,labour_hours,labour_cost,classification_confidence,source_ref,import_metadata)
  values(p_builder,p_job,r->>'description',(r->>'amount')::numeric,(r->>'trade_category_id')::integer,(r->>'incurred_on')::date,'incurred',batch,(r->>'source_row')::integer,r->>'supplier',r->>'invoice_ref',r->>'category',r->>'cost_code',(r->>'labour_hours')::numeric,(r->>'labour_cost')::numeric,(r->>'classification_confidence')::numeric,p_name,r->'import_metadata');
 end loop;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'actual_cost','Builder approved actual cost import',jsonb_build_object('batch_id',batch,'source',p_name,'rows',jsonb_array_length(p_rows),'mapping',p_mapping,'builder_confirmed',true));
 delete from profitability_reviews where job_id=p_job; -- previous completion is no longer current
 return batch;
end $$;
revoke all on function public.import_profitability_costs(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.import_profitability_costs(uuid,uuid,text,text,jsonb,jsonb) to service_role;

-- Draft only. Client approval stays in the existing variation workflow.
create function public.create_profitability_variation(p_builder uuid,p_candidate uuid)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare c profitability_candidates; v uuid; begin
 select * into c from profitability_candidates where id=p_candidate and builder_id=p_builder for update;
 if not found then raise exception 'Candidate not found';end if;
 if c.variation_id is not null then return c.variation_id;end if;
 if c.proposed_charge is null then raise exception 'Enter a proposed client charge';end if;
 if not exists(select 1 from jobs where id=c.job_id and builder_id=p_builder) then raise exception 'Job not found';end if;
 insert into variations(builder_id,job_id,title,description,amount,status,trade_category_id) values(p_builder,c.job_id,c.title,coalesce(c.requested_change,c.title),c.proposed_charge,'draft',c.trade_category_id) returning id into v;
 update profitability_candidates set variation_id=v,status='priced',builder_confirmed=true,updated_at=now() where id=c.id;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,c.job_id,'variation','Builder created draft variation',jsonb_build_object('variation_id',v,'candidate_id',c.id,'builder_confirmed',true));
 return v;
end $$;
revoke all on function public.create_profitability_variation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.create_profitability_variation(uuid,uuid) to service_role;

-- Persist candidate review and its evidence together.
create function public.review_profitability_candidate(p_builder uuid,p_id uuid,p_values jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare c profitability_candidates; begin
 select * into c from profitability_candidates where id=p_id and builder_id=p_builder for update;
 if not found then raise exception 'Candidate not found';end if;
 if p_values->>'status' in ('approved','sent') then raise exception 'Use the existing client approval workflow';end if;
 if p_values->>'status' in ('completed','recovered') and not exists(select 1 from variations where id=c.variation_id and builder_id=p_builder and status='approved') then raise exception 'Client approval is required first';end if;
 update profitability_candidates set estimated_cost=(p_values->>'estimated_cost')::numeric,proposed_charge=(p_values->>'proposed_charge')::numeric,incurred=(p_values->>'incurred')::numeric,billed=(p_values->>'billed')::numeric,recovered=(p_values->>'recovered')::numeric,trade_category_id=(p_values->>'trade_category_id')::integer,status=p_values->>'status',builder_confirmed=true,updated_at=now() where id=p_id;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,c.job_id,'client_decision','Builder reviewed commercial risk',jsonb_build_object('candidate_id',c.id,'before',to_jsonb(c),'after',p_values,'builder_confirmed',true));
end $$;
revoke all on function public.review_profitability_candidate(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.review_profitability_candidate(uuid,uuid,jsonb) to service_role;
create table public.profitability_learning_decisions (
 id uuid primary key default gen_random_uuid(),builder_id uuid not null references builders(id),job_id uuid not null references jobs(id),quote_id uuid not null references quotes(id),
 trade_category_id integer not null references trade_categories(id),decision text not null check(decision in ('apply','ignore')),adjustment_pct numeric not null,
 evidence jsonb not null,line_item_id uuid references quote_line_items(id),created_at timestamptz not null default now(),unique(quote_id,trade_category_id)
);
alter table public.profitability_learning_decisions enable row level security;
revoke all on public.profitability_learning_decisions from anon,authenticated;
grant select on public.profitability_learning_decisions to authenticated;
grant all on public.profitability_learning_decisions to service_role;
create policy own_builder_read on public.profitability_learning_decisions for select to authenticated using(builder_id=(select auth.uid()));
create function public.apply_profitability_learning(p_builder uuid,p_job uuid,p_quote uuid,p_trade integer,p_decision text,p_pct numeric,p_evidence jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare q quotes; cost numeric; markup numeric; adjustment numeric; item uuid; decision_id uuid; begin
 select * into q from quotes where id=p_quote and job_id=p_job and builder_id=p_builder for update;
 if not found or q.status not in ('draft','pending_review') then raise exception 'Only a draft estimate can be adjusted';end if;
 if p_pct < -100 or p_pct>100 or (p_decision='apply' and p_pct<=0) then raise exception 'Apply a positive adjustment up to 100 percent; review savings manually';end if;
 insert into profitability_learning_decisions(builder_id,job_id,quote_id,trade_category_id,decision,adjustment_pct,evidence) values(p_builder,p_job,p_quote,p_trade,p_decision,p_pct,p_evidence) returning id into decision_id;
 if p_decision='apply' then
  select sum(total),sum(total*coalesce(margin_pct,0))/nullif(sum(total),0) into cost,markup from quote_line_items where quote_id=p_quote and trade_category_id=p_trade and variation_id is null and assumption_status is distinct from 'excluded';
  if cost is null or cost<=0 then raise exception 'No baseline cost exists for this trade';end if;
  adjustment=round(cost*p_pct/100,2);
  if adjustment<=0 then raise exception 'Adjustment must add a positive allowance';end if;
  insert into quote_line_items(quote_id,trade_category_id,description,quantity,unit,rate,total,margin_pct,confidence,is_assumption,pricing_source,predicted_by)
  values(p_quote,p_trade,'Builder-approved historical cost allowance',1,'sum',adjustment,adjustment,coalesce(markup,0),100,false,'manual','human') returning id into item;
  update profitability_learning_decisions set line_item_id=item where id=decision_id;
  update quotes set total_cost=(select coalesce(sum(total),0) from quote_line_items where quote_id=p_quote and assumption_status is distinct from 'excluded'),qa_report=null where id=p_quote;
 end if;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'estimate','Builder '||p_decision||' historical cost recommendation',jsonb_build_object('decision_id',decision_id,'trade_category_id',p_trade,'adjustment_pct',p_pct,'line_item_id',item,'evidence',p_evidence,'builder_confirmed',true));
 return decision_id;
end $$;
revoke all on function public.apply_profitability_learning(uuid,uuid,uuid,integer,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.apply_profitability_learning(uuid,uuid,uuid,integer,text,numeric,jsonb) to service_role;

-- Atomic correspondence event + draft candidate. AI has no approval path.
create function public.record_profitability_correspondence(p_builder uuid,p_job uuid,p_analysis jsonb,p_source jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare event uuid; begin
 if not exists(select 1 from jobs where id=p_job and builder_id=p_builder)then raise exception 'Job not found';end if;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,p_analysis->>'type',p_analysis->>'title',jsonb_build_object('analysis',p_analysis,'source',p_source,'evidence',p_analysis->>'excerpt','estimate_item_id',p_analysis->>'item_id','trade_category_id',p_analysis->'trade','confidence',p_analysis->'confidence','approval_state','not_approved','builder_confirmed',false)) returning id into event;
 if p_analysis->>'type' in ('possible_scope_change','architect_instruction') then
 insert into profitability_candidates(builder_id,job_id,source_event_id,title,original_scope,requested_change,trade_category_id,evidence,confidence,status) values(p_builder,p_job,event,p_analysis->>'title',p_analysis->>'original_scope',p_analysis->>'excerpt',(p_analysis->>'trade')::integer,p_analysis->>'excerpt',(p_analysis->>'confidence')::numeric,'potential');
 end if;
 return event;
end $$;
revoke all on function public.record_profitability_correspondence(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_profitability_correspondence(uuid,uuid,jsonb,jsonb) to service_role;

-- Invalidate derived review snapshots when the financial source changes.
-- Narrow trigger privilege is needed because existing authenticated cost writers cannot delete snapshots directly.
create function public.invalidate_profitability_review() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if TG_OP<>'INSERT' then
  update jobs set profitability_revision=profitability_revision+1 where id=old.job_id and builder_id=old.builder_id;
  delete from profitability_reviews where job_id=old.job_id and builder_id=old.builder_id;
 end if;
 if TG_OP<>'DELETE' then
  update jobs set profitability_revision=profitability_revision+1 where id=new.job_id and builder_id=new.builder_id;
  delete from profitability_reviews where job_id=new.job_id and builder_id=new.builder_id;
 end if;
 return null;
end $$;
revoke all on function public.invalidate_profitability_review() from public,anon,authenticated;
create trigger invalidate_cost_review after insert or update or delete on public.job_cost_entries for each row execute function public.invalidate_profitability_review();
create trigger invalidate_labour_review after insert or update or delete on public.job_labour_hours for each row execute function public.invalidate_profitability_review();
create trigger invalidate_variation_review after insert or update or delete on public.variations for each row execute function public.invalidate_profitability_review();
create trigger invalidate_settings_review after insert or update or delete on public.job_profitability_settings for each row execute function public.invalidate_profitability_review();
create function public.save_profitability_settings(p_builder uuid,p_job uuid,p_contract numeric,p_settings jsonb,p_capture boolean,p_quote uuid,p_items jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior job_profitability_settings; begin
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;
 if not found then raise exception 'Job not found';end if;
 select * into prior from job_profitability_settings where job_id=p_job;
 if p_capture and jsonb_array_length(coalesce(prior.baseline_items,'[]'))>0 then raise exception 'Original baseline is already captured';end if;
 if p_capture and not exists(select 1 from quotes where id=p_quote and job_id=p_job and builder_id=p_builder)then raise exception 'Quote not found';end if;
 insert into job_profitability_settings(job_id,builder_id,original_contract,settings,baseline_quote_id,baseline_items) values(p_job,p_builder,p_contract,p_settings,case when p_capture then p_quote else prior.baseline_quote_id end,case when p_capture then p_items else coalesce(prior.baseline_items,'[]') end)
 on conflict(job_id)do update set original_contract=excluded.original_contract,settings=excluded.settings,baseline_quote_id=excluded.baseline_quote_id,baseline_items=excluded.baseline_items,updated_at=now();
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'estimate','Builder saved profitability assumptions',jsonb_build_object('before',to_jsonb(prior),'after',p_settings,'original_contract',p_contract,'baseline_captured',p_capture,'builder_confirmed',true));
end $$;
revoke all on function public.save_profitability_settings(uuid,uuid,numeric,jsonb,boolean,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_profitability_settings(uuid,uuid,numeric,jsonb,boolean,uuid,jsonb) to service_role;
create function public.classify_profitability_cost(p_builder uuid,p_job uuid,p_cost uuid,p_trade integer,p_category text)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior job_cost_entries;begin
 select * into prior from job_cost_entries where id=p_cost and job_id=p_job and builder_id=p_builder for update;
 if not found then raise exception 'Cost not found';end if;
 update job_cost_entries set trade_category_id=p_trade,category=p_category,classification_confidence=1 where id=p_cost;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'cost_event','Builder corrected cost classification',jsonb_build_object('cost_id',p_cost,'before',jsonb_build_object('trade',prior.trade_category_id,'category',prior.category),'after',jsonb_build_object('trade',p_trade,'category',p_category),'builder_confirmed',true));
end $$;
revoke all on function public.classify_profitability_cost(uuid,uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.classify_profitability_cost(uuid,uuid,uuid,integer,text) to service_role;
create function public.confirm_profitability_review(p_builder uuid,p_job uuid,p_revision bigint,p_context jsonb,p_review jsonb,p_evidence jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare revision bigint;begin
 select profitability_revision into revision from jobs where id=p_job and builder_id=p_builder for update;
 if not found then raise exception 'Job not found';end if;
 if revision<>p_revision then raise exception 'Financial records changed. Refresh and review again before confirming';end if;
 insert into profitability_reviews(job_id,builder_id,context,review,evidence)values(p_job,p_builder,p_context,p_review,p_evidence)
 on conflict(job_id)do update set context=excluded.context,review=excluded.review,evidence=excluded.evidence,confirmed_at=now();
 insert into proof_events(builder_id,job_id,event_type,description,metadata)values(p_builder,p_job,'approval','Builder confirmed completed profitability review',jsonb_build_object('source_revision',revision,'builder_confirmed',true,'fingerprint',p_evidence->>'fingerprint'));
end $$;
revoke all on function public.confirm_profitability_review(uuid,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.confirm_profitability_review(uuid,uuid,bigint,jsonb,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
