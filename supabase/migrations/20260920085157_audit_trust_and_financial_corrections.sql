-- One completion path and auditable financial corrections. No historical rows rewritten.
create or replace function public.confirm_profitability_review(p_builder uuid,p_job uuid,p_revision bigint,p_context jsonb,p_review jsonb,p_evidence jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare j jobs; s job_profitability_settings;
begin
 select * into j from jobs where id=p_job and builder_id=p_builder for update;
 if not found then raise exception 'Job not found';end if;
 if j.status not in ('active','complete') then raise exception 'Activate the job before completing its financial review';end if;
 if j.profitability_revision<>p_revision then raise exception 'Financial records changed. Refresh and review again';end if;
 select * into s from job_profitability_settings where job_id=p_job and builder_id=p_builder;
 if not found or jsonb_array_length(coalesce(s.baseline_items,'[]'))=0 or s.settings->>'taxReconciled' is distinct from 'true' then raise exception 'Capture and reconcile the original estimate first';end if;
 if p_evidence->>'taxReconciled' is distinct from 'true' or p_evidence->>'mappingsConfirmed' is distinct from 'true' then raise exception 'Confirm GST and trade mappings';end if;
 if exists(select 1 from job_cost_entries where job_id=p_job and builder_id=p_builder and cost_kind in ('committed','remaining') and amount<>0) then raise exception 'Settle or correct all outstanding commitments and allowances first';end if;
 if s.settings->>'labourIncluded' is distinct from 'true' and exists(select 1 from job_labour_hours where job_id=p_job and builder_id=p_builder and hourly_rate is null) then raise exception 'Cost all labour hours first';end if;
 if s.baseline_quote_id is null or not exists(select 1 from quotes where id=s.baseline_quote_id and job_id=p_job and builder_id=p_builder) then raise exception 'Original quote does not belong to this job';end if;
 -- Repeat confirmation at the same source revision is a no-op.
 if j.status='complete' and exists(select 1 from profitability_reviews where job_id=p_job and builder_id=p_builder and evidence->>'source_revision'=p_revision::text) then return;end if;
 insert into profitability_reviews(job_id,builder_id,context,review,evidence) values(p_job,p_builder,p_context,p_review,p_evidence||jsonb_build_object('source_revision',p_revision))
 on conflict(job_id) do update set context=excluded.context,review=excluded.review,evidence=excluded.evidence,confirmed_at=now();
 update jobs set status='complete' where id=p_job and builder_id=p_builder;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'approval','Builder completed job with reconciled financial review',jsonb_build_object('source_revision',p_revision,'builder_confirmed',true,'fingerprint',p_evidence->>'fingerprint'));
end $$;
revoke all on function public.confirm_profitability_review(uuid,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.confirm_profitability_review(uuid,uuid,bigint,jsonb,jsonb,jsonb) to service_role;

create function public.correct_job_financial_record(p_builder uuid,p_job uuid,p_revision bigint,p_action text,p_id uuid,p_values jsonb,p_reason text)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare j jobs;c job_cost_entries;h job_labour_hours;v_amount numeric;v_hours numeric;v_rate numeric;v_kind text;new_id uuid;after_value jsonb;before_value jsonb;
begin
 select * into j from jobs where id=p_job and builder_id=p_builder for update;
 if not found then raise exception 'Job not found';end if;
 if j.profitability_revision<>p_revision then raise exception 'Financial records changed. Refresh before correcting';end if;
 if length(trim(coalesce(p_reason,'')))<5 or length(p_reason)>1000 then raise exception 'Record a reason for this change (5–1000 characters)';end if;
 if p_action in ('correct_cost','settle_cost','void_cost') then
  select * into c from job_cost_entries where id=p_id and job_id=p_job and builder_id=p_builder for update;
  if not found then raise exception 'Cost not found';end if;
  before_value=to_jsonb(c);
  if p_action='void_cost' then
   update job_cost_entries set amount=0,cost_kind='incurred' where id=c.id;
  else
   v_amount=round((p_values->>'amount')::numeric,2);
   if v_amount is null or v_amount<0 or v_amount>999999999 or v_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter a valid amount';end if;
   if p_action='settle_cost' then
    if (p_values->>'incurred_on') is null or (p_values->>'incurred_on') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose a valid bill date';end if;
    if c.cost_kind not in ('committed','remaining') or v_amount<=0 or v_amount>c.amount then raise exception 'Settled amount must be positive and no greater than the outstanding cost';end if;
    if v_amount=c.amount then update job_cost_entries set cost_kind='incurred' where id=c.id;
    else
     update job_cost_entries set amount=amount-v_amount where id=c.id;
     insert into job_cost_entries(builder_id,job_id,description,amount,trade_category_id,incurred_on,cost_kind,source_ref)
     values(p_builder,p_job,c.description,v_amount,c.trade_category_id,(p_values->>'incurred_on')::date,'incurred','Settlement of '||c.id::text) returning id into new_id;
    end if;
    if v_amount=c.amount then update job_cost_entries set incurred_on=(p_values->>'incurred_on')::date where id=c.id;end if;
   else
    v_kind=p_values->>'cost_kind';
    if v_kind is null or v_kind not in ('incurred','committed','remaining') then raise exception 'Choose a cost type';end if;
    update job_cost_entries set amount=v_amount,cost_kind=v_kind where id=c.id;
   end if;
  end if;
  select to_jsonb(t) into after_value from job_cost_entries t where id=c.id;
 else
  if p_action is distinct from 'correct_hours' then raise exception 'Unknown correction';end if;
  select * into h from job_labour_hours where id=p_id and job_id=p_job and builder_id=p_builder for update;
  if not found then raise exception 'Hours not found';end if;
  before_value=to_jsonb(h);v_hours=(p_values->>'hours')::numeric;v_rate=(p_values->>'hourly_rate')::numeric;
  if v_hours is null or v_hours<=0 or v_hours>24 or v_hours::text='NaN' or v_rate is null or v_rate<0 or v_rate>100000 or v_rate::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter valid hours and hourly cost';end if;
  update job_labour_hours set hours=v_hours,hourly_rate=v_rate where id=h.id;
  select to_jsonb(t) into after_value from job_labour_hours t where id=h.id;
 end if;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'cost_event','Builder corrected financial record: '||p_reason,jsonb_build_object('action',p_action,'before',before_value,'after',after_value,'settled_entry_id',new_id,'builder_confirmed',true));
end $$;
revoke all on function public.correct_job_financial_record(uuid,uuid,bigint,text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.correct_job_financial_record(uuid,uuid,bigint,text,uuid,jsonb,text) to service_role;

-- Pin only previously-unconfigured application functions, never extension-owned objects.
-- All financial writes use owned, audited server routes; retain existing owner read policies.
do $$ declare t text;begin
 foreach t in array array['job_cost_entries','job_labour_hours','project_memory','cost_reconciliation','builder_learned_rates'] loop
  if to_regclass('public.'||t) is not null then
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke insert,update,delete,truncate,references,trigger on public.%I from public,anon,authenticated',t);
  end if;
 end loop;
end $$;

do $$ declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prokind='f' and not exists(select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) v where v like 'search_path=%')
 and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
 loop execute format('alter function %s set search_path = public, extensions, pg_temp',f.signature);end loop;
end $$;
notify pgrst,'reload schema';
