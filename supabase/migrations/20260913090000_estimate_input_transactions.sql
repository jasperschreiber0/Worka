-- Depends on autonomous_estimate_workflow. Server-only transactional review operations.
CREATE FUNCTION public.refresh_estimate_totals(p_quote_id uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE n numeric; priced numeric; reliable numeric; amount numeric; allowances numeric; confidence numeric;
BEGIN
 PERFORM 1 FROM quotes WHERE id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
 SELECT count(*),count(total),count(*) FILTER(WHERE pricing_source IN ('document_selection','cost_rates_exact','cost_rates_normalized','document','builder_rate','network_rate')),coalesce(sum(total),0),coalesce(sum(total) FILTER(WHERE pricing_source='ai_allowance'),0),coalesce(min(l.confidence),0)
 INTO n,priced,reliable,amount,allowances,confidence FROM quote_line_items l WHERE quote_id=p_quote_id AND assumption_status IS DISTINCT FROM 'excluded';
 UPDATE quotes SET total_cost=round(amount,2),confidence_score=confidence,price_coverage_pct=CASE WHEN n=0 THEN 100 ELSE round(100*priced/n,2) END,pricing_match_rate_pct=CASE WHEN n=0 THEN 100 ELSE round(100*reliable/n,2) END,allowance_pct=CASE WHEN amount<=0 THEN 0 ELSE round(100*allowances/amount,2) END,margin_pct=coalesce(margin_pct,18) WHERE id=p_quote_id;
END $$;
REVOKE ALL ON FUNCTION public.refresh_estimate_totals(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_estimate_totals(uuid) TO service_role,postgres;

CREATE FUNCTION public.save_estimate_input(p_builder_id uuid,p_quote_id uuid,p_item_id uuid,p_expected jsonb,p_patch jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE i quote_line_items; v quote_line_items; k text; complete boolean;
BEGIN
 PERFORM 1 FROM quotes WHERE id=p_quote_id AND builder_id=p_builder_id AND status IN ('draft','pending_review') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Editable quote not found'; END IF;
 SELECT * INTO i FROM quote_line_items WHERE id=p_item_id AND quote_id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Line item not found'; END IF;
 IF NOT (to_jsonb(i) @> p_expected) THEN RAISE EXCEPTION 'Item changed. Refresh before saving.' USING ERRCODE='40001'; END IF;
 FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
 IF k NOT IN ('description','trade_category_id','quantity','unit','rate','total','predicted_by','confidence','pricing_source','pricing_basis','assumption_status') THEN RAISE EXCEPTION 'Invalid edit field'; END IF;
 END LOOP;
 v:=jsonb_populate_record(i,p_patch);
 IF nullif(trim(v.description),'') IS NULL OR (v.quantity IS NOT NULL AND (v.quantity<=0 OR v.quantity::text IN ('NaN','Infinity','-Infinity'))) OR (v.rate IS NOT NULL AND (v.rate<=0 OR v.rate::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Invalid description, quantity or rate'; END IF;
 IF p_patch ? 'rate' THEN
 v.total:=CASE WHEN v.rate IS NULL THEN null WHEN v.pricing_type IN ('pc_allowance','provisional_sum') THEN v.rate WHEN v.quantity IS NOT NULL THEN round(v.quantity*v.rate,2) ELSE null END;
 END IF;
 complete:=v.total IS NOT NULL AND v.total>0 AND v.total::text NOT IN ('NaN','Infinity','-Infinity') AND (v.pricing_type<>'measured' OR (v.quantity>0 AND v.rate>0 AND nullif(trim(v.unit),'') IS NOT NULL AND v.total=round(v.quantity*v.rate,2)));
 INSERT INTO estimate_review_events(item_id,builder_id,action,snapshot) VALUES(i.id,p_builder_id,'save_input',to_jsonb(i));
 UPDATE quote_line_items SET description=v.description,trade_category_id=v.trade_category_id,quantity=v.quantity,unit=v.unit,rate=v.rate,total=v.total,predicted_by=v.predicted_by,confidence=v.confidence,pricing_source=v.pricing_source,pricing_basis=v.pricing_basis,assumption_status=v.assumption_status WHERE id=i.id;
 -- A separate status update follows invalidation in this same transaction.
 IF p_patch ? 'rate' AND v.assumption_status IS DISTINCT FROM 'excluded' THEN
 UPDATE quote_line_items SET review_state=CASE WHEN complete THEN 'reviewed' ELSE null END,assumption_status=CASE WHEN complete THEN 'adjusted' ELSE 'unresolved' END,is_assumption=CASE WHEN complete THEN is_assumption ELSE true END WHERE id=i.id;
 END IF;
 PERFORM refresh_estimate_totals(p_quote_id);
END $$;
REVOKE ALL ON FUNCTION public.save_estimate_input(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_estimate_input(uuid,uuid,uuid,jsonb,jsonb) TO service_role,postgres;

CREATE TABLE public.estimate_answer_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),builder_id uuid NOT NULL REFERENCES builders(id),question_id uuid NOT NULL REFERENCES clarifying_questions(id),answer text NOT NULL,previous_answer text,assumption_id uuid REFERENCES assumptions(id),created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE estimate_answer_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON estimate_answer_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON estimate_answer_events TO service_role;
ALTER TABLE clarifying_questions ADD COLUMN answer_review_id uuid REFERENCES assumptions(id);
CREATE FUNCTION public.save_estimate_answer(p_builder_id uuid,p_job_id uuid,p_question_id uuid,p_answer text,p_previous text) RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q clarifying_questions; quote_id_value uuid; review_id uuid;
BEGIN
 PERFORM 1 FROM jobs WHERE id=p_job_id AND builder_id=p_builder_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
 SELECT * INTO q FROM clarifying_questions WHERE id=p_question_id AND job_id=p_job_id AND NOT blocking FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Question not found'; END IF;
 IF p_answer IS NULL OR length(trim(p_answer)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'Invalid answer'; END IF;
 p_answer:=trim(p_answer);
 IF q.status='answered' AND q.answer=p_answer THEN RETURN q.answer_review_id; END IF;
 IF q.answer IS DISTINCT FROM p_previous THEN RAISE EXCEPTION 'Answer changed. Refresh before saving.' USING ERRCODE='40001'; END IF;
 SELECT id INTO quote_id_value FROM quotes WHERE job_id=p_job_id AND is_current AND status IN ('draft','pending_review') ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
 IF quote_id_value IS NULL THEN RAISE EXCEPTION 'A saved editable estimate is needed before answering here'; END IF;
 -- Preserve old answers as superseded facts, not training rates.
 UPDATE project_facts SET superseded=true WHERE job_id=p_job_id AND category='builder_answer' AND key=q.question AND NOT superseded;
 INSERT INTO project_facts(job_id,category,key,value,evidence,confidence) VALUES(p_job_id,'builder_answer',q.question,p_answer,'Builder answer saved from Money; estimate impact requires review.',100);
 IF q.answer_review_id IS NOT NULL THEN
 UPDATE assumptions SET resolution_type='adjusted',resolved_at=now(),resolved_by=p_builder_id::text WHERE id=q.answer_review_id AND resolution_type IS NULL;
 END IF;
 INSERT INTO assumptions(quote_id,description,assumed_value,reason,trade_category_id) VALUES(quote_id_value,'Review builder answer: '||q.question,p_answer,'Check affected scope and prices before confirming this answer has been reflected in the estimate.',q.trade_category_id) RETURNING id INTO review_id;
 INSERT INTO estimate_answer_events(builder_id,question_id,answer,previous_answer,assumption_id) VALUES(p_builder_id,q.id,p_answer,q.answer,review_id);
 UPDATE clarifying_questions SET answer=p_answer,status='answered',answered_at=now(),answer_review_id=review_id WHERE id=q.id;
 RETURN review_id;
END $$;
REVOKE ALL ON FUNCTION public.save_estimate_answer(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_estimate_answer(uuid,uuid,uuid,text,text) TO service_role,postgres;
