-- Additive operational records. Financial effects use the existing cost/variation ledgers.
create table public.job_workflow_records (
 id uuid primary key, builder_id uuid not null references public.builders(id), job_id uuid not null references public.jobs(id),
 kind text not null check(kind in ('purchase_order','bill','selection','programme','scope_pack','site_update','question','deadline','trade_quote','material_transfer')),
 title text not null check(length(title) between 1 and 200), status text not null default 'draft' check(status in ('draft','confirmed','completed','superseded')),
 version integer not null default 1, basis_revision bigint not null, payload jsonb not null default '{}', result jsonb not null default '{}',
 linked_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(builder_id,job_id,id)
);
create index job_workflow_owner on public.job_workflow_records(builder_id,job_id,kind);
create unique index job_workflow_bill_identity on public.job_workflow_records(builder_id,job_id,lower(trim(payload->>'supplier')),lower(trim(payload->>'invoice_ref'))) where kind='bill' and status in ('confirmed','completed');
create table public.job_workflow_events (
 id bigint generated always as identity primary key, builder_id uuid not null references public.builders(id), job_id uuid not null references public.jobs(id),
 record_id uuid not null references public.job_workflow_records(id), action text not null, before_record jsonb, after_record jsonb not null, created_at timestamptz not null default now()
);
alter table public.job_workflow_records enable row level security;
alter table public.job_workflow_events enable row level security;
revoke all on public.job_workflow_records,public.job_workflow_events from public,anon,authenticated;
grant select on public.job_workflow_records,public.job_workflow_events to authenticated;
grant all on public.job_workflow_records,public.job_workflow_events to service_role;
grant usage,select on sequence public.job_workflow_events_id_seq to service_role;
create policy workflow_owner_read on public.job_workflow_records for select to authenticated using(builder_id=(select auth.uid()) and exists(select 1 from public.jobs j where j.id=job_id and j.builder_id=(select auth.uid())));
create policy workflow_events_owner_read on public.job_workflow_events for select to authenticated using(builder_id=(select auth.uid()) and exists(select 1 from public.jobs j where j.id=job_id and j.builder_id=(select auth.uid())));

-- Signed actuals are supported; commitments and remaining estimates must stay non-negative.
alter table public.job_cost_entries drop constraint if exists job_cost_entries_amount_check;
alter table public.job_cost_entries add constraint job_cost_entries_signed_amount check(amount::text not in ('NaN','Infinity','-Infinity') and abs(amount)<=999999999 and (coalesce(cost_kind,'incurred')='incurred' or amount>=0));
alter table public.job_cost_entries drop constraint if exists job_cost_entries_labour_cost_check;
alter table public.job_cost_entries add constraint job_cost_entries_signed_labour_cost check(labour_cost is null or (labour_cost::text not in ('NaN','Infinity','-Infinity') and abs(labour_cost)<=999999999));
alter table public.profitability_candidates drop constraint if exists profitability_candidates_estimated_cost_check;
alter table public.profitability_candidates drop constraint if exists profitability_candidates_proposed_charge_check;

