-- A dispatcher lock is not proof that a worker owns execution. Claim once
-- at the worker boundary, with an opaque owner and a lease longer than the
-- hosted worker's maximum invocation lifetime. No existing job is resumed.
CREATE TABLE public.estimation_execution_leases (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  token uuid NOT NULL,
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.estimation_execution_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.estimation_execution_leases FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.estimation_execution_leases TO service_role;

CREATE FUNCTION public.claim_estimation_execution(p_job_id uuid, p_file_id uuid, p_builder_id uuid, p_token uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE claimed uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.files f JOIN public.jobs j ON j.id=f.job_id
    WHERE f.id=p_file_id AND j.id=p_job_id AND f.builder_id=p_builder_id AND j.builder_id=p_builder_id)
  THEN RAISE EXCEPTION 'Invalid estimation ownership'; END IF;
  INSERT INTO public.estimation_execution_leases(job_id, token, file_id, expires_at)
  VALUES (p_job_id, p_token, p_file_id, clock_timestamp() + interval '10 minutes')
  ON CONFLICT (job_id) DO UPDATE SET token=excluded.token, file_id=excluded.file_id, expires_at=excluded.expires_at
  WHERE estimation_execution_leases.expires_at < clock_timestamp()
  RETURNING token INTO claimed;
  IF claimed IS NOT NULL THEN
    INSERT INTO public.job_intake_locks(job_id,file_id,started_at,last_progress_at)
    VALUES(p_job_id,p_file_id,clock_timestamp(),clock_timestamp())
    ON CONFLICT(job_id) DO UPDATE SET file_id=excluded.file_id,started_at=excluded.started_at,last_progress_at=excluded.last_progress_at;
  END IF;
  RETURN claimed IS NOT NULL;
END;
$$;
CREATE FUNCTION public.release_estimation_execution(p_job_id uuid, p_token uuid)
RETURNS void LANGUAGE sql SET search_path = public, pg_temp AS $$
  DELETE FROM public.job_intake_locks l USING public.estimation_execution_leases e
  WHERE l.job_id=p_job_id AND e.job_id=l.job_id AND e.token=p_token AND l.file_id=e.file_id;
  DELETE FROM public.estimation_execution_leases WHERE job_id=p_job_id AND token=p_token;
$$;
REVOKE ALL ON FUNCTION public.claim_estimation_execution(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.release_estimation_execution(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_estimation_execution(uuid,uuid,uuid,uuid) TO service_role,postgres;
GRANT EXECUTE ON FUNCTION public.release_estimation_execution(uuid,uuid) TO service_role,postgres;

-- Membership lives in document_processing_jobs. processing_batch_id on
-- files is only set for the SSE anchor and is not a document manifest.
CREATE OR REPLACE FUNCTION compute_document_coverage(p_batch_id uuid)
RETURNS estimate_document_coverage AS $$
DECLARE
  v_uploaded     integer;
  v_contributing jsonb;
  v_missing      jsonb;
  v_analyzed     integer;
  v_coverage_pct numeric;
  v_confidence   text;
  v_result       estimate_document_coverage;
BEGIN
  SELECT count(*) INTO v_uploaded FROM files f WHERE EXISTS (SELECT 1 FROM document_processing_jobs j WHERE j.parent_job_id=p_batch_id AND j.document_id=f.id);

  SELECT jsonb_agg(jsonb_build_object(
      'file_id', f.id, 'filename', f.filename, 'document_type', pd.document_type
    ) ORDER BY f.filename)
    INTO v_contributing
    FROM files f
    JOIN project_documents pd ON pd.file_id = f.id
    WHERE EXISTS (SELECT 1 FROM document_processing_jobs j WHERE j.parent_job_id=p_batch_id AND j.document_id=f.id) AND pd.extraction_status = 'complete';

  -- A document counts as "missing" whenever Stage 1/2 has not durably
  -- recorded it complete — whether that's because it genuinely failed
  -- (files.intake_status derived to 'failed', migration 052) or simply
  -- hasn't been attempted/finished yet. Both are equally true today: the
  -- builder doesn't yet know an estimate exists, so "why" matters less
  -- than "which documents".
  SELECT jsonb_agg(jsonb_build_object(
      'file_id', f.id, 'filename', f.filename,
      'status', CASE WHEN f.intake_status = 'failed' THEN 'failed' ELSE 'pending' END
    ) ORDER BY f.filename)
    INTO v_missing
    FROM files f
    WHERE EXISTS (SELECT 1 FROM document_processing_jobs j WHERE j.parent_job_id=p_batch_id AND j.document_id=f.id)
      AND NOT EXISTS (
        SELECT 1 FROM project_documents pd
        WHERE pd.file_id = f.id AND pd.extraction_status = 'complete'
      );

  v_analyzed := COALESCE(jsonb_array_length(v_contributing), 0);
  v_coverage_pct := CASE WHEN v_uploaded = 0 THEN 0 ELSE round(100.0 * v_analyzed / v_uploaded, 1) END;

  -- Confidence tier is coverage-only (deliberately distinct from
  -- builder_status below, which also folds in missing-trade/assumption
  -- signals) — a plain, honest answer to "how much of what I uploaded did
  -- WorkA actually read", independent of how the estimate downstream of
  -- that turned out. Thresholds (70 / 30) are not derived from production
  -- telemetry — none exists yet for this specific signal — they're picked
  -- to match the SAME two thresholds compute_builder_status uses below, so
  -- confidence_level and builder_status never visually disagree for the
  -- same coverage number. Revisit both together once real usage data
  -- exists (same posture CLAUDE.md documents for the 0.93 embedding
  -- de-duplication threshold: a stated, reviewable starting point, not a
  -- claimed-optimal constant).
  v_confidence := CASE
    WHEN v_coverage_pct >= 70 THEN 'high'
    WHEN v_coverage_pct >= 30 THEN 'medium'
    ELSE 'low'
  END;

  v_result.documents_uploaded := v_uploaded;
  v_result.documents_analyzed := v_analyzed;
  v_result.documents_failed_or_pending := v_uploaded - v_analyzed;
  v_result.coverage_percentage := v_coverage_pct;
  v_result.confidence_level := v_confidence;
  v_result.contributing_documents := COALESCE(v_contributing, '[]'::jsonb);
  v_result.missing_documents := COALESCE(v_missing, '[]'::jsonb);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;
NOTIFY pgrst, 'reload schema';

CREATE OR REPLACE FUNCTION public.recompute_file_intake_status(p_file_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE
  v_job document_processing_jobs%ROWTYPE;
  v_batch document_processing_batches%ROWTYPE;
  v_new_status text;
BEGIN
  SELECT * INTO v_job FROM document_processing_jobs WHERE document_id=p_file_id ORDER BY created_at DESC LIMIT 1;
  IF v_job.id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_batch FROM document_processing_batches WHERE id=v_job.parent_job_id;
  IF v_job.status='failed' THEN v_new_status:='failed';
  ELSIF v_job.status IN ('pending','running') THEN v_new_status:='processing';
  ELSE
    v_new_status:=CASE
      WHEN v_batch.quote_id IS NOT NULL THEN 'extracted'
      WHEN v_batch.stall_stage='AI_PROCESSING_BLOCKED' AND p_file_id<>v_batch.primary_file_id THEN 'uploaded'
      WHEN v_batch.status='failed' THEN 'failed'
      ELSE 'processing' END;
  END IF;
  UPDATE files SET intake_status=v_new_status WHERE id=p_file_id;
  RETURN v_new_status;
END;
$$;
