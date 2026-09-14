-- Durable, service-role-only claim ledger for observational Sentry signals.
-- This never changes the underlying job or provider recovery state.
CREATE TABLE public.sentry_anomaly_ledger (
  signal_kind text NOT NULL CHECK (length(signal_kind) BETWEEN 1 AND 80),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 128),
  is_active boolean NOT NULL,
  first_detected_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_emit_at timestamptz,
  recovered_at timestamptz,
  claim_token uuid,
  claim_kind text CHECK (claim_kind IN ('new', 'repeat', 'recovered')),
  claim_expires_at timestamptz,
  PRIMARY KEY (signal_kind, source_id)
);

CREATE INDEX sentry_anomaly_ledger_active_kind_idx
  ON public.sentry_anomaly_ledger (signal_kind, last_observed_at)
  WHERE is_active;

ALTER TABLE public.sentry_anomaly_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sentry_anomaly_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sentry_anomaly_ledger TO service_role;

CREATE FUNCTION public.observe_sentry_anomaly(
  p_signal_kind text,
  p_source_id text,
  p_is_active boolean,
  p_observed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sentry_anomaly_ledger%ROWTYPE;
  v_kind text;
  v_token uuid;
BEGIN
  IF p_signal_kind IS NULL OR length(p_signal_kind) NOT BETWEEN 1 AND 80
    OR p_source_id IS NULL OR length(p_source_id) NOT BETWEEN 1 AND 128
    OR p_is_active IS NULL OR p_observed_at IS NULL THEN
    RAISE EXCEPTION 'invalid anomaly observation';
  END IF;

  -- The unique key serializes competing first observers. No event is marked
  -- emitted until the caller confirms a successful SDK flush via ack RPC.
  IF p_is_active THEN
    INSERT INTO public.sentry_anomaly_ledger AS ledger (
      signal_kind, source_id, is_active, first_detected_at,
      last_observed_at, claim_token, claim_kind, claim_expires_at
    ) VALUES (
      p_signal_kind, p_source_id, false, p_observed_at,
      p_observed_at, pg_catalog.gen_random_uuid(), 'new',
      p_observed_at + interval '2 minutes'
    ) ON CONFLICT (signal_kind, source_id) DO NOTHING;
    IF FOUND THEN
      SELECT claim_token INTO v_token FROM public.sentry_anomaly_ledger
      WHERE signal_kind = p_signal_kind AND source_id = p_source_id;
      RETURN pg_catalog.jsonb_build_object('decision', 'new', 'claim_token', v_token);
    END IF;
  END IF;

  SELECT * INTO v_row FROM public.sentry_anomaly_ledger
  WHERE signal_kind = p_signal_kind AND source_id = p_source_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('decision', 'absent');
  END IF;

  -- Ignore stale observations to keep a delayed cron from resurrecting or
  -- recovering a newer state.
  IF p_observed_at < v_row.last_observed_at THEN
    RETURN pg_catalog.jsonb_build_object('decision', 'suppressed');
  END IF;

  IF NOT p_is_active AND NOT v_row.is_active THEN
    -- A new anomaly disappeared before successful delivery; there is no
    -- previously emitted incident to recover.
    UPDATE public.sentry_anomaly_ledger SET
      last_observed_at = p_observed_at, claim_token = NULL,
      claim_kind = NULL, claim_expires_at = NULL
    WHERE signal_kind = p_signal_kind AND source_id = p_source_id;
    RETURN pg_catalog.jsonb_build_object('decision', 'absent');
  END IF;

  IF v_row.claim_token IS NOT NULL AND v_row.claim_expires_at > p_observed_at THEN
    UPDATE public.sentry_anomaly_ledger SET last_observed_at = p_observed_at
    WHERE signal_kind = p_signal_kind AND source_id = p_source_id;
    RETURN pg_catalog.jsonb_build_object('decision', 'suppressed');
  END IF;

  IF NOT p_is_active THEN
    v_kind := 'recovered';
  ELSIF NOT v_row.is_active THEN
    v_kind := 'new';
  ELSIF v_row.last_emit_at IS NULL OR p_observed_at >= v_row.last_emit_at + interval '1 hour' THEN
    v_kind := 'repeat';
  ELSE
    UPDATE public.sentry_anomaly_ledger SET last_observed_at = p_observed_at
    WHERE signal_kind = p_signal_kind AND source_id = p_source_id;
    RETURN pg_catalog.jsonb_build_object('decision', 'suppressed');
  END IF;

  v_token := pg_catalog.gen_random_uuid();
  UPDATE public.sentry_anomaly_ledger SET
    last_observed_at = p_observed_at,
    first_detected_at = CASE WHEN v_kind = 'new' THEN p_observed_at ELSE first_detected_at END,
    claim_token = v_token,
    claim_kind = v_kind,
    claim_expires_at = p_observed_at + interval '2 minutes'
  WHERE signal_kind = p_signal_kind AND source_id = p_source_id;
  RETURN pg_catalog.jsonb_build_object('decision', v_kind, 'claim_token', v_token);
END;
$$;

CREATE FUNCTION public.ack_sentry_anomaly(
  p_signal_kind text,
  p_source_id text,
  p_claim_token uuid,
  p_delivered boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.sentry_anomaly_ledger%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.sentry_anomaly_ledger
  WHERE signal_kind = p_signal_kind AND source_id = p_source_id
  FOR UPDATE;
  IF NOT FOUND OR v_row.claim_token IS DISTINCT FROM p_claim_token
    OR p_delivered IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.sentry_anomaly_ledger SET
    is_active = CASE WHEN p_delivered THEN v_row.claim_kind <> 'recovered' ELSE is_active END,
    last_emit_at = CASE WHEN p_delivered THEN pg_catalog.now() ELSE last_emit_at END,
    recovered_at = CASE WHEN p_delivered AND v_row.claim_kind = 'recovered'
      THEN pg_catalog.now() WHEN p_delivered AND v_row.claim_kind = 'new'
      THEN NULL ELSE recovered_at END,
    claim_token = NULL, claim_kind = NULL, claim_expires_at = NULL
  WHERE signal_kind = p_signal_kind AND source_id = p_source_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.observe_sentry_anomaly(text, text, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_sentry_anomaly(text, text, boolean, timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.ack_sentry_anomaly(text, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_sentry_anomaly(text, text, uuid, boolean)
  TO service_role;