create function public.save_job_workflow(p_builder uuid,p_job uuid,p_id uuid,p_version integer,p_kind text,p_title text,p_payload jsonb,p_result jsonb,p_action text,p_basis bigint)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare old job_workflow_records; r job_workflow_records; related job_workflow_records; rev bigint; effect uuid; net numeric; released numeric; cost job_cost_entries; ref text;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_builder::text,0));
 select profitability_revision into rev from jobs where id=p_job and builder_id=p_builder for update;
 if not found then raise exception 'Job not found'; end if;
 select * into old from job_workflow_records where id=p_id for update;
 if found and (old.builder_id<>p_builder or old.job_id<>p_job) then raise exception 'Record not found';end if;
 if old.id is not null and p_action='save' and old.kind<>p_kind then raise exception 'Record type cannot change';end if;
 if p_action not in ('save','confirm','complete','supersede') then raise exception 'Unsupported action';end if;
 if old.id is not null and ((p_action='confirm' and old.status='confirmed') or (p_action='complete' and old.status='completed')) then return to_jsonb(old);end if;
 if old.id is not null and old.version<>p_version then raise exception 'This record changed. Reload and review before saving';end if;
 if old.id is null and (p_version<>0 or p_action<>'save') then raise exception 'Save a draft first';end if;
 if p_action='save' and old.id is not null and old.status<>'draft' then raise exception 'Approved records are preserved. Prepare a new draft';end if;
 if p_action='confirm' and (old.status<>'draft' or old.basis_revision<>rev) then raise exception 'Job financials changed. Reopen and save this draft before approval';end if;
 if p_action='complete' and old.status<>'confirmed' then raise exception 'Confirm the record first';end if;
 if p_action='supersede' and old.status<>'draft' then raise exception 'Only drafts may be withdrawn; correct approved financial records through the audited ledger';end if;
 if p_action='save' then
  if p_basis is distinct from rev then raise exception 'Job changed. Refresh before saving this proposal';end if;
  foreach ref in array array['po_id','activity_id','accepted_quote_id'] loop
   if nullif(p_payload->>ref,'') is not null and not exists(select 1 from job_workflow_records where id=(p_payload->>ref)::uuid and job_id=p_job and builder_id=p_builder) then raise exception 'Linked record belongs to another job or no longer exists';end if;
  end loop;
  for ref in select jsonb_array_elements_text(coalesce(p_payload->'dependencies','[]')) loop
   if ref=p_id::text or not exists(select 1 from job_workflow_records where id=ref::uuid and job_id=p_job and builder_id=p_builder and kind='programme') then raise exception 'Invalid programme dependency';end if;
  end loop;
  for ref in select jsonb_array_elements_text(coalesce(p_payload->'file_ids','[]')) loop
   if not exists(select 1 from files where id=ref::uuid and job_id=p_job and builder_id=p_builder) then raise exception 'Evidence file is not in this job';end if;
  end loop;
  insert into job_workflow_records(id,builder_id,job_id,kind,title,basis_revision,payload,result)
   values(p_id,p_builder,p_job,p_kind,p_title,rev,p_payload,p_result)
   on conflict(id) do update set title=excluded.title,payload=excluded.payload,result=excluded.result,basis_revision=rev,version=job_workflow_records.version+1,updated_at=now()
   returning * into r;
 else
  r:=old;
  if p_action='complete' then
   if r.kind in ('purchase_order','bill','trade_quote','material_transfer') then raise exception 'Use the linked commercial workflow';end if;
   if r.kind='selection' and not exists(select 1 from variations where id=r.linked_id and builder_id=p_builder and status='approved') then raise exception 'Record evidenced client approval before completing this selection';end if;
   if r.kind='scope_pack' and (length(trim(coalesce(p_payload->>'completion_evidence','')))<10 or length(trim(coalesce(p_payload->>'acknowledgement','')))<5) then raise exception 'Record trade acknowledgement and builder release / completion evidence';end if;
   if length(trim(coalesce(p_payload->>'completion_evidence','')))>8000 then raise exception 'Completion evidence is too long';end if;
   update job_workflow_records set payload=payload||jsonb_build_object('completion_evidence',p_payload->>'completion_evidence','acknowledgement',p_payload->>'acknowledgement') where id=p_id;
   if r.kind='programme' and (exists(select 1 from jsonb_array_elements_text(coalesce(r.payload->'dependencies','[]')) d(id) where not exists(select 1 from job_workflow_records x where x.id=d.id::uuid and x.job_id=p_job and x.status='completed')) or exists(select 1 from job_workflow_records x where x.job_id=p_job and x.payload->>'activity_id'=p_id::text and x.status not in ('completed','superseded'))) then raise exception 'Resolve linked blockers before completing this activity';end if;
  end if;
  if p_action='confirm' then
   if nullif(r.payload->>'replaces_record_id','') is not null then
    if r.kind not in ('programme','scope_pack','site_update','question','deadline') then raise exception 'Use financial corrections for commercial records';end if;
    select * into related from job_workflow_records where id=(r.payload->>'replaces_record_id')::uuid and job_id=p_job and builder_id=p_builder and kind=r.kind and status='confirmed' for update;
    if not found or related.version is distinct from (r.payload->>'replaces_version')::integer then raise exception 'Original record changed. Prepare a new revision from the current record';end if;
    update job_workflow_records set status='superseded',version=version+1,updated_at=now() where id=related.id;
    insert into job_workflow_events(builder_id,job_id,record_id,action,before_record,after_record) values(p_builder,p_job,related.id,'superseded_by_revision',to_jsonb(related),jsonb_build_object('replacement_id',p_id));
   end if;
   if r.kind in ('purchase_order','bill','trade_quote') then
    if r.payload->>'tax_basis' not in ('exclusive','inclusive') or nullif(trim(r.payload->>'supplier'),'') is null then raise exception 'Supplier and GST basis are required';end if;
    net:=round((r.payload->>'source_amount')::numeric / case when r.payload->>'tax_basis'='inclusive' then 1.1 else 1 end,2);
    if net is null or net::text in ('NaN','Infinity','-Infinity') or abs(net)>999999999 then raise exception 'Invalid source amount';end if;
   end if;
   if r.kind='purchase_order' then
    if net<0 then raise exception 'Purchase order cannot be negative';end if;
    insert into job_cost_entries(builder_id,job_id,description,amount,cost_kind,trade_category_id,incurred_on,supplier,source_ref)
     values(p_builder,p_job,r.title,net,'committed',nullif(r.payload->>'trade_id','')::integer,current_date,r.payload->>'supplier','PO '||r.id) returning id into effect;
   elsif r.kind='bill' then
    if nullif(trim(r.payload->>'invoice_ref'),'') is null then raise exception 'Invoice or credit reference required';end if;
    if nullif(r.payload->>'po_id','') is not null then
     select * into related from job_workflow_records where id=(r.payload->>'po_id')::uuid and job_id=p_job and builder_id=p_builder and kind='purchase_order' and status='confirmed' for update;
     if not found then raise exception 'Confirm this job purchase order first';end if;
     select * into cost from job_cost_entries where id=related.linked_id and job_id=p_job and builder_id=p_builder for update;
     released:=coalesce((r.payload->>'release_amount')::numeric,0);
     if (net<>released or lower(trim(r.payload->>'supplier'))<>lower(trim(related.payload->>'supplier'))) and coalesce((r.payload->>'match_reviewed')::boolean,false) is false then raise exception 'Review the supplier or amount difference from the purchase order before approval';end if;
     if cost.id is null or released<0 or released>cost.amount or (net<0 and released<>0) then raise exception 'Review the outstanding commitment amount being replaced';end if;
     update job_cost_entries set amount=amount-released where id=cost.id;
    elsif coalesce((r.payload->>'release_amount')::numeric,0)<>0 then raise exception 'Choose the commitment being replaced';end if;
    insert into job_cost_entries(builder_id,job_id,description,amount,cost_kind,trade_category_id,incurred_on,supplier,invoice_ref,source_ref,import_metadata,labour_hours)
     values(p_builder,p_job,r.title,net,'incurred',nullif(r.payload->>'trade_id','')::integer,coalesce(nullif(r.payload->>'invoice_on','')::date,current_date),r.payload->>'supplier',r.payload->>'invoice_ref','Bill '||r.id,jsonb_build_object('original_amount',r.payload->'source_amount','tax_basis',r.payload->'tax_basis','commitment_before',to_jsonb(cost),'commitment_released',released),nullif(r.payload->>'labour_hours','')::numeric) returning id into effect;
   elsif r.kind='material_transfer' then
    if r.payload->>'tax_basis' not in ('exclusive','inclusive') or nullif(trim(r.payload->>'evidence'),'') is null then raise exception 'Record the source GST basis and material transfer evidence';end if;
    net:=round((r.payload->>'source_amount')::numeric / case when r.payload->>'tax_basis'='inclusive' then 1.1 else 1 end,2);
    if net is null or net<=0 or net>999999999 or net::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter a positive material value';end if;
    if (r.payload->>'to_job_id')::uuid=p_job then raise exception 'Choose a different receiving job';end if;
    perform 1 from jobs where id=(r.payload->>'to_job_id')::uuid and builder_id=p_builder for update;
    if not found then raise exception 'Receiving job not found';end if;
    insert into job_cost_entries(builder_id,job_id,description,amount,cost_kind,trade_category_id,incurred_on,source_ref,import_metadata)
    values(p_builder,p_job,'Material transferred out: '||r.title,-net,'incurred',nullif(r.payload->>'trade_id','')::integer,current_date,'Transfer '||r.id,r.payload) returning id into effect;
    insert into job_cost_entries(builder_id,job_id,description,amount,cost_kind,trade_category_id,incurred_on,source_ref,import_metadata)
    values(p_builder,(r.payload->>'to_job_id')::uuid,'Material received: '||r.title,net,'incurred',nullif(r.payload->>'trade_id','')::integer,current_date,'Transfer '||r.id,r.payload);
   elsif r.kind='selection' then
    if coalesce((r.result->>'ready')::boolean,false) is false then raise exception 'Resolve scenario assumptions and confirm the cost review first';end if;
    insert into variations(builder_id,job_id,title,description,amount,status,trade_category_id)
     values(p_builder,p_job,r.title,r.result->>'email_draft',(r.result->>'proposed_charge')::numeric,'draft',nullif(r.payload->>'trade_id','')::integer) returning id into effect;
    insert into profitability_candidates(builder_id,job_id,variation_id,title,requested_change,estimated_cost,proposed_charge,status,evidence,builder_confirmed,trade_category_id)
    values(p_builder,p_job,effect,r.title,r.result->>'email_draft',(r.result->>'expected_cost')::numeric,(r.result->>'proposed_charge')::numeric,'priced',r.payload::text,true,nullif(r.payload->>'trade_id','')::integer);
   elsif r.kind='scope_pack' then
    if nullif(trim(r.payload->>'questions'),'') is not null then raise exception 'Resolve outstanding scope questions before finalising this pack';end if;
    if exists(select 1 from files where id in(select value::uuid from jsonb_array_elements_text(coalesce(r.payload->'file_ids','[]'))) and drawing_state not in ('current','evidence')) then raise exception 'Scope attachments must be current drawings or supporting evidence';end if;
    if nullif(r.payload->>'specification_ref','') is null or jsonb_array_length(coalesce(r.payload->'file_ids','[]'))=0 then raise exception 'Select issued drawings and record the issued specification before finalising';end if;
    if r.payload->>'purpose'='appointed' and not exists(select 1 from job_workflow_records where id=nullif(r.payload->>'accepted_quote_id','')::uuid and job_id=p_job and builder_id=p_builder and kind='trade_quote' and status='confirmed') then raise exception 'Appointed trade pack requires a confirmed accepted trade quote';end if;
   end if;
  end if;
  update job_workflow_records set status=case p_action when 'confirm' then 'confirmed' when 'complete' then 'completed' else 'superseded' end,version=version+1,linked_id=coalesce(effect,linked_id),updated_at=now() where id=p_id returning * into r;
  update jobs set profitability_revision=profitability_revision+1 where id=p_job;
 end if;
 insert into job_workflow_events(builder_id,job_id,record_id,action,before_record,after_record) values(p_builder,p_job,p_id,p_action,to_jsonb(old),to_jsonb(r));
 return to_jsonb(r);
