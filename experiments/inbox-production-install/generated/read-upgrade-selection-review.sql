BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'sandra_inbox_release_20260917' OR NOT EXISTS(
  SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-release-owned-synthetic'
 ) THEN RAISE EXCEPTION 'Owned release-db fixture required'; END IF;
END $$;
CREATE OR REPLACE FUNCTION inbox_read.authoritative_context(o uuid,c uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
WITH latest AS (
 SELECT m.* FROM public.messages m
 WHERE m.org_id=o AND m.conversation_id=c AND m.channel='sms'
 ORDER BY m.created_at DESC,m.id DESC LIMIT 1
), contact_ref AS (
 SELECT m.contact_id FROM public.messages m
 WHERE m.org_id=o AND m.conversation_id=c AND m.channel='sms' AND m.contact_id IS NOT NULL
 ORDER BY m.created_at DESC,m.id DESC LIMIT 1
), property_ref AS (
 SELECT coalesce(
  (SELECT r.property_id FROM public.ai_disposition_reviews r
   WHERE r.org_id=o AND r.conversation_id=c AND r.status='pending'
   ORDER BY r.created_at DESC,r.id DESC LIMIT 1),
  (SELECT m.property_id FROM public.messages m
   WHERE m.org_id=o AND m.conversation_id=c AND m.channel='sms' AND m.property_id IS NOT NULL
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1)
 ) AS property_id
), pending_review AS (
 SELECT r.id,r.status,r.disposition,r.ai_reason,r.source_inbound_message_id,r.created_at,
  (SELECT m.body FROM public.messages m WHERE m.id=r.source_inbound_message_id
   AND m.org_id=o AND m.conversation_id=c AND m.channel='sms' AND m.direction='inbound') AS source_message_body
 FROM public.ai_disposition_reviews r
 WHERE r.org_id=o AND r.conversation_id=c AND r.status='pending'
 ORDER BY r.created_at DESC,r.id DESC LIMIT 1
), thread_state AS (
 SELECT t.ai_responder_status,t.ai_responder_reason,t.ai_responder_status_at,
  t.ai_last_delivery_status,t.ai_last_delivery_error
 FROM public.message_threads t WHERE t.org_id=o AND t.conversation_id=c LIMIT 1
), phones AS (
 SELECT CASE WHEN length(digits)=11 AND left(digits,1)='1' THEN '+'||digits
  WHEN length(digits)=10 THEN '+1'||digits ELSE NULL END AS phone_e164
 FROM (SELECT regexp_replace(coalesce(CASE WHEN (SELECT direction FROM latest)='inbound'
  THEN (SELECT from_address FROM latest) ELSE (SELECT to_address FROM latest) END,''),'[^0-9]','','g') AS digits) q
), contacts AS (
 SELECT c.* FROM public.contacts c WHERE c.org_id=o AND c.id=(SELECT contact_id FROM contact_ref)
), properties AS (
 SELECT p.* FROM public.properties p WHERE p.org_id=o AND p.id=(SELECT property_id FROM property_ref)
)
SELECT jsonb_build_object(
 'conversation_id',c,'contact_id',(SELECT contact_id FROM contact_ref),
 'contact_name',coalesce((SELECT entity_name FROM contacts),nullif(concat_ws(' ',(SELECT first_name FROM contacts),(SELECT last_name FROM contacts)),'')),
 'thread_customer_phone',CASE WHEN (SELECT direction FROM latest)='inbound' THEN (SELECT from_address FROM latest) ELSE (SELECT to_address FROM latest) END,
 'thread_business_phone',CASE WHEN (SELECT direction FROM latest)='inbound' THEN (SELECT to_address FROM latest) ELSE (SELECT from_address FROM latest) END,
 'property_id',(SELECT property_id FROM property_ref),
 'property_address',nullif(concat_ws(', ',(SELECT address FROM properties),(SELECT city FROM properties),(SELECT state FROM properties)),''),
 'assignee_id',(SELECT assigned_user_id FROM properties),
 'property_status',(SELECT status FROM properties),
 'outreach_dispo',(SELECT outreach_dispo FROM properties),
 'ai_disposition_review_id',(SELECT id FROM pending_review),
 'ai_disposition_review_status',(SELECT status FROM pending_review),
 'ai_disposition_review_disposition',(SELECT disposition FROM pending_review),
 'ai_disposition_review_reason',(SELECT ai_reason FROM pending_review),
 'ai_disposition_review_source_inbound_message_id',(SELECT source_inbound_message_id FROM pending_review),
 'ai_disposition_review_source_message_body',(SELECT source_message_body FROM pending_review),
 'ai_disposition_review_created_at',(SELECT created_at FROM pending_review),
 'contact_do_not_contact',coalesce((SELECT do_not_contact FROM contacts),false),
 'contact_sms_opted_out',coalesce((SELECT sms_opted_out FROM contacts),false),
 'phone_suppressed',CASE WHEN (SELECT contact_id FROM contact_ref) IS NULL THEN NULL ELSE EXISTS(SELECT 1 FROM public.sms_phone_suppressions s
   WHERE s.org_id=o AND s.channel='sms' AND s.phone_e164=(SELECT phone_e164 FROM phones)) END,
 'sms_safety_read_failed',false,
 'is_dnc_locked',coalesce((SELECT is_dnc_locked FROM properties),false),
 'ai_responder_status',(SELECT ai_responder_status FROM thread_state),
 'ai_responder_reason',(SELECT ai_responder_reason FROM thread_state),
 'ai_responder_status_at',(SELECT ai_responder_status_at FROM thread_state),
 'ai_last_delivery_status',(SELECT ai_last_delivery_status FROM thread_state),
 'ai_last_delivery_error',(SELECT ai_last_delivery_error FROM thread_state)
);
$$;
CREATE OR REPLACE FUNCTION inbox_read.detail(o uuid,c uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb;
BEGIN
 a:=inbox_bridge.authorize_serving(o);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_bridge.authorize_serving(o);
 WITH snapshot AS MATERIALIZED (
  SELECT inbox_authenticated_detail.detail_v2(o,c) || inbox_read.authoritative_context(o,c) AS data,
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
 PERFORM inbox_bridge.authorize_serving(o);
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION inbox_read.acknowledge(b uuid,batch_number integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; w inbox_read.boundaries; r inbox_read.receipts;
 current_generation uuid; current_head bigint; property_id uuid; changed_count integer; done boolean;
BEGIN
 IF b IS NULL OR batch_number IS NULL OR batch_number<0 THEN
  RAISE EXCEPTION 'INBOX_INVALID_READ_BATCH' USING ERRCODE='22023'; END IF;
 a:=inbox_bridge.authorize_serving(NULL);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_bridge.authorize_serving(NULL);
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
 a:=inbox_bridge.authorize_serving(w.org_id);
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
REVOKE ALL ON FUNCTION inbox_read.authoritative_context(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inbox_read.detail(uuid,uuid),inbox_read.acknowledge(uuid,integer) TO authenticated;
CREATE OR REPLACE FUNCTION public.inbox_read_detail(org_id uuid,conversation_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_read.detail(org_id,conversation_id)
$$;
CREATE OR REPLACE FUNCTION public.inbox_acknowledge_read(boundary_id uuid,batch_number integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_read.acknowledge(boundary_id,batch_number)
$$;
REVOKE ALL ON FUNCTION public.inbox_read_detail(uuid,uuid),public.inbox_acknowledge_read(uuid,integer)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_read_detail(uuid,uuid),public.inbox_acknowledge_read(uuid,integer) TO authenticated;
CREATE OR REPLACE FUNCTION inbox_read.history_page(o uuid,c uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb; position inbox_read.history_cursors;
 boundary inbox_read.boundaries; last_message jsonb; next_cursor uuid;
BEGIN
 a:=inbox_bridge.authorize_serving(o);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_bridge.authorize_serving(o);
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
  result:=inbox_authenticated_detail.detail_v2(o,c,position.before_at,position.before_id)
    || inbox_read.authoritative_context(o,c);
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
 PERFORM inbox_bridge.authorize_serving(o);
 IF boundary.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 RETURN result||jsonb_build_object('next_cursor',next_cursor);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_history_page(org_id uuid,conversation_id uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_read.history_page(org_id,conversation_id,before_cursor)
$$;
REVOKE ALL ON FUNCTION inbox_read.history_page(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_history_page(uuid,uuid,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION inbox_read.unknown_history_values(o uuid,g uuid,at_time timestamptz,before_id uuid) RETURNS jsonb
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
CREATE OR REPLACE FUNCTION inbox_read.unknown_history_page(o uuid,g uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb; position inbox_read.unknown_history_cursors;
 expires timestamptz:=clock_timestamp()+interval '5 minutes';last_message jsonb;next_cursor uuid;
BEGIN
 a:=inbox_bridge.authorize_serving(o);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR SHARE;
 a:=inbox_bridge.authorize_serving(o);
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
 PERFORM inbox_bridge.authorize_serving(o);
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 RETURN (result-'exists')||jsonb_build_object('requester_id',a->>'user_id','org_id',o,'sender_group_id',g,'next_cursor',next_cursor,'expires_at',expires);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_unknown_history_page(org_id uuid,sender_group_id uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_read.unknown_history_page(org_id,sender_group_id,before_cursor) $$;
REVOKE ALL ON FUNCTION inbox_read.unknown_history_values(uuid,uuid,timestamptz,uuid),inbox_read.unknown_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_unknown_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_unknown_history_page(uuid,uuid,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION inbox_bridge.authorized_scope(scope_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;w inbox_bridge.worksets;
BEGIN
 a:=inbox_bridge.authorize_serving(NULL);
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
 a:=inbox_bridge.authorize_serving(NULL);
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
-- Release companion guard; apply after the core read schema and maintained rows exist.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';

-- Reviewed read companion; install after inbox_read and serving authorization.
-- Selection classification uses the workset predicate on at most 100 requested
-- maintained rows. It never loads the complete matching workset.
CREATE OR REPLACE FUNCTION inbox_read.review_selection(o uuid,f jsonb,targets jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb; after_access jsonb; u uuid; result jsonb; target jsonb;
BEGIN
 a:=inbox_bridge.authorize_serving(o);u:=(a->>'user_id')::uuid;
 f:=inbox_bridge.normalize_filter(f);
 IF jsonb_typeof(targets) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(targets)<1 OR jsonb_array_length(targets)>100 THEN
  RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
 END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(targets) LOOP
  IF jsonb_typeof(target) IS DISTINCT FROM 'object' OR
   (target-ARRAY['kind','id'])<>'{}'::jsonb OR
   jsonb_typeof(target->'kind') IS DISTINCT FROM 'string' OR
   target->>'kind' NOT IN ('conversation','unknown_sender_group') OR
   jsonb_typeof(target->'id') IS DISTINCT FROM 'string' OR
   (target->>'id') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
   RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
  END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (value->>'kind',value->>'id')) FROM jsonb_array_elements(targets))<>jsonb_array_length(targets) THEN
  RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE='22023';
 END IF;
 WITH requested AS MATERIALIZED (
  SELECT value->>'kind' kind,(value->>'id')::uuid id,ordinal,
   CASE value->>'kind' WHEN 'conversation' THEN 'known_conversation' ELSE 'unknown_sender' END target_kind
  FROM jsonb_array_elements(targets) WITH ORDINALITY t(value,ordinal)
 ), p AS (SELECT f->>'view' AS view,(f->>'hide_noise')::boolean AS hide_noise,f->>'search' AS q),
 candidates AS MATERIALIZED (
  SELECT r.target_kind,r.target_id,r.summary s
  FROM requested t JOIN inbox_maintained.rows r ON r.org_id=o AND r.target_kind=t.target_kind AND r.target_id=t.id
  WHERE coalesce((r.summary->>'exists')::boolean,false)
  AND CASE WHEN t.kind='conversation' THEN EXISTS(SELECT 1 FROM public.messages m
    WHERE m.org_id=o AND m.conversation_id=t.id AND m.channel='sms')
   ELSE EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.channel='sms'
    AND m.direction='inbound' AND m.contact_id IS NULL AND m.from_address<>''
    AND md5(m.from_address)=md5(r.summary->>'raw_sender_key')
    AND m.from_address=r.summary->>'raw_sender_key') END
 ), matching AS (
  SELECT c.target_kind,c.target_id FROM candidates c CROSS JOIN p
-- BEGIN canonical workset matching predicate
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
 END
-- END canonical workset matching predicate
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',t.kind,'id',t.id,
  'status',CASE WHEN c.target_id IS NULL THEN 'unavailable' WHEN m.target_id IS NULL THEN 'outside_filter' ELSE 'matching' END,
  'name',CASE WHEN c.target_id IS NULL THEN NULL ELSE left(coalesce(nullif(c.s->>'contact_name',''),nullif(c.s->>'thread_customer_phone',''),nullif(c.s->>'raw_sender_key',''),'Conversation'),2000) END)
  ORDER BY t.ordinal),'[]'::jsonb) INTO result
 FROM requested t LEFT JOIN candidates c ON c.target_kind=t.target_kind AND c.target_id=t.id
 LEFT JOIN matching m ON m.target_kind=t.target_kind AND m.target_id=t.id;
 after_access:=inbox_bridge.authorize_serving(o);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'access_epoch') IS DISTINCT FROM
  (a->>'user_id',a->>'session_id',a->>'access_epoch') THEN
  RAISE EXCEPTION 'INBOX_ORG_DENIED' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('org_id',o,'requester_id',a->>'user_id','session_id',a->>'session_id',
  'access_epoch',a->>'access_epoch','items',result);
END $$;
REVOKE ALL ON FUNCTION inbox_read.review_selection(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.inbox_review_selection(org_id uuid,filter jsonb,targets jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=''
SET lock_timeout='3s' SET statement_timeout='15s' AS $$
 SELECT inbox_read.review_selection(org_id,filter,targets)
$$;
REVOKE ALL ON FUNCTION public.inbox_review_selection(uuid,jsonb,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_review_selection(uuid,jsonb,jsonb) TO authenticated;


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