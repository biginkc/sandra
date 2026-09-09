-- Move the existing inner CAS off the request URL. The predicates and
-- update values are identical to the former PostgREST PATCH.
CREATE OR REPLACE FUNCTION public.claim_skip_trace_submission(
  p_job_id uuid,
  p_org_id uuid,
  p_property_ids text[],
  p_input_params jsonb,
  p_claim_time timestamptz,
  p_expected_heartbeat timestamptz
)
RETURNS TABLE (id uuid, title text, description text)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE public.jobs AS j
  SET status = 'running',
      started_at = p_claim_time,
      total_items = cardinality(p_property_ids),
      input_params = p_input_params,
      worker_heartbeat_at = p_claim_time
  WHERE j.id = p_job_id
    AND j.org_id = p_org_id
    AND j.type = 'skip_trace'
    AND j.status = 'queued'
    AND j.total_items = cardinality(p_property_ids)
    AND j.input_params @> jsonb_build_object('property_ids', to_jsonb(p_property_ids))
    AND j.provider_run_id IS NULL
    AND j.worker_heartbeat_at IS NOT DISTINCT FROM p_expected_heartbeat
  RETURNING j.id, j.title, j.description;
$$;

REVOKE ALL ON FUNCTION public.claim_skip_trace_submission(uuid, uuid, text[], jsonb, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_skip_trace_submission(uuid, uuid, text[], jsonb, timestamptz, timestamptz) TO service_role;
