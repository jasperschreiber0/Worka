-- Only a newly requested/resumed batch receives a continuation timer.
-- Existing estimates are neither enrolled nor resumed by this migration.
ALTER TABLE public.estimate_workflow ADD COLUMN auto_continue boolean NOT NULL DEFAULT false,
 ADD COLUMN deadline_at timestamptz;
ALTER TABLE public.estimate_workflow DROP CONSTRAINT estimate_workflow_state_check;
ALTER TABLE public.estimate_workflow ADD CONSTRAINT estimate_workflow_state_check CHECK(state IN ('queued','running','paused_budget','paused_daily','paused_service','paused_timeout','needs_attention','complete'));

CREATE FUNCTION public.stop_estimate_continuation(p_batch_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,cron AS $$
DECLARE task bigint;
BEGIN
 UPDATE public.estimate_workflow SET auto_continue=false WHERE batch_id=p_batch_id;
 FOR task IN SELECT jobid FROM cron.job WHERE jobname='worka-estimate-'||p_batch_id::text LOOP
  PERFORM cron.unschedule(task);
 END LOOP;
END $$;

CREATE FUNCTION public.trigger_estimate_continuation(p_batch_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,vault,net,cron AS $$
DECLARE w public.estimate_workflow; u text; secret text;
BEGIN
 SELECT * INTO w FROM public.estimate_workflow WHERE batch_id=p_batch_id FOR UPDATE;
 IF NOT FOUND THEN PERFORM public.stop_estimate_continuation(p_batch_id); RETURN; END IF;
 IF NOT w.auto_continue OR w.state NOT IN ('queued','running') OR NOT EXISTS(SELECT 1 FROM public.estimating_access WHERE builder_id=w.builder_id AND enabled) THEN
  PERFORM public.stop_estimate_continuation(p_batch_id); RETURN;
 END IF;
 IF w.deadline_at IS NULL OR clock_timestamp()>=w.deadline_at THEN
  UPDATE public.estimate_workflow SET state='paused_timeout',reason='The five-minute processing window has ended. Your progress is saved. Review it or resume this estimate.',updated_at=now() WHERE batch_id=p_batch_id;
  PERFORM public.stop_estimate_continuation(p_batch_id); RETURN;
 END IF;
 SELECT decrypted_secret INTO u FROM vault.decrypted_secrets WHERE name='worka_app_url';
 SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name='worka_cron_secret';
 IF u IS NULL OR secret IS NULL THEN RAISE EXCEPTION 'Estimate continuation configuration unavailable'; END IF;
 PERFORM net.http_get(url:=rtrim(u,'/')||'/api/cron/estimate-continuations?batch_id='||p_batch_id::text,headers:=jsonb_build_object('Authorization','Bearer '||secret),timeout_milliseconds:=15000);
END $$;

CREATE FUNCTION public.register_estimate_continuation(p_batch_id uuid,p_builder_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,cron,vault AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.estimate_workflow w JOIN public.estimating_access a ON a.builder_id=w.builder_id AND a.enabled WHERE w.batch_id=p_batch_id AND w.builder_id=p_builder_id AND w.state IN ('queued','running')) THEN RAISE EXCEPTION 'Active owned estimate not found'; END IF;
 IF (SELECT count(*) FROM vault.decrypted_secrets WHERE name IN ('worka_app_url','worka_cron_secret') AND decrypted_secret IS NOT NULL)<>2 THEN RAISE EXCEPTION 'Estimate continuation configuration unavailable'; END IF;
 UPDATE public.estimate_workflow SET auto_continue=true,deadline_at=clock_timestamp()+interval '5 minutes',next_attempt_at=now(),updated_at=now() WHERE batch_id=p_batch_id AND builder_id=p_builder_id;
 PERFORM cron.schedule('worka-estimate-'||p_batch_id::text,'* * * * *',format('SELECT public.trigger_estimate_continuation(%L::uuid)',p_batch_id));
END $$;

CREATE FUNCTION public.claim_estimate_continuation(p_batch_id uuid)
RETURNS TABLE(batch_id uuid,builder_id uuid) LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE w public.estimate_workflow;
BEGIN
 SELECT * INTO w FROM public.estimate_workflow ew WHERE ew.batch_id=p_batch_id FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR NOT w.auto_continue OR w.state NOT IN ('queued','running') OR w.deadline_at IS NULL OR clock_timestamp()>=w.deadline_at THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.estimating_access a WHERE a.builder_id=w.builder_id AND a.enabled) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM public.document_processing_batches b WHERE b.id=p_batch_id AND b.quote_id IS NOT NULL) THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM public.estimation_execution_leases e JOIN public.jobs j ON j.id=e.job_id WHERE j.builder_id=w.builder_id AND e.expires_at>clock_timestamp()) THEN RETURN; END IF;
 IF w.next_attempt_at>clock_timestamp() OR w.dispatch_count>=80 THEN RETURN; END IF;
 UPDATE public.estimate_workflow ew SET dispatch_count=ew.dispatch_count+1,next_attempt_at=now()+interval '1 minute' WHERE ew.batch_id=p_batch_id;
 RETURN QUERY SELECT p_batch_id,w.builder_id;