end $$;
revoke all on function public.save_job_workflow(uuid,uuid,uuid,integer,text,text,jsonb,jsonb,text,bigint) from public,anon,authenticated;
grant execute on function public.save_job_workflow(uuid,uuid,uuid,integer,text,text,jsonb,jsonb,text,bigint) to service_role;

alter table public.files add column drawing_state text not null default 'current' check(drawing_state in ('current','superseded','unresolved','duplicate','evidence'));
alter table public.files add column replaces_file_id uuid references public.files(id);
update public.files set drawing_state='duplicate' where duplicate_of_file_id is not null;
alter table public.project_facts add column review_required boolean not null default false;
create table public.estimate_source_sets (
 id uuid primary key, job_id uuid not null references public.jobs(id), builder_id uuid not null references public.builders(id),
 file_ids uuid[] not null, previous_quote_id uuid references public.quotes(id), draft_quote_id uuid references public.quotes(id),
 batch_id uuid references public.document_processing_batches(id), manual_policy text not null, created_at timestamptz not null default now(),
 previous_items jsonb not null default '[]', cleared_at timestamptz
);
alter table public.estimate_source_sets enable row level security;
revoke all on public.estimate_source_sets from public,anon,authenticated;
grant select on public.estimate_source_sets to authenticated;
grant all on public.estimate_source_sets to service_role;
create policy source_sets_owner on public.estimate_source_sets for select to authenticated using(builder_id=(select auth.uid()));
create index source_sets_job on public.estimate_source_sets(job_id,builder_id);
alter table public.scope_items add column source_batch_id uuid references public.document_processing_batches(id);

