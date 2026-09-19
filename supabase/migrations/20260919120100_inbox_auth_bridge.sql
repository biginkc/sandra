BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION inbox_bridge.authorize(o uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=auth.uid();j jsonb:=auth.jwt();sid uuid;session_expiry timestamptz;claim_expiry timestamptz;membership jsonb;n integer;epoch bigint;expiry timestamptz;session_found boolean;checked_at timestamptz;
BEGIN
 IF u IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR jsonb_typeof(j->'session_id') IS DISTINCT FROM 'string' OR (j->>'session_id')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(j->>'exp','')!~'^[0-9]{1,12}$' THEN RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';END IF;
 sid:=(j->>'session_id')::uuid;claim_expiry:=to_timestamp((j->>'exp')::double precision);
 IF claim_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 checked_at:=clock_timestamp();
 -- One SQL snapshot supplies session, global membership count, selected row and epoch.
 -- Never combine a prior count with a later row/epoch after a concurrent membership commit.
 WITH active AS MATERIALIZED (
  SELECT m.org_id,m.access_expires_at,m.role,m.acquisitions_enabled FROM public.memberships m
  WHERE m.user_id=u AND m.access_status='active' AND m.deletion_prepared_at IS NULL
   AND (m.access_expires_at IS NULL OR m.access_expires_at>checked_at)
 ), membership_state AS (
  SELECT count(*)::integer AS total,jsonb_agg(to_jsonb(active)) AS rows FROM active
 )
 SELECT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=sid AND s.user_id=u),
  (SELECT s.not_after FROM auth.sessions s WHERE s.id=sid AND s.user_id=u),
  ms.total,ms.rows->0,(SELECT revision FROM inbox_bridge.access_epochs WHERE user_id=u)
 INTO session_found,session_expiry,n,membership,epoch FROM membership_state ms;
 IF NOT session_found OR session_expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_REVOKED' USING ERRCODE='42501';END IF;
 IF n<>1 THEN RAISE EXCEPTION 'INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING' USING ERRCODE='42501';END IF;
 IF o IS NOT NULL AND (membership->>'org_id')::uuid IS DISTINCT FROM o THEN RAISE EXCEPTION 'INBOX_ORG_DENIED' USING ERRCODE='42501';END IF;
 -- Keep direct Inbox RPCs behind the same shared-workspace boundary as the
 -- page/API gate: owners retain access, while active Acquisitions members
 -- are scoped to My Leads. This stays in the authorization snapshot so a
 -- SECURITY DEFINER wrapper cannot bypass the HTTP surface check.
 IF (membership->>'role')='member' AND (membership->>'acquisitions_enabled')::boolean IS TRUE THEN RAISE EXCEPTION 'INBOX_SHARED_SURFACE_DENIED' USING ERRCODE='42501';END IF;
 IF epoch IS NULL THEN RAISE EXCEPTION 'INBOX_ACCESS_BASELINE_MISSING' USING ERRCODE='42501';END IF;
 expiry:=least(claim_expiry,session_expiry,(membership->>'access_expires_at')::timestamptz);
 IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('user_id',u,'session_id',sid,'org_id',(membership->>'org_id')::uuid,'access_epoch',epoch::text,'expires_at',expiry,'session_active',true,'active_membership_count',n);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