END $$;
REVOKE ALL ON FUNCTION public.stop_estimate_continuation(uuid),public.trigger_estimate_continuation(uuid),public.register_estimate_continuation(uuid,uuid),public.claim_estimate_continuation(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stop_estimate_continuation(uuid),public.trigger_estimate_continuation(uuid),public.register_estimate_continuation(uuid,uuid),public.claim_estimate_continuation(uuid) TO service_role,postgres;

CREATE OR REPLACE FUNCTION public.reserve_estimate_attempt(p_batch_id uuid,p_cost_cents numeric)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE w estimate_workflow; a estimating_access; n integer; g numeric; d numeric; lim jsonb; r uuid; pause text;
BEGIN
 IF p_cost_cents IS NULL OR p_cost_cents<=0 OR p_cost_cents>3000 THEN RAISE EXCEPTION 'Invalid cost reservation'; END IF;
 -- Same lock for all estimate reservations closes concurrent daily overspend.
 PERFORM pg_advisory_xact_lock(918273);
 SELECT * INTO w FROM estimate_workflow WHERE batch_id=p_batch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workflow not enrolled'; END IF;
 SELECT * INTO a FROM estimating_access WHERE builder_id=w.builder_id AND enabled;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','Estimating is not enabled for this account'); END IF;
 IF w.state NOT IN ('queued','running') THEN RETURN jsonb_build_object('allowed',false,'reason',coalesce(w.reason,'Estimate is paused')); END IF;
 IF w.deadline_at IS NOT NULL AND clock_timestamp()>=w.deadline_at THEN
 UPDATE estimate_workflow SET state='paused_timeout',reason='The five-minute processing window has ended. Your progress is saved.',updated_at=now() WHERE batch_id=p_batch_id;
 RETURN jsonb_build_object('allowed',false,'reason','paused_timeout');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM system_status WHERE key='ai_circuit_breaker' AND value->>'tripped'='false') THEN RETURN jsonb_build_object('allowed',false,'reason','AI service protection is active'); END IF;
 SELECT value INTO lim FROM system_status WHERE key='ai_limits';
 IF lim IS NULL THEN RAISE EXCEPTION 'Daily limits unavailable'; END IF;
 SELECT coalesce(sum(cost_cents),0) INTO g FROM ai_spend_daily WHERE day=(now() AT TIME ZONE 'UTC')::date AND builder_id IS NULL;
 SELECT coalesce(sum(cost_cents),0) INTO d FROM ai_spend_daily WHERE day=(now() AT TIME ZONE 'UTC')::date AND builder_id=w.builder_id;
 g:=g+(SELECT coalesce(sum(reserved_cents),0) FROM estimate_attempt_reservations WHERE day=(now() AT TIME ZONE 'UTC')::date AND NOT settled);
 d:=d+(SELECT coalesce(sum(reserved_cents),0) FROM estimate_attempt_reservations WHERE day=(now() AT TIME ZONE 'UTC')::date AND builder_id=w.builder_id AND NOT settled);
 SELECT total_ai_call_attempts INTO n FROM document_processing_batches WHERE id=p_batch_id FOR UPDATE;
 IF n>=least(w.attempt_limit,a.max_attempts) OR w.reserved_cents+p_cost_cents>least(w.cost_limit_cents,a.max_cost_cents) THEN pause:='paused_budget';
 ELSIF g+p_cost_cents>coalesce((lim->>'global_daily_cents')::numeric,0) OR d+p_cost_cents>coalesce((lim->>'builder_daily_cents')::numeric,0) THEN pause:='paused_daily'; END IF;
 IF pause IS NOT NULL THEN
 UPDATE estimate_workflow SET state=pause,reason=CASE WHEN pause='paused_budget' THEN 'Processing allowance reached. Saved progress is safe.' ELSE 'Daily processing allowance reached. Saved progress is safe.' END,updated_at=now() WHERE batch_id=p_batch_id;
 INSERT INTO estimate_workflow_events(batch_id,event,detail) VALUES(p_batch_id,pause,jsonb_build_object('attempts',n));
 RETURN jsonb_build_object('allowed',false,'reason',pause);
 END IF;
 UPDATE document_processing_batches SET total_ai_call_attempts=total_ai_call_attempts+1 WHERE id=p_batch_id;
 UPDATE estimate_workflow SET reserved_cents=reserved_cents+p_cost_cents,state='running',updated_at=now() WHERE batch_id=p_batch_id;
 INSERT INTO estimate_attempt_reservations(batch_id,builder_id,reserved_cents) VALUES(p_batch_id,w.builder_id,p_cost_cents) RETURNING id INTO r;
 RETURN jsonb_build_object('allowed',true,'reservation_id',r);