create function public.publish_estimate_draft(p_builder uuid,p_job uuid,p_quote uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;if not found then raise exception 'Job not found';end if;
 if not exists(select 1 from quotes where id=p_quote and job_id=p_job and builder_id=p_builder and status in ('draft','pending_review')) then raise exception 'Draft is no longer editable';end if;
 if exists(select 1 from quotes where job_id=p_job and is_current and status in ('sent','approved') and id<>p_quote) then return false;end if;
 perform set_current_quote(p_job,p_quote);return true;
end $$;
revoke all on function public.publish_estimate_draft(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.publish_estimate_draft(uuid,uuid,uuid) to service_role;

create function public.reconcile_job_drawing(p_builder uuid,p_job uuid,p_file uuid,p_action text,p_replaces uuid)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare f files;
begin
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;if not found then raise exception 'Job not found';end if;
 select * into f from files where id=p_file and job_id=p_job and builder_id=p_builder for update;if not found then raise exception 'File not found';end if;
 if p_action not in ('add','replace','evidence') then raise exception 'Choose add, replace or evidence only';end if;
 if f.drawing_state<>'unresolved' then raise exception 'This document has already been reconciled';end if;
 if f.content_hash is null and p_action<>'evidence' then raise exception 'Verify the uploaded file first';end if;
 if p_action='replace' then
  if p_replaces=p_file or not exists(select 1 from files where id=p_replaces and job_id=p_job and builder_id=p_builder and drawing_state='current') then raise exception 'Choose a current drawing in this job';end if;
  update files set drawing_state='superseded' where id=p_replaces;
  update project_facts set review_required=true where job_id=p_job and category='builder_answer' and not superseded;
 end if;
 update files set drawing_state=case when p_action='evidence' then 'evidence' else 'current' end,replaces_file_id=case when p_action='replace' then p_replaces else null end where id=p_file;
 update jobs set profitability_revision=profitability_revision+1 where id=p_job;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'drawing_reconciled','Builder reconciled uploaded document',jsonb_build_object('file_id',p_file,'action',p_action,'replaces',p_replaces));
end $$;
revoke all on function public.reconcile_job_drawing(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.reconcile_job_drawing(uuid,uuid,uuid,text,uuid) to service_role;

create function public.prepare_estimate_refresh(p_builder uuid,p_job uuid,p_request uuid,p_manual text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare old quotes; fresh uuid; batch uuid; source_ids uuid[]; run estimate_source_sets; item jsonb; next_version integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_builder::text,0));
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;if not found then raise exception 'Job not found';end if;
 select * into run from estimate_source_sets where id=p_request;
 if found then if run.job_id<>p_job or run.builder_id<>p_builder then raise exception 'Request belongs to another job';end if;return to_jsonb(run);end if;
 if p_manual not in ('retain','review') then raise exception 'Choose whether to retain manual items or reprice them';end if;
 if not exists(select 1 from estimating_access where builder_id=p_builder and enabled) then raise exception 'Estimating is not enabled for this account';end if;
 if exists(select 1 from estimate_workflow w join document_processing_batches b on b.id=w.batch_id where b.job_id=p_job and w.state in ('queued','running')) then raise exception 'An estimate is already processing. Resume or finish it before refreshing';end if;
 if exists(select 1 from files where job_id=p_job and drawing_state='unresolved') then raise exception 'Reconcile uploaded drawings first';end if;
 if exists(select 1 from project_facts where job_id=p_job and category='builder_answer' and not superseded and review_required) then raise exception 'Review saved answers affected by revised plans first';end if;
 select array_agg(id order by created_at,id) into source_ids from files where job_id=p_job and builder_id=p_builder and drawing_state='current' and file_type in ('pdf','image','dwg');
 if coalesce(cardinality(source_ids),0)<1 or cardinality(source_ids)>30 then raise exception 'Select between 1 and 30 current plan documents';end if;
 if exists(select 1 from files f where id=any(source_ids) and not exists(select 1 from storage.objects o where o.bucket_id='plans' and o.name=f.storage_path)) then raise exception 'A selected upload is incomplete. Upload the file again';end if;
 select * into old from quotes where job_id=p_job and is_current for update;
 select coalesce(max(version),0)+1 into next_version from quotes where job_id=p_job;
 insert into quotes(job_id,builder_id,status,version,is_current) values(p_job,p_builder,'draft',next_version,false) returning id into fresh;
 if p_manual='retain' and old.id is not null then
  for item in select to_jsonb(l) from quote_line_items l where quote_id=old.id and pricing_source='manual' and variation_id is null loop
   insert into quote_line_items select (jsonb_populate_record(null::quote_line_items,item||jsonb_build_object('id',gen_random_uuid(),'quote_id',fresh))).*;
  end loop;
 end if;
 insert into document_processing_batches(job_id,builder_id,primary_file_id,status) values(p_job,p_builder,source_ids[1],'running') returning id into batch;
 insert into document_processing_jobs(parent_job_id,document_id) select batch,unnest(source_ids);
 insert into estimate_source_sets(id,builder_id,job_id,file_ids,previous_quote_id,draft_quote_id,batch_id,manual_policy,previous_items)
 values(p_request,p_builder,p_job,source_ids,old.id,fresh,batch,p_manual,coalesce((select jsonb_agg(to_jsonb(l)) from quote_line_items l where quote_id=old.id),'[]')) returning * into run;
 update files set processing_batch_id=batch,intake_status='processing',failure_reason=null,failure_stage=null where id=any(source_ids);
 perform enqueue_estimate_workflow(batch,p_builder);perform register_estimate_continuation(batch,p_builder);
 return to_jsonb(run);
end $$;
revoke all on function public.prepare_estimate_refresh(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_estimate_refresh(uuid,uuid,uuid,text) to service_role;

create function public.confirm_job_answer(p_builder uuid,p_job uuid,p_fact uuid,p_question text,p_answer text,p_evidence text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare old project_facts; fresh uuid; question text;
begin
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;if not found then raise exception 'Job not found';end if;
 if length(trim(p_answer))<1 or length(p_answer)>8000 then raise exception 'Enter a confirmed answer';end if;
 if p_fact is not null then
  select * into old from project_facts where id=p_fact and job_id=p_job and category='builder_answer' and not superseded for update;
  if not found then raise exception 'This answer changed. Reload before confirming';end if;
  question:=old.key;
  if old.value=p_answer then update project_facts set review_required=false,evidence=p_evidence where id=p_fact;fresh:=p_fact;
  else update project_facts set superseded=true where id=p_fact;end if;
 else question:=trim(p_question);if length(question)<1 or length(question)>2000 then raise exception 'Enter the question or fact name';end if;
 end if;
 if fresh is null then select id into fresh from project_facts where job_id=p_job and category='builder_answer' and key=question and value=p_answer and not superseded and not review_required order by id limit 1;end if;
 if fresh is null then
  update project_facts set superseded=true where job_id=p_job and category='builder_answer' and key=question and not superseded;
  insert into project_facts(job_id,category,key,value,evidence,confidence) values(p_job,'builder_answer',question,p_answer,p_evidence,100) returning id into fresh;
 end if;
 update jobs set profitability_revision=profitability_revision+1 where id=p_job;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'builder_answer_confirmed',question,jsonb_build_object('previous',to_jsonb(old),'fact_id',fresh,'answer',p_answer,'evidence',p_evidence));
 return fresh;
end $$;
revoke all on function public.confirm_job_answer(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.confirm_job_answer(uuid,uuid,uuid,text,text,text) to service_role;

create function public.clear_generated_estimate(p_builder uuid,p_job uuid,p_quote uuid)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
declare q quotes; snapshot jsonb;
begin
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;if not found then raise exception 'Job not found';end if;
 select * into q from quotes where id=p_quote and job_id=p_job and builder_id=p_builder for update;
 if not found or q.status not in ('draft','pending_review') then raise exception 'Only a draft estimate can be cleared';end if;
 if exists(select 1 from estimate_workflow w join document_processing_batches b on b.id=w.batch_id where b.job_id=p_job and w.state in ('queued','running')) then raise exception 'Finish or pause the processing run before clearing a draft';end if;
 if exists(select 1 from job_profitability_settings where job_id=p_job and baseline_quote_id=p_quote) then raise exception 'This estimate is the saved baseline and must be preserved';end if;
 select jsonb_agg(to_jsonb(l)) into snapshot from quote_line_items l where quote_id=p_quote and coalesce(pricing_source,'')<>'manual' and variation_id is null;
 insert into proof_events(builder_id,job_id,event_type,description,metadata) values(p_builder,p_job,'draft_estimate_cleared','Archived generated draft items; preserved plans, manual items and commercial records',jsonb_build_object('quote',to_jsonb(q),'items',coalesce(snapshot,'[]')));
 update assumptions set line_item_id=null where line_item_id in(select id from quote_line_items where quote_id=p_quote and coalesce(pricing_source,'')<>'manual' and variation_id is null);
 delete from quote_line_items where quote_id=p_quote and coalesce(pricing_source,'')<>'manual' and variation_id is null;
 update quotes set total_cost=null,confidence_score=null,qa_report=null where id=p_quote;
 update estimate_source_sets set cleared_at=now() where draft_quote_id=p_quote;
 update estimate_workflow set state='needs_attention' where batch_id in(select batch_id from estimate_source_sets where draft_quote_id=p_quote) and state<>'complete';
end $$;
revoke all on function public.clear_generated_estimate(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.clear_generated_estimate(uuid,uuid,uuid) to service_role;


-- Preserve credits through the existing audited correction route.
create or replace function public.correct_job_financial_record(p_builder uuid,p_job uuid,p_revision bigint,p_action text,p_id uuid,p_values jsonb,p_reason text)
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
   if v_amount is null or abs(v_amount)>999999999 or v_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter a valid amount';end if;
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


create function public.finalise_job_upload(p_builder uuid,p_job uuid,p_file uuid,p_hash text,p_size bigint)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare f files; original uuid;
begin
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;if not found then raise exception 'Job not found';end if;
 select * into f from files where id=p_file and job_id=p_job and builder_id=p_builder for update;if not found then raise exception 'File not found';end if;
 if f.drawing_state<>'unresolved' then return to_jsonb(f);end if;
 if p_hash !~ '^[0-9a-f]{64}$' or p_size<1 or p_size>52428800 then raise exception 'Invalid upload verification';end if;
 select id into original from files where job_id=p_job and builder_id=p_builder and id<>p_file and content_hash=p_hash and drawing_state<>'duplicate' order by created_at,id limit 1;
 update files set content_hash=p_hash,file_size_bytes=p_size,duplicate_of_file_id=original,drawing_state=case when original is null then 'unresolved' else 'duplicate' end where id=p_file returning * into f;
 return to_jsonb(f);
end $$;
revoke all on function public.finalise_job_upload(uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.finalise_job_upload(uuid,uuid,uuid,text,bigint) to service_role;
alter table public.files add column upload_client_key text;
create unique index files_upload_request on public.files(builder_id,job_id,upload_client_key) where upload_client_key is not null;

alter table public.variations add column issue_stage text not null default 'draft' check(issue_stage in ('draft','builder_approved','issued'));
alter table public.variations add column approval_evidence jsonb;
create function public.record_variation_decision(p_builder uuid,p_id uuid,p_action text,p_date date,p_evidence text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v variations; previous jsonb;
begin
 select * into v from variations where id=p_id and builder_id=p_builder;
 if not found then raise exception 'Variation not found';end if;
 perform 1 from jobs where id=v.job_id and builder_id=p_builder for update;
 if not found then raise exception 'Job not found';end if;
 select * into v from variations where id=p_id for update;previous:=to_jsonb(v);
 if p_action not in ('builder_approved','issued','approved','rejected') then raise exception 'Invalid decision';end if;
 if v.status in ('approved','rejected') then
  if v.status=p_action then return to_jsonb(v);end if;
  raise exception 'This decision is already final';
 end if;
 if p_action='builder_approved' then
  if v.issue_stage<>'draft' then return to_jsonb(v);end if;
  update variations set issue_stage='builder_approved' where id=p_id;
 else
  if p_date is null or p_date>(now() at time zone 'Australia/Sydney')::date or length(trim(coalesce(p_evidence,'')))<10 or length(p_evidence)>8000 then raise exception 'Record the actual date and supporting correspondence or evidence (10–8000 characters)';end if;
  if p_action='issued' then
   if v.issue_stage='draft' then raise exception 'Approve the variation for issue first';end if;
   if v.issue_stage='issued' then return to_jsonb(v);end if;
   update variations set issue_stage='issued',status='pending' where id=p_id;
  else
   if p_action='approved' and v.issue_stage<>'issued' and v.status<>'pending' then raise exception 'Record issue to the client before recording client approval';end if;
   update variations set status=p_action,approved_at=case when p_action='approved' then p_date::timestamptz else null end,approved_by=case when p_action='approved' then p_builder else null end,approval_evidence=jsonb_build_object('date',p_date,'evidence',p_evidence,'recorded_by',p_builder,'recorded_at',now()) where id=p_id;
  end if;
 end if;
 select * into v from variations where id=p_id;
 insert into proof_events(builder_id,job_id,event_type,description,metadata)values(p_builder,v.job_id,'client_decision','Variation '||p_action,jsonb_build_object('before',previous,'after',to_jsonb(v),'date',p_date,'evidence',p_evidence));
 return to_jsonb(v);
end $$;
revoke all on function public.record_variation_decision(uuid,uuid,text,date,text) from public,anon,authenticated;
grant execute on function public.record_variation_decision(uuid,uuid,text,date,text) to service_role;

create function public.apply_job_trade_quote(p_builder uuid,p_job uuid,p_record uuid,p_quote uuid,p_items uuid[],p_version integer)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare r job_workflow_records; anchor uuid; net numeric; snapshot jsonb;
begin
 perform 1 from jobs where id=p_job and builder_id=p_builder for update;if not found then raise exception 'Job not found';end if;
 select * into r from job_workflow_records where id=p_record and job_id=p_job and builder_id=p_builder and kind='trade_quote' and status='confirmed' for update;
 if not found then raise exception 'Confirm the accepted trade quote first';end if;
 if r.linked_id is not null then return r.linked_id;end if;
 if r.version<>p_version then raise exception 'Trade quote changed. Reload before applying';end if;
 perform 1 from quotes where id=p_quote and job_id=p_job and builder_id=p_builder and status in ('draft','pending_review') for update;
 if not found or exists(select 1 from job_profitability_settings where baseline_quote_id=p_quote) then raise exception 'Choose an editable draft; approved baselines are preserved';end if;
 if exists(select 1 from estimate_source_sets s join estimate_workflow w on w.batch_id=s.batch_id where s.draft_quote_id=p_quote and w.state in ('queued','running')) then raise exception 'Finish estimate processing before incorporating a trade quote';end if;
 if coalesce(cardinality(p_items),0)<1 or cardinality(p_items)>200 or nullif(r.payload->>'trade_id','') is null then raise exception 'Choose the trade and the draft items this quote replaces';end if;
 if exists(select 1 from unnest(p_items) selected(id) where not exists(select 1 from quote_line_items l where l.id=selected.id and l.quote_id=p_quote and l.trade_category_id=(r.payload->>'trade_id')::integer and l.variation_id is null)) then raise exception 'Choose only matching trade items from this draft';end if;
 select jsonb_agg(to_jsonb(l)) into snapshot from quote_line_items l where id=any(p_items);
 anchor:=p_items[1];net:=round((r.payload->>'source_amount')::numeric/case when r.payload->>'tax_basis'='inclusive' then 1.1 else 1 end,2);
 if net is null or net<0 or net>999999999 or net::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid accepted quote amount';end if;
 update quote_line_items set description=r.title||' (accepted quote)',quantity=1,unit='item',rate=net,total=net,pricing_source='manual',is_assumption=false,assumption_status=null where id=anchor;
 update quote_line_items set assumption_status='excluded' where id=any(p_items) and id<>anchor;
 update quotes set total_cost=(select case when count(*) filter(where total is null)>0 then null else sum(total) end from quote_line_items where quote_id=p_quote and coalesce(assumption_status,'')<>'excluded'),qa_report=null where id=p_quote;
 update job_workflow_records set linked_id=anchor,result=result||jsonb_build_object('applied_quote_id',p_quote,'replaced_items',snapshot),version=version+1,updated_at=now() where id=p_record;
 insert into proof_events(builder_id,job_id,event_type,description,metadata)values(p_builder,p_job,'cost_event','Builder incorporated accepted trade quote into draft',jsonb_build_object('record_id',p_record,'quote_id',p_quote,'anchor_item_id',anchor,'before',snapshot,'accepted_cost',net));
 update jobs set profitability_revision=profitability_revision+1 where id=p_job;
 return anchor;
end $$;
revoke all on function public.apply_job_trade_quote(uuid,uuid,uuid,uuid,uuid[],integer) from public,anon,authenticated;
grant execute on function public.apply_job_trade_quote(uuid,uuid,uuid,uuid,uuid[],integer) to service_role;
