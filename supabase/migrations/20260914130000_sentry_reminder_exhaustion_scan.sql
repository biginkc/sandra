-- A bounded, fair observer cursor. This changes no reminder delivery state.
CREATE TABLE public.sentry_reminder_exhaustion_scan_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_id uuid
);
INSERT INTO public.sentry_reminder_exhaustion_scan_cursor (singleton) VALUES (true);
ALTER TABLE public.sentry_reminder_exhaustion_scan_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sentry_reminder_exhaustion_scan_cursor FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sentry_reminder_exhaustion_scan_cursor TO service_role;

CREATE INDEX task_reminder_deliveries_exhausted_scan_idx
  ON public.task_reminder_deliveries (id)
  WHERE status = 'failed' AND attempts >= 3;

CREATE FUNCTION public.scan_exhausted_reminder_deliveries(p_limit integer DEFAULT 4)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cursor uuid;
  v_id uuid;
  v_count integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION 'invalid reminder observer page size';
  END IF;
  SELECT last_id INTO v_cursor
  FROM public.sentry_reminder_exhaustion_scan_cursor
  WHERE singleton = true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reminder observer cursor missing'; END IF;

  FOR v_id IN
    SELECT id FROM public.task_reminder_deliveries
    WHERE status = 'failed' AND attempts >= 3
      AND (v_cursor IS NULL OR id > v_cursor)
    ORDER BY id LIMIT p_limit
  LOOP
    v_count := v_count + 1;
    RETURN NEXT v_id;
  END LOOP;

  -- Wrap the keyset in the same invocation so a small active set is
  -- repeatedly observed, while every larger set is eventually visited.
  IF v_count < p_limit AND v_cursor IS NOT NULL THEN
    FOR v_id IN
      SELECT id FROM public.task_reminder_deliveries
      WHERE status = 'failed' AND attempts >= 3 AND id <= v_cursor
      ORDER BY id LIMIT (p_limit - v_count)
    LOOP
      v_count := v_count + 1;
      RETURN NEXT v_id;
    END LOOP;
  END IF;

  IF v_count > 0 THEN
    UPDATE public.sentry_reminder_exhaustion_scan_cursor SET last_id = v_id
    WHERE singleton = true;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.scan_exhausted_reminder_deliveries(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scan_exhausted_reminder_deliveries(integer)
  TO service_role;