END $$;
CREATE OR REPLACE FUNCTION public.resume_estimate_workflow(p_batch_id uuid,p_builder_id uuid,p_extend boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE w estimate_workflow; a estimating_access;
BEGIN
 SELECT * INTO a FROM estimating_access WHERE builder_id=p_builder_id AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'Estimating is not enabled'; END IF;
 SELECT * INTO w FROM estimate_workflow WHERE batch_id=p_batch_id AND builder_id=p_builder_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Estimate not found'; END IF;
 IF w.state='paused_service' AND NOT EXISTS(SELECT 1 FROM system_status WHERE key='ai_circuit_breaker' AND value->>'tripped'='false') THEN RAISE EXCEPTION 'Service protection is still active'; END IF;
 IF w.state='complete' THEN RETURN jsonb_build_object('state','complete'); END IF;
 IF w.state='needs_attention' THEN RAISE EXCEPTION 'Resolve the recorded processing error before retrying'; END IF;
 IF w.state='paused_budget' THEN
 IF NOT p_extend OR (w.attempt_limit>=a.max_attempts AND w.cost_limit_cents>=a.max_cost_cents) THEN RAISE EXCEPTION 'Account processing allowance reached'; END IF;
 UPDATE estimate_workflow SET attempt_limit=least(attempt_limit+10,a.max_attempts),cost_limit_cents=least(cost_limit_cents+250,a.max_cost_cents) WHERE batch_id=p_batch_id;
 END IF;
 UPDATE estimate_workflow SET state='queued',next_attempt_at=now(),reason=null,updated_at=now() WHERE batch_id=p_batch_id;
 INSERT INTO estimate_workflow_events(batch_id,event,detail) VALUES(p_batch_id,'builder_resume',jsonb_build_object('extended',p_extend));
 PERFORM public.register_estimate_continuation(p_batch_id,p_builder_id);
 RETURN jsonb_build_object('state','queued');
END $$;
CREATE OR REPLACE FUNCTION public.start_estimate_upload(p_builder_id uuid,p_job_id uuid,p_upload_batch_id uuid,p_files uuid[])
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE existing uuid; b uuid; n integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_builder_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=p_job_id AND builder_id=p_builder_id) THEN RAISE EXCEPTION 'Job not found'; END IF;
 IF NOT EXISTS(SELECT 1 FROM estimating_access WHERE builder_id=p_builder_id AND enabled) THEN RAISE EXCEPTION 'Estimating is not enabled for this account'; END IF;
 SELECT batch_id INTO existing FROM estimate_upload_receipts WHERE upload_batch_id=p_upload_batch_id AND builder_id=p_builder_id;
 IF existing IS NOT NULL THEN
 IF NOT EXISTS(SELECT 1 FROM document_processing_batches WHERE id=existing AND job_id=p_job_id AND builder_id=p_builder_id) THEN RAISE EXCEPTION 'Upload belongs to another job'; END IF;
 RETURN existing; END IF;
 IF coalesce(cardinality(p_files),0)<1 OR cardinality(p_files)>30 THEN RAISE EXCEPTION 'Choose between 1 and 30 documents'; END IF;
 SELECT count(*) INTO n FROM files f WHERE f.id=ANY(p_files) AND f.job_id=p_job_id AND f.builder_id=p_builder_id AND f.upload_batch_id=p_upload_batch_id AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='plans' AND o.name=f.storage_path);
 IF n<>cardinality(p_files) THEN RAISE EXCEPTION 'Some documents are missing, duplicated or not owned by this job'; END IF;
 INSERT INTO document_processing_batches(job_id,builder_id,primary_file_id,status) VALUES(p_job_id,p_builder_id,p_files[1],'running') RETURNING id INTO b;
 INSERT INTO document_processing_jobs(parent_job_id,document_id) SELECT b,unnest(p_files);
 UPDATE files SET processing_batch_id=b WHERE id=ANY(p_files);
 INSERT INTO estimate_upload_receipts VALUES(p_upload_batch_id,p_builder_id,b);
 PERFORM enqueue_estimate_workflow(b,p_builder_id);
 PERFORM recompute_batch_file_intake_statuses(b);
 PERFORM public.register_estimate_continuation(b,p_builder_id);
 RETURN b;
END $$;
