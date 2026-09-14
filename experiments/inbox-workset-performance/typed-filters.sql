-- Owned-fixture typed filter implementation; never apply as a production migration.
BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') OR current_user<>'postgres' THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE TABLE inbox_t2_bridge.filter_rows(
 org_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,revision bigint NOT NULL,
 latest_at timestamptz,contact_id uuid,has_recent boolean NOT NULL,is_noise boolean NOT NULL,
 assignable boolean NOT NULL,assigned_user_id uuid,unread boolean,escalated boolean NOT NULL,
 needs_outcome boolean NOT NULL,review boolean NOT NULL,unknown_active boolean NOT NULL,unknown_dismissed boolean NOT NULL,
 PRIMARY KEY(org_id,target_kind,target_id)
);
ALTER TABLE inbox_t2_bridge.filter_rows ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION inbox_t2_bridge.upsert_filter(o uuid,k text,id uuid,v bigint,s jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF (s->>'exists')::boolean IS DISTINCT FROM true THEN DELETE FROM inbox_t2_bridge.filter_rows WHERE org_id=o AND target_kind=k AND target_id=id;RETURN;END IF;
 INSERT INTO inbox_t2_bridge.filter_rows VALUES(o,k,id,v,
 (CASE WHEN k='unknown_sender' THEN s->>'latest_at' ELSE s->>'last_message_at' END)::timestamptz,
 (s->>'contact_id')::uuid,coalesce((s->>'has_recent')::boolean,false),coalesce((s->>'is_noise')::boolean,false),
 coalesce(s->>'property_status'<>'prospect',false),(s->>'assigned_user_id')::uuid,
 CASE WHEN k='unknown_sender' THEN NULL ELSE coalesce((s->>'unread_count')::bigint,0)>0 END,
 coalesce(s->>'ai_responder_status'='escalated',false),coalesce((s->>'needs_outcome')::boolean,false),
 s->>'ai_disposition_review_id' IS NOT NULL AND NOT coalesce((s->>'is_test_traffic')::boolean,false),
 coalesce((s->>'visible_unknown')::boolean,false),coalesce((s->>'visible_dismissed')::boolean,false))
 ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET revision=excluded.revision,latest_at=excluded.latest_at,contact_id=excluded.contact_id,
 has_recent=excluded.has_recent,is_noise=excluded.is_noise,assignable=excluded.assignable,assigned_user_id=excluded.assigned_user_id,unread=excluded.unread,
 escalated=excluded.escalated,needs_outcome=excluded.needs_outcome,review=excluded.review,unknown_active=excluded.unknown_active,unknown_dismissed=excluded.unknown_dismissed
 WHERE inbox_t2_bridge.filter_rows.revision<excluded.revision;
END $$;
CREATE FUNCTION inbox_t2_bridge.project_filter() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN PERFORM inbox_t2_bridge.upsert_filter(NEW.org_id,NEW.target_kind,NEW.target_id,NEW.revision,NEW.summary);RETURN NULL;END $$;
CREATE TRIGGER bridge_filter_projection AFTER INSERT OR UPDATE OF summary,revision ON inbox_t2_maintained.rows FOR EACH ROW EXECUTE FUNCTION inbox_t2_bridge.project_filter();
CREATE INDEX filter_all ON inbox_t2_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id);
CREATE INDEX filter_known_visible ON inbox_t2_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise;
CREATE INDEX filter_mine ON inbox_t2_bridge.filter_rows(org_id,assigned_user_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise AND assignable;
CREATE INDEX filter_unread ON inbox_t2_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise AND unread;
CREATE INDEX filter_escalated ON inbox_t2_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='known_conversation' AND has_recent AND NOT is_noise AND escalated;
CREATE INDEX filter_unknown ON inbox_t2_bridge.filter_rows(org_id,latest_at DESC NULLS LAST,target_kind,target_id) WHERE target_kind='unknown_sender' AND unknown_active;
CREATE FUNCTION inbox_t2_bridge.page(o uuid,u uuid,f jsonb,cursor_at timestamptz,cursor_kind text,cursor_id uuid,has_cursor boolean,n integer)
RETURNS TABLE(target_kind text,target_id uuid,latest_at timestamptz) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE predicate text;known text;query text;view_name text:=f->>'view';
BEGIN
 IF n IS NULL OR n<1 OR n>501 THEN RAISE EXCEPTION 'INBOX_PAGE_LIMIT';END IF;
 known:='r.target_kind=''known_conversation'' AND r.has_recent';
 IF (f->>'hide_noise')::boolean THEN known:=known||' AND NOT r.is_noise';END IF;
 CASE view_name
 WHEN 'all' THEN predicate:=known;
 WHEN 'mine' THEN predicate:=known||' AND r.assignable AND r.assigned_user_id=$2';
 WHEN 'unassigned' THEN predicate:=known||' AND r.assignable AND r.assigned_user_id IS NULL';
 WHEN 'unread' THEN predicate:=known||' AND r.unread';
 WHEN 'escalated' THEN predicate:=known||' AND r.escalated';
 WHEN 'needs_outcome' THEN predicate:=known||' AND r.needs_outcome';
 WHEN 'dispo' THEN predicate:='r.target_kind=''known_conversation'' AND r.review';
 WHEN 'unknown' THEN predicate:='r.target_kind=''unknown_sender'' AND r.unknown_active';
 WHEN 'dismissed' THEN predicate:='r.target_kind=''unknown_sender'' AND r.unknown_dismissed';
 WHEN 'active' THEN predicate:='('||known||') OR (r.target_kind=''unknown_sender'' AND r.unknown_active)';
 ELSE RAISE EXCEPTION 'INBOX_INVALID_VIEW';END CASE;
 query:='SELECT r.target_kind,r.target_id,r.latest_at FROM inbox_t2_bridge.filter_rows r WHERE r.org_id=$1 AND ('||predicate||')';
 IF f->>'search' IS NOT NULL THEN query:=query||' AND (r.target_kind=''unknown_sender'' OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.org_id=$1 AND ct.id=r.contact_id AND (ct.search_text ILIKE $3 ESCAPE E''\\'' OR (length($4)>=3 AND ct.phone_digits ILIKE ''%''||$4||''%''))) OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=$1 AND m.conversation_id=r.target_id AND m.channel=''sms'' AND m.fts @@ public.search_prefix_tsquery($5)))';END IF;
 IF has_cursor THEN
  IF cursor_at IS NULL THEN query:=query||' AND r.latest_at IS NULL AND (r.target_kind,r.target_id)>($7,$8)';
  ELSE query:=query||' AND (r.latest_at<$6 OR r.latest_at IS NULL OR (r.latest_at=$6 AND (r.target_kind,r.target_id)>($7,$8)))';END IF;
 END IF;
 query:=query||' ORDER BY r.latest_at DESC NULLS LAST,r.target_kind,r.target_id LIMIT $9';
 RETURN QUERY EXECUTE query USING o,u,'%'||replace(replace(replace(lower(f->>'search'),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%',regexp_replace(f->>'search','[^0-9]','','g'),f->>'search',cursor_at,cursor_kind,cursor_id,n;
END $$;
CREATE FUNCTION inbox_t2_bridge.counts_typed(o uuid,u uuid,f jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH scoped AS (
 SELECT r.*,r.target_kind='known_conversation' AS known,r.has_recent AND (NOT (f->>'hide_noise')::boolean OR NOT r.is_noise) AS visible
 FROM inbox_t2_bridge.filter_rows r WHERE r.org_id=o
 AND (f->>'search' IS NULL OR r.target_kind='unknown_sender'
 OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.org_id=o AND ct.id=r.contact_id AND
  (ct.search_text ILIKE '%'||replace(replace(replace(lower(f->>'search'),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%' ESCAPE E'\\'
  OR (length(regexp_replace(f->>'search','[^0-9]','','g'))>=3 AND ct.phone_digits ILIKE '%'||regexp_replace(f->>'search','[^0-9]','','g')||'%')))
 OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.conversation_id=r.target_id AND m.channel='sms' AND m.fts @@ public.search_prefix_tsquery(f->>'search')))
 ) SELECT jsonb_build_object(
 'all',count(*) FILTER(WHERE known AND visible),
 'mine',count(*) FILTER(WHERE known AND visible AND assignable AND assigned_user_id=u),
 'unassigned',count(*) FILTER(WHERE known AND visible AND assignable AND assigned_user_id IS NULL),
 'unread',count(*) FILTER(WHERE known AND visible AND unread),
 'escalated',count(*) FILTER(WHERE known AND visible AND escalated),
 'dispo',count(*) FILTER(WHERE known AND review),
 'needs_outcome',count(*) FILTER(WHERE known AND visible AND needs_outcome),
 'unknown',count(*) FILTER(WHERE NOT known AND unknown_active),
 'dismissed',count(*) FILTER(WHERE NOT known AND unknown_dismissed)) FROM scoped;
$$;
REVOKE ALL ON FUNCTION inbox_t2_bridge.counts_typed(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON TABLE inbox_t2_bridge.filter_rows FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION inbox_t2_bridge.upsert_filter(uuid,text,uuid,bigint,jsonb),inbox_t2_bridge.project_filter(),inbox_t2_bridge.page(uuid,uuid,jsonb,timestamptz,text,uuid,boolean,integer) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
