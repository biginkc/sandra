-- Canonical session subset modeled from schema-only deployed evidence; no Auth/JWT service claim.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
DO $$ BEGIN IF to_regclass('auth.sessions') IS NULL THEN RAISE EXCEPTION 'Canonical fixture sessions subset missing';END IF;END $$;
CREATE TABLE inbox_t2_bridge.access_epochs(user_id uuid PRIMARY KEY,revision bigint NOT NULL CHECK(revision>0));
CREATE FUNCTION inbox_t2_bridge.capture_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed boolean:=true;users uuid[];u uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='sessions' THEN changed:=(OLD.id,OLD.user_id,OLD.not_after) IS DISTINCT FROM (NEW.id,NEW.user_id,NEW.not_after);
  ELSE changed:=(OLD.id,OLD.org_id,OLD.user_id,OLD.role,OLD.access_status,OLD.access_expires_at,OLD.deletion_prepared_at,OLD.deletion_operation_id,OLD.hugo_config,OLD.acquisitions_enabled) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.user_id,NEW.role,NEW.access_status,NEW.access_expires_at,NEW.deletion_prepared_at,NEW.deletion_operation_id,NEW.hugo_config,NEW.acquisitions_enabled);END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 users:=CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.user_id] WHEN 'DELETE' THEN ARRAY[OLD.user_id] ELSE ARRAY[OLD.user_id,NEW.user_id] END;
 FOR u IN SELECT DISTINCT value FROM unnest(users) value ORDER BY 1 LOOP
  INSERT INTO inbox_t2_bridge.access_epochs VALUES(u,1) ON CONFLICT(user_id) DO UPDATE SET revision=inbox_t2_bridge.access_epochs.revision+1;
 END LOOP;RETURN NULL;
END $$;
CREATE TRIGGER zzzzzzz_inbox_t2_access AFTER INSERT OR UPDATE OR DELETE ON public.memberships FOR EACH ROW EXECUTE FUNCTION inbox_t2_bridge.capture_access();
CREATE TRIGGER zzzzzzz_inbox_t2_access AFTER INSERT OR UPDATE OR DELETE ON auth.sessions FOR EACH ROW EXECUTE FUNCTION inbox_t2_bridge.capture_access();
CREATE FUNCTION inbox_t2_bridge.authorize(o uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid();j jsonb:=auth.jwt();sid uuid;session_expiry timestamptz;claim_expiry timestamptz;membership jsonb;n integer;epoch bigint;expiry timestamptz;session_found boolean;checked_at timestamptz;
BEGIN
 IF u IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR jsonb_typeof(j->'session_id') IS DISTINCT FROM 'string' OR (j->>'session_id')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(j->>'exp','')!~'^[0-9]{1,12}$' THEN RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';END IF;
 sid:=(j->>'session_id')::uuid;claim_expiry:=to_timestamp((j->>'exp')::double precision);
 IF claim_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 checked_at:=clock_timestamp();
 -- One SQL snapshot supplies session, global membership count, selected row and epoch.
 -- Never combine a prior count with a later row/epoch after a concurrent membership commit.
 WITH active AS MATERIALIZED (
  SELECT m.org_id,m.access_expires_at FROM public.memberships m
  WHERE m.user_id=u AND m.access_status='active' AND m.deletion_prepared_at IS NULL
   AND (m.access_expires_at IS NULL OR m.access_expires_at>checked_at)
 ), membership_state AS (
  SELECT count(*)::integer AS total,jsonb_agg(to_jsonb(active)) AS rows FROM active
 )
 SELECT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=sid AND s.user_id=u),
  (SELECT s.not_after FROM auth.sessions s WHERE s.id=sid AND s.user_id=u),
  ms.total,ms.rows->0,(SELECT revision FROM inbox_t2_bridge.access_epochs WHERE user_id=u)
 INTO session_found,session_expiry,n,membership,epoch FROM membership_state ms;
 IF NOT session_found OR session_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_REVOKED' USING ERRCODE='42501';END IF;
 IF n<>1 THEN RAISE EXCEPTION 'INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING' USING ERRCODE='42501';END IF;
 IF o IS NOT NULL AND (membership->>'org_id')::uuid IS DISTINCT FROM o THEN RAISE EXCEPTION 'INBOX_ORG_DENIED' USING ERRCODE='42501';END IF;
 IF epoch IS NULL THEN RAISE EXCEPTION 'INBOX_ACCESS_BASELINE_MISSING' USING ERRCODE='42501';END IF;
 expiry:=least(claim_expiry,session_expiry,(membership->>'access_expires_at')::timestamptz);
 IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('user_id',u,'session_id',sid,'org_id',(membership->>'org_id')::uuid,'access_epoch',epoch::text,'expires_at',expiry,'session_active',true,'active_membership_count',n);
END $$;
ALTER TABLE inbox_t2_bridge.access_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_bridge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_bridge FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
