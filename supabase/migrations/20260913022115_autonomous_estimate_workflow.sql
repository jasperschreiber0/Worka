-- Opt-in orchestration. No existing batch is resumed by this migration.
CREATE TABLE public.estimating_access (
 builder_id uuid PRIMARY KEY REFERENCES public.builders(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 max_attempts integer NOT NULL DEFAULT 40 CHECK(max_attempts BETWEEN 1 AND 80),
 max_cost_cents integer NOT NULL DEFAULT 1000 CHECK(max_cost_cents BETWEEN 1 AND 3000)
);
CREATE TABLE public.estimate_workflow (
 batch_id uuid PRIMARY KEY REFERENCES public.document_processing_batches(id) ON DELETE CASCADE,
 builder_id uuid NOT NULL REFERENCES public.builders(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','paused_budget','paused_daily','paused_service','needs_attention','complete')),
 attempt_limit integer NOT NULL CHECK(attempt_limit BETWEEN 1 AND 80),
 cost_limit_cents integer NOT NULL CHECK(cost_limit_cents BETWEEN 1 AND 3000),
 reserved_cents numeric NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 dispatch_count integer NOT NULL DEFAULT 0,
 reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.estimate_attempt_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES public.estimate_workflow(batch_id) ON DELETE CASCADE,
 builder_id uuid NOT NULL REFERENCES public.builders(id) ON DELETE CASCADE,
 day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 reserved_cents numeric NOT NULL CHECK(reserved_cents > 0),
 settled boolean NOT NULL DEFAULT false
);
CREATE INDEX ON public.estimate_attempt_reservations(day,builder_id) WHERE NOT settled;
CREATE TABLE public.estimate_workflow_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES public.document_processing_batches(id) ON DELETE CASCADE,
 event text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.estimating_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estimate_workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estimate_attempt_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estimate_workflow_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.estimating_access,public.estimate_workflow,public.estimate_attempt_reservations,public.estimate_workflow_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.estimating_access,public.estimate_workflow,public.estimate_attempt_reservations,public.estimate_workflow_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.estimate_workflow_events_id_seq TO service_role;

CREATE FUNCTION public.enqueue_estimate_workflow(p_batch_id uuid,p_builder_id uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE a estimating_access; b document_processing_batches; docs integer;
BEGIN
 SELECT * INTO a FROM estimating_access WHERE builder_id=p_builder_id AND enabled;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO b FROM document_processing_batches WHERE id=p_batch_id AND builder_id=p_builder_id;
 IF NOT FOUND OR b.quote_id IS NOT NULL THEN RETURN false; END IF;
 SELECT count(*) INTO docs FROM document_processing_jobs WHERE parent_job_id=p_batch_id;
 INSERT INTO estimate_workflow(batch_id,builder_id,attempt_limit,cost_limit_cents)
 VALUES(p_batch_id,p_builder_id,least(a.max_attempts,greatest(20,14+docs*3)),least(a.max_cost_cents,750))
 ON CONFLICT(batch_id) DO NOTHING;
 RETURN true;
END $$;

-- Replaces increment-then-reject with reserve-before-increment. Ordinary
-- batch exhaustion never alters the global circuit breaker.
CREATE OR REPLACE FUNCTION public.increment_batch_ai_attempts(p_batch_id uuid,p_max_attempts integer DEFAULT 20)
RETURNS TABLE(attempts integer,exceeded boolean) LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_max_attempts < 1 OR p_max_attempts > 80 THEN RAISE EXCEPTION 'Invalid attempt allowance'; END IF;
 SELECT total_ai_call_attempts INTO n FROM document_processing_batches WHERE id=p_batch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown estimate batch'; END IF;
 IF n >= p_max_attempts THEN RETURN QUERY SELECT n,true; RETURN; END IF;
 UPDATE document_processing_batches SET total_ai_call_attempts=total_ai_call_attempts+1 WHERE id=p_batch_id RETURNING total_ai_call_attempts INTO n;
 RETURN QUERY SELECT n,false;
END $$;

CREATE FUNCTION public.reserve_estimate_attempt(p_batch_id uuid,p_cost_cents numeric)
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

CREATE FUNCTION public.resume_estimate_workflow(p_batch_id uuid,p_builder_id uuid,p_extend boolean DEFAULT false)
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
 RETURN jsonb_build_object('state','queued');
END $$;

CREATE FUNCTION public.claim_estimate_continuations()
RETURNS TABLE(batch_id uuid,builder_id uuid) LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE estimate_workflow SET state='needs_attention',reason='Repeated dispatches did not finish this estimate; saved work needs review.' WHERE dispatch_count>=80 AND state IN ('queued','running');
 RETURN QUERY WITH due AS (
 SELECT w.batch_id FROM estimate_workflow w JOIN estimating_access a ON a.builder_id=w.builder_id AND a.enabled
 JOIN document_processing_batches b ON b.id=w.batch_id
 WHERE w.dispatch_count<80 AND w.state IN ('queued','running') AND w.next_attempt_at<=now() AND b.quote_id IS NULL
 AND w.batch_id=(SELECT w2.batch_id FROM estimate_workflow w2 WHERE w2.builder_id=w.builder_id AND w2.state IN ('queued','running') AND w2.next_attempt_at<=now() ORDER BY w2.next_attempt_at,w2.batch_id LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM estimation_execution_leases e JOIN jobs j ON j.id=e.job_id WHERE j.builder_id=w.builder_id AND e.expires_at>now())
 ORDER BY w.next_attempt_at LIMIT 5 FOR UPDATE OF w SKIP LOCKED
 ) UPDATE estimate_workflow w SET next_attempt_at=now()+interval '1 minute',dispatch_count=dispatch_count+1
 FROM due WHERE w.batch_id=due.batch_id RETURNING w.batch_id,w.builder_id;
END $$;

CREATE FUNCTION public.trigger_estimate_continuations()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,vault,net AS $$
DECLARE u text; s text;
BEGIN
 SELECT decrypted_secret INTO u FROM vault.decrypted_secrets WHERE name='worka_app_url';
 SELECT decrypted_secret INTO s FROM vault.decrypted_secrets WHERE name='worka_cron_secret';
 IF u IS NULL OR s IS NULL THEN RAISE WARNING 'Estimate scheduler configuration missing'; RETURN; END IF;
 PERFORM net.http_get(url:=u||'/api/cron/estimate-continuations',headers:=jsonb_build_object('Authorization','Bearer '||s),timeout_milliseconds:=30000);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_estimate_workflow(uuid,uuid),public.increment_batch_ai_attempts(uuid,integer),public.reserve_estimate_attempt(uuid,numeric),public.resume_estimate_workflow(uuid,uuid,boolean),public.claim_estimate_continuations(),public.trigger_estimate_continuations() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_estimate_workflow(uuid,uuid),public.increment_batch_ai_attempts(uuid,integer),public.reserve_estimate_attempt(uuid,numeric),public.resume_estimate_workflow(uuid,uuid,boolean),public.claim_estimate_continuations(),public.trigger_estimate_continuations() TO service_role,postgres;
-- Deliberately schedule only after the matching application endpoint is deployed.
NOTIFY pgrst,'reload schema';

CREATE TABLE public.builder_confirmed_rates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),builder_id uuid NOT NULL REFERENCES public.builders(id) ON DELETE CASCADE,
 source_item_id uuid REFERENCES public.quote_line_items(id) ON DELETE SET NULL,
 description text NOT NULL,trade_category_id integer NOT NULL CHECK(trade_category_id BETWEEN 1 AND 13),
 unit text NOT NULL,rate numeric NOT NULL CHECK(rate>0),state text,
 active boolean NOT NULL DEFAULT true,confirmed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(builder_id,description,trade_category_id,unit)
);
ALTER TABLE public.builder_confirmed_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_confirmed_rates FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.builder_confirmed_rates TO service_role;
CREATE TABLE public.builder_rate_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,builder_id uuid NOT NULL REFERENCES public.builders(id) ON DELETE CASCADE,
 rate_id uuid REFERENCES public.builder_confirmed_rates(id) ON DELETE SET NULL,
 action text NOT NULL, snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.builder_rate_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.builder_rate_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.builder_rate_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.builder_rate_events_id_seq TO service_role;
CREATE FUNCTION public.save_confirmed_builder_rate(p_builder_id uuid,p_item_id uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE i quote_line_items; result_id uuid; region text;
BEGIN
 SELECT l.* INTO i FROM quote_line_items l JOIN quotes q ON q.id=l.quote_id WHERE l.id=p_item_id AND q.builder_id=p_builder_id FOR UPDATE OF l;
 IF NOT FOUND THEN RAISE EXCEPTION 'Item not found'; END IF;
 IF i.pricing_type<>'measured' OR i.pricing_source<>'manual' OR i.rate IS NULL OR i.rate<=0 OR i.quantity IS NULL OR i.quantity<=0 OR nullif(trim(i.unit),'') IS NULL OR i.assumption_status IN ('excluded','unresolved') OR i.rate='NaN'::numeric OR i.quantity='NaN'::numeric THEN RAISE EXCEPTION 'Save a confirmed measured unit price first; allowances cannot teach a unit rate'; END IF;
 SELECT state INTO region FROM builders WHERE id=p_builder_id;
 INSERT INTO builder_confirmed_rates(builder_id,source_item_id,description,trade_category_id,unit,rate,state)
 VALUES(p_builder_id,i.id,lower(trim(i.description)),i.trade_category_id,lower(trim(i.unit)),i.rate,region)
 ON CONFLICT(builder_id,description,trade_category_id,unit) DO UPDATE SET source_item_id=excluded.source_item_id,rate=excluded.rate,state=excluded.state,active=true,confirmed_at=now() RETURNING id INTO result_id;
 INSERT INTO builder_rate_events(builder_id,rate_id,action,snapshot) VALUES(p_builder_id,result_id,'confirmed',to_jsonb(i));
 RETURN result_id;
END $$;
REVOKE ALL ON FUNCTION public.save_confirmed_builder_rate(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_confirmed_builder_rate(uuid,uuid) TO service_role,postgres;

CREATE OR REPLACE FUNCTION public.claim_estimation_execution(p_job_id uuid,p_file_id uuid,p_builder_id uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE claimed uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_builder_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM files f JOIN jobs j ON j.id=f.job_id WHERE f.id=p_file_id AND j.id=p_job_id AND f.builder_id=p_builder_id AND j.builder_id=p_builder_id) THEN RAISE EXCEPTION 'Invalid estimation ownership'; END IF;
 IF EXISTS(SELECT 1 FROM estimation_execution_leases e JOIN jobs j ON j.id=e.job_id WHERE j.builder_id=p_builder_id AND e.expires_at>clock_timestamp()) THEN RETURN false; END IF;
 INSERT INTO estimation_execution_leases(job_id,token,file_id,expires_at) VALUES(p_job_id,p_token,p_file_id,clock_timestamp()+interval '10 minutes')
 ON CONFLICT(job_id) DO UPDATE SET token=excluded.token,file_id=excluded.file_id,expires_at=excluded.expires_at WHERE estimation_execution_leases.expires_at<clock_timestamp() RETURNING token INTO claimed;
 IF claimed IS NOT NULL THEN
 INSERT INTO job_intake_locks(job_id,file_id,started_at,last_progress_at) VALUES(p_job_id,p_file_id,clock_timestamp(),clock_timestamp())
 ON CONFLICT(job_id) DO UPDATE SET file_id=excluded.file_id,started_at=excluded.started_at,last_progress_at=excluded.last_progress_at;
 END IF;
 RETURN claimed IS NOT NULL;
END $$;
CREATE FUNCTION public.settle_estimate_reservation(p_reservation_id uuid,p_actual_cents numeric)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r estimate_attempt_reservations;
BEGIN
 PERFORM pg_advisory_xact_lock(918273);
 SELECT * INTO r FROM estimate_attempt_reservations WHERE id=p_reservation_id AND NOT settled FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF p_actual_cents IS NULL OR p_actual_cents<0 THEN RAISE EXCEPTION 'Invalid usage'; END IF;
 UPDATE estimate_workflow SET reserved_cents=greatest(0,reserved_cents-r.reserved_cents+p_actual_cents) WHERE batch_id=r.batch_id;
 UPDATE estimate_attempt_reservations SET settled=true WHERE id=r.id;
END $$;
REVOKE ALL ON FUNCTION public.settle_estimate_reservation(uuid,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_estimate_reservation(uuid,numeric) TO service_role,postgres;

ALTER TABLE public.quote_line_items ADD COLUMN review_state text CHECK(review_state IN ('awaiting_quote','reviewed'));
CREATE TABLE public.estimate_review_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,item_id uuid REFERENCES public.quote_line_items(id) ON DELETE SET NULL,builder_id uuid NOT NULL REFERENCES public.builders(id) ON DELETE CASCADE,action text NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.estimate_review_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.estimate_review_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.estimate_review_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.estimate_review_events_id_seq TO service_role;
CREATE FUNCTION public.review_estimate_item(p_builder_id uuid,p_item_id uuid,p_action text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE i quote_line_items;
BEGIN
 SELECT l.* INTO i FROM quote_line_items l JOIN quotes q ON q.id=l.quote_id WHERE l.id=p_item_id AND q.builder_id=p_builder_id AND q.status IN ('draft','pending_review') FOR UPDATE OF l,q;
 IF NOT FOUND THEN RAISE EXCEPTION 'Editable item not found'; END IF;
 IF p_action NOT IN ('reviewed','awaiting_quote') THEN RAISE EXCEPTION 'Invalid review action'; END IF;
 IF p_action='reviewed' AND (i.total IS NULL OR i.total<=0 OR i.total='NaN'::numeric OR (i.pricing_type='measured' AND (i.quantity IS NULL OR i.quantity<=0 OR i.rate IS NULL OR i.rate<=0 OR abs(i.quantity*i.rate-i.total)>0.01))) THEN RAISE EXCEPTION 'Resolve missing prices, quantities and total errors before confirming'; END IF;
 INSERT INTO estimate_review_events(item_id,builder_id,action,snapshot) VALUES(i.id,p_builder_id,p_action,to_jsonb(i));
 UPDATE quote_line_items SET review_state=p_action,is_assumption=true,assumption_status=CASE WHEN p_action='reviewed' THEN 'accepted' ELSE 'unresolved' END WHERE id=i.id;
END $$;
REVOKE ALL ON FUNCTION public.review_estimate_item(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_estimate_item(uuid,uuid,text) TO service_role,postgres;
CREATE FUNCTION public.invalidate_estimate_item_review() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (new.description,new.quantity,new.unit,new.rate,new.total,new.pricing_type) IS DISTINCT FROM (old.description,old.quantity,old.unit,old.rate,old.total,old.pricing_type) THEN
 new.review_state:=null;
 IF old.review_state='reviewed' AND old.is_assumption THEN new.assumption_status:='unresolved'; END IF;
 END IF; RETURN new;
END $$;
REVOKE ALL ON FUNCTION public.invalidate_estimate_item_review() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER invalidate_estimate_item_review BEFORE UPDATE ON public.quote_line_items FOR EACH ROW EXECUTE FUNCTION public.invalidate_estimate_item_review();
CREATE FUNCTION public.retire_confirmed_builder_rate(p_builder_id uuid,p_rate_id uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r builder_confirmed_rates;
BEGIN
 UPDATE builder_confirmed_rates SET active=false WHERE id=p_rate_id AND builder_id=p_builder_id AND active RETURNING * INTO r;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO builder_rate_events(builder_id,rate_id,action,snapshot) VALUES(p_builder_id,r.id,'retired',to_jsonb(r));RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.retire_confirmed_builder_rate(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retire_confirmed_builder_rate(uuid,uuid) TO service_role,postgres;

CREATE TABLE public.estimate_upload_receipts(upload_batch_id uuid NOT NULL,builder_id uuid NOT NULL REFERENCES public.builders(id) ON DELETE CASCADE,batch_id uuid NOT NULL REFERENCES public.document_processing_batches(id) ON DELETE CASCADE,PRIMARY KEY(upload_batch_id,builder_id));
ALTER TABLE public.estimate_upload_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.estimate_upload_receipts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.estimate_upload_receipts TO service_role;
CREATE FUNCTION public.start_estimate_upload(p_builder_id uuid,p_job_id uuid,p_upload_batch_id uuid,p_files uuid[])
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE existing uuid; b uuid; n integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_builder_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=p_job_id AND builder_id=p_builder_id) THEN RAISE EXCEPTION 'Job not found'; END IF;
 IF NOT EXISTS(SELECT 1 FROM estimating_access WHERE builder_id=p_builder_id AND enabled) THEN RAISE EXCEPTION 'Estimating is not enabled for this account'; END IF;
 SELECT batch_id INTO existing FROM estimate_upload_receipts WHERE upload_batch_id=p_upload_batch_id AND builder_id=p_builder_id;
 IF existing IS NOT NULL THEN RETURN existing; END IF;
 IF coalesce(cardinality(p_files),0)<1 OR cardinality(p_files)>30 THEN RAISE EXCEPTION 'Choose between 1 and 30 documents'; END IF;
 SELECT count(*) INTO n FROM files f WHERE f.id=ANY(p_files) AND f.job_id=p_job_id AND f.builder_id=p_builder_id AND f.upload_batch_id=p_upload_batch_id AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='plans' AND o.name=f.storage_path);
 IF n<>cardinality(p_files) THEN RAISE EXCEPTION 'Some documents are missing, duplicated or not owned by this job'; END IF;
 INSERT INTO document_processing_batches(job_id,builder_id,primary_file_id,status) VALUES(p_job_id,p_builder_id,p_files[1],'running') RETURNING id INTO b;
 INSERT INTO document_processing_jobs(parent_job_id,document_id) SELECT b,unnest(p_files);
 UPDATE files SET processing_batch_id=b WHERE id=ANY(p_files);
 INSERT INTO estimate_upload_receipts VALUES(p_upload_batch_id,p_builder_id,b);
 PERFORM enqueue_estimate_workflow(b,p_builder_id);
 PERFORM recompute_batch_file_intake_statuses(b);
 RETURN b;
END $$;
REVOKE ALL ON FUNCTION public.start_estimate_upload(uuid,uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_estimate_upload(uuid,uuid,uuid,uuid[]) TO service_role,postgres;
