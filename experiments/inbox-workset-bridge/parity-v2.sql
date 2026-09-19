-- Owned-fixture source candidate. Not installed until exclusive T2 test grant.
BEGIN;
DO $$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE TABLE inbox_t2_bridge.cursors(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),scope_id uuid NOT NULL REFERENCES inbox_t2_bridge.worksets(id),
 latest_at timestamptz,target_kind text NOT NULL,target_id uuid NOT NULL
);
ALTER TABLE inbox_t2_bridge.cursors ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION inbox_t2_bridge.normalize_filter(f jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE q text;
BEGIN
 IF f IS NULL OR jsonb_typeof(f)<>'object' OR (f-ARRAY['view','hide_noise','search'])<>'{}'::jsonb
 OR jsonb_typeof(f->'view') IS DISTINCT FROM 'string' OR f->>'view' NOT IN ('active','all','mine','unassigned','unread','escalated','dispo','needs_outcome','unknown','dismissed')
 OR (f?'hide_noise' AND jsonb_typeof(f->'hide_noise') IS DISTINCT FROM 'boolean')
 OR (f?'search' AND jsonb_typeof(f->'search') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'INBOX_FILTER_INVALID' USING ERRCODE='22023';END IF;
 q:=left(btrim(coalesce(f->>'search','')),100);IF length(q)<3 THEN q:=NULL;END IF;
 RETURN jsonb_build_object('view',f->>'view','hide_noise',coalesce((f->>'hide_noise')::boolean,true),'search',q);
END $$;
CREATE FUNCTION inbox_t2_bridge.matching(o uuid,u uuid,f jsonb)
RETURNS TABLE(target_kind text,target_id uuid,latest_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH p AS (SELECT f->>'view' AS view, (f->>'hide_noise')::boolean AS hide_noise,f->>'search' AS q),
 candidates AS (
 SELECT r.target_kind,r.target_id,r.summary s,CASE WHEN r.target_kind='unknown_sender' THEN (r.summary->>'latest_at')::timestamptz ELSE (r.summary->>'last_message_at')::timestamptz END latest_at
 FROM inbox_t2_maintained.rows r WHERE r.org_id=o AND (r.summary->>'exists')::boolean
 )
 SELECT c.target_kind,c.target_id,c.latest_at FROM candidates c CROSS JOIN p
 WHERE CASE WHEN c.target_kind='unknown_sender' THEN
  -- Existing unknown loader does not consume known-conversation search input.
  CASE p.view WHEN 'active' THEN coalesce((c.s->>'visible_unknown')::boolean,false) WHEN 'unknown' THEN coalesce((c.s->>'visible_unknown')::boolean,false) WHEN 'dismissed' THEN coalesce((c.s->>'visible_dismissed')::boolean,false) ELSE false END
 ELSE
  CASE p.view WHEN 'unknown' THEN false WHEN 'dismissed' THEN false
   WHEN 'dispo' THEN (c.s->>'ai_disposition_review_id') IS NOT NULL AND NOT coalesce((c.s->>'is_test_traffic')::boolean,false)
   ELSE coalesce((c.s->>'has_recent')::boolean,false) AND (NOT p.hide_noise OR NOT coalesce((c.s->>'is_noise')::boolean,false)) AND
    CASE p.view WHEN 'mine' THEN c.s->>'property_status' IS NOT NULL AND c.s->>'property_status'<>'prospect' AND c.s->>'assigned_user_id'=u::text
     WHEN 'unassigned' THEN c.s->>'property_status' IS NOT NULL AND c.s->>'property_status'<>'prospect' AND c.s->>'assigned_user_id' IS NULL
     WHEN 'unread' THEN coalesce((c.s->>'unread_count')::bigint,0)>0
     WHEN 'escalated' THEN c.s->>'ai_responder_status'='escalated'
     WHEN 'needs_outcome' THEN coalesce((c.s->>'needs_outcome')::boolean,false)
     ELSE true END END
  AND (p.q IS NULL OR EXISTS(SELECT 1 FROM public.contacts ct WHERE ct.id=(c.s->>'contact_id')::uuid AND ct.org_id=o AND
    (ct.search_text ILIKE '%'||replace(replace(replace(lower(p.q),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%' ESCAPE E'\\'
    OR (length(regexp_replace(p.q,'[^0-9]','','g'))>=3 AND ct.phone_digits ILIKE '%'||regexp_replace(p.q,'[^0-9]','','g')||'%')))
   OR EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.conversation_id=c.target_id AND m.channel='sms' AND m.fts @@ public.search_prefix_tsquery(p.q)))
 END;
$$;
CREATE FUNCTION public.inbox_counts_v2(org_id uuid,filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;after_access jsonb;f jsonb;result jsonb;
BEGIN
 a:=inbox_t2_bridge.authorize(org_id);f:=inbox_t2_bridge.normalize_filter(filter);
 SELECT inbox_t2_bridge.counts_typed(org_id,(a->>'user_id')::uuid,f) INTO result;
 after_access:=inbox_t2_bridge.authorize(org_id);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'access_epoch') IS DISTINCT FROM (a->>'user_id',a->>'session_id',a->>'access_epoch') THEN RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('counts',result,'as_of',statement_timestamp(),'access_epoch',a->>'access_epoch');
END $$;
CREATE TYPE inbox_t2_bridge.cursor_context AS (id uuid,org_id uuid,user_id uuid,session_id uuid,access_epoch bigint,generation bigint,created_at timestamptz,expires_at timestamptz,filter jsonb,targets jsonb,handles jsonb,revoked boolean,cursor_at timestamptz,cursor_kind text,cursor_target uuid);
CREATE FUNCTION public.inbox_create_workset_v2(org_id uuid,filter jsonb,"limit" integer,replaces_scope_id uuid DEFAULT NULL,cursor_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;u uuid;sid uuid;e bigint;now_at timestamptz;prior inbox_t2_bridge.worksets;created inbox_t2_bridge.worksets;ids jsonb;gen bigint;last_at timestamptz;view_name text;o uuid:=org_id;f jsonb; n integer:="limit";replaces uuid:=replaces_scope_id;cur inbox_t2_bridge.cursor_context;page_rows jsonb;last_row jsonb;next_id uuid;
BEGIN
 f:=inbox_t2_bridge.normalize_filter(filter);
 IF n IS NULL OR n<1 OR n>500 THEN RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';END IF;
 a:=inbox_t2_bridge.authorize(o);u:=(a->>'user_id')::uuid;sid:=(a->>'session_id')::uuid;
 -- Persistent actor row serializes generation allocation, access capture, and replacement.
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=u FOR UPDATE;
 a:=inbox_t2_bridge.authorize(o);e:=(a->>'access_epoch')::bigint;now_at:=clock_timestamp();
 SELECT max(generation),max(created_at) INTO gen,last_at FROM inbox_t2_bridge.worksets WHERE user_id=u AND session_id=sid;
 IF last_at>now_at-interval '1 second' THEN RAISE EXCEPTION 'INBOX_GENERATION_RATE' USING ERRCODE='55000';END IF;
 IF replaces IS NOT NULL THEN
  SELECT * INTO prior FROM inbox_t2_bridge.worksets WHERE id=replaces FOR UPDATE;
  IF NOT FOUND OR prior.user_id<>u OR prior.session_id<>sid OR prior.org_id<>o OR prior.access_epoch<>e OR prior.revoked THEN RAISE EXCEPTION 'INBOX_REPLACEMENT_DENIED' USING ERRCODE='42501';END IF;
 END IF;
 IF (SELECT count(*) FROM inbox_t2_bridge.worksets WHERE user_id=u AND session_id=sid AND NOT revoked AND expires_at>now_at AND id IS DISTINCT FROM replaces)>=2 THEN RAISE EXCEPTION 'INBOX_GENERATION_LIMIT' USING ERRCODE='55000';END IF;
 IF cursor_id IS NOT NULL THEN
  SELECT w.id,w.org_id,w.user_id,w.session_id,w.access_epoch,w.generation,w.created_at,w.expires_at,w.filter,w.targets,w.handles,w.revoked,c.latest_at AS cursor_at,c.target_kind AS cursor_kind,c.target_id AS cursor_target INTO cur
  FROM inbox_t2_bridge.cursors c JOIN inbox_t2_bridge.worksets w ON w.id=c.scope_id WHERE c.id=cursor_id;
  IF NOT FOUND OR cur.user_id<>u OR cur.session_id<>sid OR cur.org_id<>o OR cur.access_epoch<>e OR cur.expires_at<=now_at OR cur.revoked OR cur.filter IS DISTINCT FROM f THEN RAISE EXCEPTION 'INBOX_CURSOR_DENIED' USING ERRCODE='42501';END IF;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(rows) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id),'[]') INTO page_rows FROM (
 SELECT * FROM inbox_t2_bridge.page(o,u,f,cur.cursor_at,cur.cursor_kind,cur.cursor_target,cursor_id IS NOT NULL,n+1)
) rows;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x->>'target_kind','id',x->>'target_id') ORDER BY ordinal),'[]') INTO ids FROM jsonb_array_elements(page_rows) WITH ORDINALITY a(x,ordinal) WHERE ordinal<=n;
 INSERT INTO inbox_t2_bridge.worksets(org_id,user_id,session_id,access_epoch,generation,created_at,expires_at,filter,targets,handles)
 VALUES(o,u,sid,e,coalesce(gen,0)+1,now_at,least(now_at+interval '15 minutes',(a->>'expires_at')::timestamptz),f,ids,(SELECT jsonb_agg(null::text) FROM generate_series(1,greatest(1,(jsonb_array_length(ids)+99)/100)))) RETURNING * INTO created;
 IF replaces IS NOT NULL THEN UPDATE inbox_t2_bridge.worksets SET revoked=true WHERE id=replaces;END IF;
 IF jsonb_array_length(page_rows)>n THEN
  last_row:=page_rows->(n-1);
  INSERT INTO inbox_t2_bridge.cursors(scope_id,latest_at,target_kind,target_id) VALUES(created.id,(last_row->>'latest_at')::timestamptz,last_row->>'target_kind',(last_row->>'target_id')::uuid) RETURNING id INTO next_id;
 END IF;
 RETURN inbox_t2_bridge.scope_json(created)||jsonb_build_object('next_cursor',next_id,'refreshed',cursor_id IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.inbox_create_workset_v2(uuid,jsonb,integer,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_create_workset_v2(uuid,jsonb,integer,uuid,uuid) TO authenticated;
REVOKE ALL ON TABLE inbox_t2_bridge.cursors FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION inbox_t2_bridge.normalize_filter(jsonb),inbox_t2_bridge.matching(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_counts_v2(uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_counts_v2(uuid,jsonb) TO authenticated;
COMMIT;
