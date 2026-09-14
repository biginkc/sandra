-- Private owned-fixture worksets. JWT claims must be supplied only after signature verification.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE TABLE inbox_t2_bridge.worksets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,user_id uuid NOT NULL,session_id uuid NOT NULL,
 access_epoch bigint NOT NULL,generation bigint NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 filter jsonb NOT NULL,targets jsonb NOT NULL CHECK(jsonb_typeof(targets)='array' AND jsonb_array_length(targets)<=500),
 handles jsonb NOT NULL CHECK(jsonb_typeof(handles)='array' AND jsonb_array_length(handles)=greatest(1,(jsonb_array_length(targets)+99)/100)), revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX worksets_session ON inbox_t2_bridge.worksets(user_id,session_id,created_at DESC);
CREATE FUNCTION inbox_t2_bridge.scope_json(w inbox_t2_bridge.worksets) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',w.id,'org_id',w.org_id,'user_id',w.user_id,'session_id',w.session_id,'access_epoch',w.access_epoch::text,'generation',w.generation::text,'created_at',w.created_at,'expires_at',w.expires_at,'targets',w.targets,'handles',w.handles);
$$;
CREATE FUNCTION inbox_t2_bridge.create_scope(o uuid,f jsonb,n integer,replaces uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;u uuid;sid uuid;e bigint;now_at timestamptz;prior inbox_t2_bridge.worksets;created inbox_t2_bridge.worksets;ids jsonb;gen bigint;last_at timestamptz;view_name text;
BEGIN
 IF n IS NULL OR n<1 OR n>500 OR f IS NULL OR jsonb_typeof(f)<>'object' OR (f-'view')<>'{}'::jsonb OR jsonb_typeof(f->'view') IS DISTINCT FROM 'string' OR f->>'view' NOT IN ('active','dismissed','review','unread') THEN RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';END IF;
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
 view_name:=f->>'view';
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',target_kind,'id',target_id) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id),'[]') INTO ids
 FROM (SELECT target_kind,target_id,latest_at FROM inbox_t2_bridge.summaries WHERE org_id=o AND CASE view_name WHEN 'active' THEN visible_active WHEN 'dismissed' THEN visible_dismissed WHEN 'review' THEN visible_review WHEN 'unread' THEN visible_unread END ORDER BY latest_at DESC NULLS LAST,target_kind,target_id LIMIT n) rows;
 INSERT INTO inbox_t2_bridge.worksets(org_id,user_id,session_id,access_epoch,generation,created_at,expires_at,filter,targets,handles)
 VALUES(o,u,sid,e,coalesce(gen,0)+1,now_at,least(now_at+interval '15 minutes',(a->>'expires_at')::timestamptz),f,ids,(SELECT jsonb_agg(null::text) FROM generate_series(1,greatest(1,(jsonb_array_length(ids)+99)/100)))) RETURNING * INTO created;
 IF replaces IS NOT NULL THEN UPDATE inbox_t2_bridge.worksets SET revoked=true WHERE id=replaces;END IF;
 RETURN inbox_t2_bridge.scope_json(created);
END $$;
CREATE FUNCTION inbox_t2_bridge.get_scope(scope_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w inbox_t2_bridge.worksets;a jsonb;
BEGIN
 SELECT * INTO w FROM inbox_t2_bridge.worksets WHERE id=scope_id;
 IF NOT FOUND OR w.revoked OR w.expires_at<=clock_timestamp() THEN RETURN NULL;END IF;
 a:=inbox_t2_bridge.authorize(w.org_id);
 IF w.user_id<>(a->>'user_id')::uuid OR w.session_id<>(a->>'session_id')::uuid OR w.access_epoch<>(a->>'access_epoch')::bigint THEN RETURN NULL;END IF;
 RETURN inbox_t2_bridge.scope_json(w);
END $$;
CREATE FUNCTION inbox_t2_bridge.bind_handle(scope_id uuid,partition_index integer,expected text,next_handle text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_scope jsonb;
BEGIN
 IF next_handle IS NULL OR length(next_handle)<1 OR length(next_handle)>256 THEN RETURN false;END IF;
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=auth.uid() FOR UPDATE;
 current_scope:=inbox_t2_bridge.get_scope(scope_id);
 IF current_scope IS NULL OR partition_index IS NULL OR partition_index<0 OR partition_index>=jsonb_array_length(current_scope->'handles') THEN RETURN false;END IF;
 UPDATE inbox_t2_bridge.worksets SET handles=jsonb_set(handles,ARRAY[partition_index::text],to_jsonb(next_handle)) WHERE id=scope_id AND (handles->>partition_index) IS NOT DISTINCT FROM expected AND NOT revoked AND expires_at>clock_timestamp();
 RETURN FOUND;
END $$;
ALTER TABLE inbox_t2_bridge.worksets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_bridge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_bridge FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
