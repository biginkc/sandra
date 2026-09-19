BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';
-- Owned T2 candidate only. Not a production migration or an enabled endpoint.

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';

CREATE SCHEMA inbox_read;
REVOKE ALL ON SCHEMA inbox_read FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_read.boundaries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid NOT NULL,
 org_id uuid NOT NULL, conversation_id uuid NOT NULL, generation uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>=0), created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, execution_deadline timestamptz,
 next_batch integer NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false,
 session_id uuid NOT NULL, access_epoch bigint NOT NULL
);
CREATE TABLE inbox_read.receipts (
 boundary_id uuid NOT NULL REFERENCES inbox_read.boundaries(id), batch integer NOT NULL,
 changed integer NOT NULL CHECK(changed BETWEEN 0 AND 200), completed boolean NOT NULL,
 PRIMARY KEY(boundary_id,batch)
);
ALTER TABLE inbox_read.boundaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_read.receipts ENABLE ROW LEVEL SECURITY;

-- The data snapshot and its stored boundary are created in ONE statement. The
-- STABLE canonical detail function and generation CTE share that statement snapshot.
-- No message is marked read here; recording a boundary does not acknowledge it.
CREATE FUNCTION inbox_read.detail(o uuid,c uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb;
BEGIN
 a:=inbox_bridge.authorize(o);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_bridge.authorize(o);
 WITH snapshot AS MATERIALIZED (
  SELECT inbox_authenticated_detail.detail_v2(o,c) AS data,
   g.generation FROM inbox_capture_boundary.generation g WHERE singleton IS TRUE
 ), recorded AS (
  INSERT INTO inbox_read.boundaries(requester_id,org_id,conversation_id,generation,revision,created_at,expires_at,session_id,access_epoch)
  SELECT (a->>'user_id')::uuid,o,c,s.generation,(s.data->>'head_revision')::bigint,
   statement_timestamp(),least(statement_timestamp()+interval '5 minutes',(a->>'expires_at')::timestamptz),
   (a->>'session_id')::uuid,(a->>'access_epoch')::bigint
  FROM snapshot s RETURNING id,expires_at
 ) SELECT s.data || jsonb_build_object('read_boundary',r.id,'boundary_expires_at',r.expires_at,
  'capture_generation',s.generation) INTO result FROM snapshot s CROSS JOIN recorded r;
 IF result IS NULL THEN RAISE EXCEPTION 'INBOX_CAPTURE_METADATA_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM inbox_bridge.authorize(o);
 RETURN result;
END $$;

-- A caller advances the batch number only after receiving its committed receipt.
-- A lost response retries the SAME boundary/batch, including after completion.
-- No SKIP LOCKED: an empty batch cannot conceal a locked eligible message.
CREATE FUNCTION inbox_read.acknowledge(b uuid,batch_number integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; w inbox_read.boundaries; r inbox_read.receipts;
 current_generation uuid; current_head bigint; property_id uuid; changed_count integer; done boolean;
BEGIN
 IF b IS NULL OR batch_number IS NULL OR batch_number<0 THEN
  RAISE EXCEPTION 'INBOX_INVALID_READ_BATCH' USING ERRCODE='22023'; END IF;
 a:=inbox_bridge.authorize(NULL);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_bridge.authorize(NULL);
 SELECT * INTO w FROM inbox_read.boundaries WHERE id=b FOR UPDATE;
 IF NOT FOUND OR w.requester_id<>(a->>'user_id')::uuid OR w.org_id<>(a->>'org_id')::uuid
  OR w.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR w.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
  RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM inbox_read.receipts WHERE boundary_id=b AND batch=batch_number;
 IF FOUND THEN RETURN jsonb_build_object('boundary_id',b,'batch',r.batch,'changed',r.changed,'completed',r.completed); END IF;
 IF w.completed OR batch_number<>w.next_batch THEN
  RAISE EXCEPTION 'INBOX_READ_BATCH_CONFLICT' USING ERRCODE='55000'; END IF;
 IF (w.execution_deadline IS NULL AND w.expires_at<=clock_timestamp()) OR w.execution_deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000'; END IF;
 -- Serialize capture resets with this whole batch, without locking the arrival head.
 SELECT generation INTO current_generation FROM inbox_capture_boundary.generation WHERE singleton IS TRUE FOR SHARE;
 SELECT revision INTO current_head FROM public.inbox_inbound_heads WHERE org_id=w.org_id AND conversation_id=w.conversation_id;
 IF current_generation IS DISTINCT FROM w.generation OR coalesce(current_head,0)<w.revision THEN
  RAISE EXCEPTION 'INBOX_READ_COVERAGE_CHANGED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.messages WHERE org_id=w.org_id AND conversation_id=w.conversation_id AND channel='sms') THEN
  RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.messages WHERE org_id=w.org_id AND conversation_id=w.conversation_id
  AND channel='sms' AND direction='inbound' AND inbox_inbound_revision IS NULL) THEN
  RAISE EXCEPTION 'INBOX_READ_COVERAGE_MISSING' USING ERRCODE='55000'; END IF;
 -- Preserve the old conversation-wide property guard, including properties on
 -- outbound history. Current canonical row triggers also guard each actual write.
 FOR property_id IN SELECT DISTINCT m.property_id FROM public.messages m WHERE m.org_id=w.org_id
  AND m.conversation_id=w.conversation_id AND m.channel='sms' AND m.property_id IS NOT NULL ORDER BY m.property_id
 LOOP
  PERFORM 1 FROM public.properties p WHERE p.id=property_id FOR NO KEY UPDATE;
  PERFORM public.assert_property_dnc_unlocked(property_id);
 END LOOP;
 WITH candidates AS MATERIALIZED (
  SELECT id FROM public.messages WHERE org_id=w.org_id AND conversation_id=w.conversation_id
   AND channel='sms' AND direction='inbound' AND read_at IS NULL AND inbox_inbound_revision<=w.revision
  ORDER BY id LIMIT 200 FOR UPDATE
 ), changed AS (
  UPDATE public.messages m SET read_at=statement_timestamp() FROM candidates x WHERE m.id=x.id
   AND m.org_id=w.org_id AND m.conversation_id=w.conversation_id AND m.channel='sms'
   AND m.direction='inbound' AND m.read_at IS NULL AND m.inbox_inbound_revision<=w.revision RETURNING m.id
 ) SELECT count(*) INTO changed_count FROM changed;
 a:=inbox_bridge.authorize(w.org_id);
 IF w.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
  RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF (w.execution_deadline IS NULL AND w.expires_at<=clock_timestamp()) OR w.execution_deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000'; END IF;
 SELECT NOT EXISTS(SELECT 1 FROM public.messages WHERE org_id=w.org_id AND conversation_id=w.conversation_id
  AND channel='sms' AND direction='inbound' AND read_at IS NULL AND inbox_inbound_revision<=w.revision) INTO done;
 INSERT INTO inbox_read.receipts VALUES(b,batch_number,changed_count,done);
 UPDATE inbox_read.boundaries SET next_batch=next_batch+1,completed=done,
  execution_deadline=coalesce(execution_deadline,clock_timestamp()+interval '10 minutes') WHERE id=b;
 RETURN jsonb_build_object('boundary_id',b,'batch',batch_number,'changed',changed_count,'completed',done);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_read FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_read FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA inbox_read TO authenticated;
GRANT EXECUTE ON FUNCTION inbox_read.detail(uuid,uuid),inbox_read.acknowledge(uuid,integer) TO authenticated;


-- Owned fixture only. Apply through the established migration workflow for release.


CREATE FUNCTION public.inbox_read_detail(org_id uuid,conversation_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_read.detail(org_id,conversation_id)
$$;
CREATE FUNCTION public.inbox_acknowledge_read(boundary_id uuid,batch_number integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_read.acknowledge(boundary_id,batch_number)
$$;
REVOKE ALL ON FUNCTION public.inbox_read_detail(uuid,uuid),public.inbox_acknowledge_read(uuid,integer)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_read_detail(uuid,uuid),public.inbox_acknowledge_read(uuid,integer) TO authenticated;


-- Owned canonical fixture candidate; release requires the normal migration path.

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';

CREATE TABLE inbox_read.history_cursors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 boundary_id uuid NOT NULL REFERENCES inbox_read.boundaries(id),
 session_id uuid NOT NULL, access_epoch bigint NOT NULL,
 before_at timestamptz NOT NULL, before_id uuid NOT NULL,
 UNIQUE(boundary_id,session_id,access_epoch,before_at,before_id)
);
ALTER TABLE inbox_read.history_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_read.history_cursors FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_read.history_page(o uuid,c uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb; position inbox_read.history_cursors;
 boundary inbox_read.boundaries; last_message jsonb; next_cursor uuid;
BEGIN
 a:=inbox_bridge.authorize(o);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_bridge.authorize(o);
 IF before_cursor IS NULL THEN
  result:=inbox_read.detail(o,c);
  SELECT * INTO STRICT boundary FROM inbox_read.boundaries WHERE id=(result->>'read_boundary')::uuid;
 ELSE
  SELECT * INTO position FROM inbox_read.history_cursors WHERE id=before_cursor;
  IF NOT FOUND OR position.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR position.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
   RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
  SELECT * INTO boundary FROM inbox_read.boundaries WHERE id=position.boundary_id;
  IF NOT FOUND OR boundary.requester_id IS DISTINCT FROM (a->>'user_id')::uuid OR boundary.org_id IS DISTINCT FROM o OR boundary.conversation_id IS DISTINCT FROM c
   OR boundary.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR boundary.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
   RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
  IF boundary.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
  -- Reuse the canonical measured keyset query. No message update and no new read
  -- boundary: later/backdated arrivals cannot extend the acknowledged snapshot.
  result:=inbox_authenticated_detail.detail_v2(o,c,position.before_at,position.before_id);
  result:=result||jsonb_build_object('read_boundary',boundary.id,'boundary_expires_at',boundary.expires_at,
   'capture_generation',boundary.generation,'head_revision',boundary.revision::text);
 END IF;
 IF jsonb_array_length(result->'history')=50 THEN
  last_message:=result->'history'->49;
  INSERT INTO inbox_read.history_cursors(boundary_id,session_id,access_epoch,before_at,before_id)
   VALUES(boundary.id,(a->>'session_id')::uuid,(a->>'access_epoch')::bigint,(last_message->>'created_at_raw')::timestamptz,(last_message->>'id')::uuid)
   ON CONFLICT(boundary_id,session_id,access_epoch,before_at,before_id) DO UPDATE SET boundary_id=EXCLUDED.boundary_id
   RETURNING id INTO next_cursor;
 END IF;
 PERFORM inbox_bridge.authorize(o);
 IF boundary.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 RETURN result||jsonb_build_object('next_cursor',next_cursor);
END $$;
REVOKE ALL ON FUNCTION inbox_read.history_page(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.inbox_history_page(org_id uuid,conversation_id uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_read.history_page(org_id,conversation_id,before_cursor)
$$;
REVOKE ALL ON FUNCTION public.inbox_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_history_page(uuid,uuid,uuid) TO authenticated;


-- Owned fixture candidate; production requires the reviewed migration path.

SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';

CREATE TABLE inbox_read.unknown_history_cursors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,
 sender_group_id uuid NOT NULL,requester_id uuid NOT NULL,session_id uuid NOT NULL,
 access_epoch bigint NOT NULL,expires_at timestamptz NOT NULL,
 before_at timestamptz NOT NULL,before_id uuid NOT NULL
);
ALTER TABLE inbox_read.unknown_history_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_read.unknown_history_cursors FROM PUBLIC,anon,authenticated,service_role;
-- Hash narrows the index only. Exact raw text equality below is authoritative.
-- The release companion must create this index CONCURRENTLY outside its transaction.
-- Canonical index moved to separate concurrent packet.
CREATE FUNCTION inbox_read.unknown_history_values(o uuid,g uuid,at_time timestamptz,before_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH sender AS MATERIALIZED (
  SELECT raw_sender FROM inbox_message_capture.sender_groups WHERE org_id=o AND sender_group_id=g
 ), eligible AS MATERIALIZED (
  SELECT raw_sender FROM sender WHERE EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.channel='sms'
   AND md5(m.from_address)=md5(sender.raw_sender) AND m.from_address COLLATE "C"=sender.raw_sender COLLATE "C"
   AND m.direction='inbound' AND m.contact_id IS NULL)
 ), page AS MATERIALIZED (
  SELECT m.id,m.created_at,m.body,m.direction,m.dismissed_at FROM public.messages m JOIN eligible s
   ON md5(m.from_address)=md5(s.raw_sender) AND m.from_address COLLATE "C"=s.raw_sender COLLATE "C"
  WHERE m.org_id=o AND m.channel='sms' AND (at_time IS NULL OR (m.created_at,m.id)<(at_time,before_id))
  ORDER BY m.created_at DESC,m.id DESC LIMIT 50
 ) SELECT jsonb_build_object('exists',EXISTS(SELECT 1 FROM eligible),'raw_sender',(SELECT raw_sender FROM eligible),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'created_at_raw',created_at::text,'body',body,
   'direction',direction,'dismissed_at_raw',dismissed_at::text) ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb))
$$;
CREATE FUNCTION inbox_read.unknown_history_page(o uuid,g uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb; position inbox_read.unknown_history_cursors;
 expires timestamptz:=clock_timestamp()+interval '5 minutes';last_message jsonb;next_cursor uuid;
BEGIN
 a:=inbox_bridge.authorize(o);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR SHARE;
 a:=inbox_bridge.authorize(o);
 IF before_cursor IS NOT NULL THEN
  SELECT * INTO position FROM inbox_read.unknown_history_cursors WHERE id=before_cursor;
  IF NOT FOUND OR position.org_id IS DISTINCT FROM o OR position.sender_group_id IS DISTINCT FROM g
   OR position.requester_id IS DISTINCT FROM (a->>'user_id')::uuid OR position.session_id IS DISTINCT FROM (a->>'session_id')::uuid
   OR position.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
   RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
  expires:=position.expires_at;
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 END IF;
 result:=inbox_read.unknown_history_values(o,g,position.before_at,position.before_id);
 IF result->>'exists' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(result->'history')=50 THEN
  last_message:=result->'history'->49;
  INSERT INTO inbox_read.unknown_history_cursors(org_id,sender_group_id,requester_id,session_id,access_epoch,expires_at,before_at,before_id)
   VALUES(o,g,(a->>'user_id')::uuid,(a->>'session_id')::uuid,(a->>'access_epoch')::bigint,expires,
    (last_message->>'created_at_raw')::timestamptz,(last_message->>'id')::uuid) RETURNING id INTO next_cursor;
 END IF;
 PERFORM inbox_bridge.authorize(o);
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 RETURN (result-'exists')||jsonb_build_object('requester_id',a->>'user_id','org_id',o,'sender_group_id',g,'next_cursor',next_cursor,'expires_at',expires);
END $$;
REVOKE ALL ON FUNCTION inbox_read.unknown_history_values(uuid,uuid,timestamptz,uuid),inbox_read.unknown_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.inbox_unknown_history_page(org_id uuid,sender_group_id uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_read.unknown_history_page(org_id,sender_group_id,before_cursor) $$;
REVOKE ALL ON FUNCTION public.inbox_unknown_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_unknown_history_page(uuid,uuid,uuid) TO authenticated;


-- Additive candidate RPCs. Public RPC callers supply no actor authority.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';

CREATE OR REPLACE FUNCTION inbox_bridge.authorized_scope(scope_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;w inbox_bridge.worksets;
BEGIN
 a:=inbox_bridge.authorize(NULL);
 SELECT * INTO w FROM inbox_bridge.worksets WHERE id=scope_id;
 IF NOT FOUND OR w.revoked OR w.expires_at<=clock_timestamp() OR w.org_id<>(a->>'org_id')::uuid OR w.user_id<>(a->>'user_id')::uuid OR w.session_id<>(a->>'session_id')::uuid OR w.access_epoch<>(a->>'access_epoch')::bigint THEN RETURN NULL;END IF;
 IF (a->>'expires_at')::timestamptz<=clock_timestamp() THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('authority',a,'scope',inbox_bridge.scope_json(w));
END $$;
CREATE OR REPLACE FUNCTION inbox_bridge.finalize_scope(scope_id uuid,expected_scope jsonb,partition_index integer,expected_handle text,next_handle text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;w inbox_bridge.worksets;actual jsonb;
BEGIN
 IF expected_scope IS NULL OR jsonb_typeof(expected_scope)<>'object' OR partition_index IS NULL OR partition_index<0 OR partition_index>4 OR (next_handle IS NOT NULL AND (length(next_handle)<1 OR length(next_handle)>256)) OR (expected_handle IS NOT NULL AND length(expected_handle)>256) THEN RETURN NULL;END IF;
 -- Same lock order as workset creation and access-capture writers. A revocation
 -- committed before this lock is acquired must be observed by the fresh check.
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=auth.uid() FOR UPDATE;
 a:=inbox_bridge.authorize(NULL);
 SELECT * INTO w FROM inbox_bridge.worksets WHERE id=scope_id FOR UPDATE;
 IF NOT FOUND OR w.revoked OR w.org_id<>(a->>'org_id')::uuid OR w.user_id<>(a->>'user_id')::uuid OR w.session_id<>(a->>'session_id')::uuid OR w.access_epoch<>(a->>'access_epoch')::bigint OR partition_index>=jsonb_array_length(w.handles) THEN RETURN NULL;END IF;
 actual:=inbox_bridge.scope_json(w);
 IF (actual-'handles') IS DISTINCT FROM (expected_scope-'handles') THEN RETURN NULL;END IF;
 IF (w.handles->>partition_index) IS DISTINCT FROM expected_handle THEN RETURN jsonb_build_object('conflict',true);END IF;
 IF w.expires_at<=clock_timestamp() OR (a->>'expires_at')::timestamptz<=clock_timestamp() THEN RETURN NULL;END IF;
 -- Quiet polls with an unchanged handle perform no row update/WAL write.
 IF next_handle IS NOT NULL AND next_handle IS DISTINCT FROM expected_handle THEN
  UPDATE inbox_bridge.worksets SET handles=jsonb_set(handles,ARRAY[partition_index::text],to_jsonb(next_handle)) WHERE id=scope_id AND NOT revoked AND expires_at>clock_timestamp() RETURNING * INTO w;
  IF NOT FOUND THEN RETURN NULL;END IF;
 END IF;
 IF w.expires_at<=clock_timestamp() OR (a->>'expires_at')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('authority',a,'scope',inbox_bridge.scope_json(w));
END $$;
CREATE OR REPLACE FUNCTION public.inbox_sync_snapshot_v1(scope_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT inbox_bridge.authorized_scope(scope_id)$$;
CREATE OR REPLACE FUNCTION public.inbox_sync_finalize_v1(scope_id uuid,expected_scope jsonb,partition_index integer,expected_handle text,next_handle text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT inbox_bridge.finalize_scope(scope_id,expected_scope,partition_index,expected_handle,next_handle)$$;
REVOKE ALL ON FUNCTION inbox_bridge.authorized_scope(uuid),inbox_bridge.finalize_scope(uuid,jsonb,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_sync_snapshot_v1(uuid),public.inbox_sync_finalize_v1(uuid,jsonb,integer,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_sync_snapshot_v1(uuid),public.inbox_sync_finalize_v1(uuid,jsonb,integer,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';


-- Separate read companion addition. Never deletes operation or safety receipts.
CREATE INDEX read_boundary_retention ON inbox_read.boundaries((greatest(expires_at,execution_deadline)),id);
CREATE FUNCTION inbox_read.prune_expired_boundaries(p_row_budget integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b record;remaining integer:=p_row_budget;removed integer;children integer:=0;parents integer:=0;
 cutoff timestamptz:=clock_timestamp()-interval '7 days';
BEGIN
 IF p_row_budget IS NULL OR p_row_budget<1 OR p_row_budget>1000 THEN RAISE EXCEPTION 'Invalid read retention budget';END IF;
 -- Same parent-before-receipt order as acknowledgment. No epoch, generation or
 -- canonical row locks are acquired here, so no reverse dependency is introduced.
 -- Active calls holding a boundary lock are skipped. A worker statement timeout
 -- must bound execution in addition to this physical deletion budget.
 FOR b IN SELECT id FROM inbox_read.boundaries
  WHERE greatest(expires_at,execution_deadline)<cutoff
  ORDER BY greatest(expires_at,execution_deadline),id LIMIT least(p_row_budget,500)
  FOR UPDATE SKIP LOCKED LOOP
  WITH candidates AS (SELECT id FROM inbox_read.history_cursors WHERE boundary_id=b.id LIMIT remaining)
  DELETE FROM inbox_read.history_cursors c USING candidates d WHERE c.id=d.id;
  GET DIAGNOSTICS removed=ROW_COUNT;remaining:=remaining-removed;children:=children+removed;
  IF remaining=0 THEN EXIT;END IF;
  WITH candidates AS (SELECT boundary_id,batch FROM inbox_read.receipts WHERE boundary_id=b.id LIMIT remaining)
  DELETE FROM inbox_read.receipts c USING candidates d WHERE c.boundary_id=d.boundary_id AND c.batch=d.batch;
  GET DIAGNOSTICS removed=ROW_COUNT;remaining:=remaining-removed;children:=children+removed;
  IF remaining=0 THEN EXIT;END IF;
  IF NOT EXISTS(SELECT 1 FROM inbox_read.history_cursors WHERE boundary_id=b.id)
   AND NOT EXISTS(SELECT 1 FROM inbox_read.receipts WHERE boundary_id=b.id) THEN
   DELETE FROM inbox_read.boundaries WHERE id=b.id;parents:=parents+1;remaining:=remaining-1;
  END IF;
  IF remaining=0 THEN EXIT;END IF;
 END LOOP;
 RETURN jsonb_build_object('deleted_boundaries',parents,'deleted_children',children,'deleted_rows',p_row_budget-remaining,'row_budget',p_row_budget);
END $$;
REVOKE ALL ON FUNCTION inbox_read.prune_expired_boundaries(integer) FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX unknown_history_retention ON inbox_read.unknown_history_cursors(expires_at,id);
CREATE FUNCTION inbox_read.prune_expired_unknown_cursors(p_row_budget integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE removed integer;cutoff timestamptz:=clock_timestamp()-interval '7 days';
BEGIN
 IF p_row_budget IS NULL OR p_row_budget<1 OR p_row_budget>1000 THEN RAISE EXCEPTION 'Invalid unknown retention budget';END IF;
 WITH candidates AS (SELECT id FROM inbox_read.unknown_history_cursors WHERE expires_at<cutoff ORDER BY expires_at,id LIMIT p_row_budget FOR UPDATE SKIP LOCKED)
 DELETE FROM inbox_read.unknown_history_cursors c USING candidates d WHERE c.id=d.id;
 GET DIAGNOSTICS removed=ROW_COUNT;RETURN removed;
END $$;
REVOKE ALL ON FUNCTION inbox_read.prune_expired_unknown_cursors(integer) FROM PUBLIC,anon,authenticated,service_role;
-- Production candidate has only explicitly reviewed public API entry points.
-- SECURITY DEFINER internal calls retain owner access; dedicated worker grants are separate.
DO $$ DECLARE n text; BEGIN
 -- Exact reviewed bundle inventory; never touch unrelated Inbox schemas.
 FOREACH n IN ARRAY ARRAY['inbox_control','inbox_summary_contract','inbox_unknown_summary','inbox_authenticated_detail','inbox_capture_boundary','inbox_message_capture','inbox_maintained','inbox_parent','inbox_safety','inbox_backfill','inbox_policy','inbox_bridge','inbox_read'] LOOP
  IF to_regnamespace(n) IS NULL THEN CONTINUE;END IF;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',n);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',n);
 END LOOP;
END $$;
COMMIT;
