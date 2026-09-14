-- Candidate operational primitives. No API activation or scheduling side effect.
CREATE TABLE inbox_control.baseline_progress(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),stage text NOT NULL DEFAULT 'memberships' CHECK(stage IN ('memberships','organizations','done')),cursor uuid);
INSERT INTO inbox_control.baseline_progress(singleton) VALUES(true);
ALTER TABLE inbox_control.baseline_progress ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION inbox_control.seed_baseline_batch(p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE state inbox_control.baseline_progress%ROWTYPE;ids uuid[];u uuid;o uuid;n integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN RAISE EXCEPTION 'Invalid baseline batch limit';END IF;
 SELECT * INTO STRICT state FROM inbox_control.baseline_progress WHERE singleton FOR UPDATE;
 IF state.stage='done' THEN RETURN jsonb_build_object('stage','done','rows',0);END IF;
 IF state.stage='memberships' THEN
  SELECT array_agg(user_id ORDER BY user_id) INTO ids FROM(SELECT DISTINCT user_id FROM public.memberships WHERE state.cursor IS NULL OR user_id>state.cursor ORDER BY user_id LIMIT p_limit)s;
  FOREACH u IN ARRAY coalesce(ids,'{}'::uuid[]) LOOP
   INSERT INTO inbox_bridge.access_epochs(user_id,revision) VALUES(u,1) ON CONFLICT DO NOTHING;
  END LOOP;
 ELSE
  SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.organizations WHERE state.cursor IS NULL OR id>state.cursor ORDER BY id LIMIT p_limit)s;
  FOREACH o IN ARRAY coalesce(ids,'{}'::uuid[]) LOOP
   IF NOT EXISTS(SELECT 1 FROM inbox_backfill.jobs WHERE org_id=o) THEN PERFORM inbox_backfill.start(o);END IF;
  END LOOP;
 END IF;
 n:=coalesce(cardinality(ids),0);
 UPDATE inbox_control.baseline_progress SET stage=CASE WHEN n=p_limit THEN state.stage WHEN state.stage='memberships' THEN 'organizations' ELSE 'done' END,cursor=CASE WHEN n=p_limit THEN ids[n] END WHERE singleton;
 RETURN jsonb_build_object('stage',state.stage,'rows',n);
END $$;
CREATE FUNCTION inbox_control.wake_due_expiries(p_limit integer DEFAULT 100) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record;n integer:=0;at_time timestamptz:=clock_timestamp();
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid expiry limit';END IF;
 FOR r IN SELECT org_id,target_kind,target_id,revision FROM inbox_maintained.rows WHERE next_expiry<=at_time ORDER BY next_expiry,org_id,target_kind,target_id LIMIT p_limit LOOP
  PERFORM inbox_maintained.wake_expiry(r.org_id,r.target_kind,r.target_id,r.revision,at_time);n:=n+1;
 END LOOP;
 RETURN n;
END $$;
CREATE FUNCTION inbox_control.readiness() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('serving_enabled',(SELECT serving_enabled FROM inbox_control.rollout WHERE singleton),
 'baseline_done',(SELECT stage='done' FROM inbox_control.baseline_progress WHERE singleton),
 'backfill_pending',EXISTS(SELECT 1 FROM inbox_backfill.jobs WHERE stream<>'done'),
 'queue_pending',EXISTS(SELECT 1 FROM inbox_maintained.queue),
 'parent_pending',EXISTS(SELECT 1 FROM inbox_parent.work WHERE generation>ack),
 'collisions_unresolved',EXISTS(SELECT 1 FROM inbox_backfill.collisions WHERE generation>ack OR duplicate_thread_ids IS NOT NULL),
 'due_expiry',EXISTS(SELECT 1 FROM inbox_maintained.rows WHERE next_expiry<=statement_timestamp()));
$$;
-- Runtime grants must name a separately reviewed worker role. Browser/service roles cannot drive these helpers.
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_control FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_control FROM PUBLIC,anon,authenticated,service_role;
-- Operations and read owners confirm no runtime/FK dependency on expired worksets.
-- Never apply this policy to operation, read-boundary, provider or safety receipts.
CREATE INDEX inbox_workset_expiry ON inbox_bridge.worksets(expires_at,id);
CREATE INDEX inbox_cursor_scope ON inbox_bridge.cursors(scope_id);
CREATE FUNCTION inbox_control.prune_expired_worksets(p_limit integer DEFAULT 100,p_retention_seconds integer DEFAULT 604800) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r record;n integer:=0;cutoff timestamptz;cursor_budget integer:=1000;removed integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 OR p_retention_seconds IS NULL OR p_retention_seconds<86400 OR p_retention_seconds>2592000 THEN RAISE EXCEPTION 'Invalid retention bounds';END IF;
 cutoff:=clock_timestamp()-make_interval(secs=>p_retention_seconds);
 FOR r IN SELECT id FROM inbox_bridge.worksets WHERE expires_at<cutoff ORDER BY expires_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  -- Bound physical deletion work as well as selected worksets. The worker caller
  -- must also set a statement timeout; SQL-local timeout changes do not restart
  -- the current statement timer. A cursor-heavy scope resumes on the next call.
  WITH candidates AS (SELECT id FROM inbox_bridge.cursors WHERE scope_id=r.id LIMIT cursor_budget)
  DELETE FROM inbox_bridge.cursors c USING candidates d WHERE c.id=d.id;
  GET DIAGNOSTICS removed=ROW_COUNT;cursor_budget:=cursor_budget-removed;
  IF NOT EXISTS(SELECT 1 FROM inbox_bridge.cursors WHERE scope_id=r.id) THEN
   DELETE FROM inbox_bridge.worksets WHERE id=r.id;n:=n+1;
  END IF;
  IF cursor_budget=0 THEN EXIT;END IF;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION inbox_control.prune_expired_worksets(integer,integer) FROM PUBLIC,anon,authenticated,service_role;
