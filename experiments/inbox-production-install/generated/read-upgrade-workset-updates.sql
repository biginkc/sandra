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
-- Additive current-workset update probe.  This is installer/rehearsal SQL only;
-- it is not a supabase migration and must run only on the explicitly marked
-- release database.

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';



-- `source_cursor_bound=false` is deliberately distinct from a first-page
-- origin (`true` + source_cursor_id IS NULL).  Pre-upgrade worksets therefore
-- cannot be interpreted as first-page snapshots by the probe; they require an
-- explicit user refresh that creates a new scope with this metadata.
ALTER TABLE inbox_bridge.worksets
  ADD COLUMN IF NOT EXISTS source_cursor_id uuid,
  ADD COLUMN IF NOT EXISTS source_cursor_bound boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_page_limit integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbox_bridge.worksets'::regclass
      AND conname = 'worksets_source_cursor_origin_check'
  ) THEN
    ALTER TABLE inbox_bridge.worksets
      ADD CONSTRAINT worksets_source_cursor_origin_check
      CHECK (source_cursor_bound OR source_cursor_id IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbox_bridge.worksets'::regclass
      AND conname = 'worksets_source_page_limit_check'
  ) THEN
    ALTER TABLE inbox_bridge.worksets
      ADD CONSTRAINT worksets_source_page_limit_check
      CHECK (source_page_limit IS NULL OR source_page_limit BETWEEN 1 AND 500);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbox_bridge.worksets'::regclass
      AND conname = 'worksets_source_origin_complete_check'
  ) THEN
    ALTER TABLE inbox_bridge.worksets
      ADD CONSTRAINT worksets_source_origin_complete_check
      CHECK (NOT source_cursor_bound OR source_page_limit IS NOT NULL);
  END IF;
END;
$$;

-- Preserve the reviewed v2 creation semantics.  The only new write is the
-- immutable page-origin binding captured in the same INSERT as the workset;
-- cursor authorization and scope replacement remain owned by this transaction.
CREATE OR REPLACE FUNCTION public.inbox_create_workset_v2(
  org_id uuid,
  filter jsonb,
  "limit" integer,
  replaces_scope_id uuid DEFAULT NULL,
  cursor_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
SET statement_timeout = '20s'
AS $$
DECLARE
  a jsonb;
  u uuid;
  sid uuid;
  e bigint;
  now_at timestamptz;
  prior inbox_bridge.worksets;
  created inbox_bridge.worksets;
  ids jsonb;
  gen bigint;
  last_at timestamptz;
  f jsonb;
  n integer := "limit";
  replaces uuid := replaces_scope_id;
  cur inbox_bridge.cursor_context;
  page_rows jsonb;
  last_row jsonb;
  next_id uuid;
BEGIN
  f := inbox_bridge.normalize_filter(filter);
  IF n IS NULL OR n < 1 OR n > 500 THEN
    RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE = '22023';
  END IF;

  a := inbox_bridge.authorize_serving(org_id);
  u := (a->>'user_id')::uuid;
  sid := (a->>'session_id')::uuid;

  -- Persistent actor row serializes generation allocation, access capture,
  -- cursor-origin validation, and replacement.
  PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id = u FOR UPDATE;
  a := inbox_bridge.authorize_serving(org_id);
  e := (a->>'access_epoch')::bigint;
  now_at := clock_timestamp();

  SELECT max(generation), max(created_at)
    INTO gen, last_at
    FROM inbox_bridge.worksets
   WHERE user_id = u AND session_id = sid;
  IF last_at > now_at - interval '1 second' THEN
    RAISE EXCEPTION 'INBOX_GENERATION_RATE' USING ERRCODE = '55000';
  END IF;

  IF replaces IS NOT NULL THEN
    SELECT * INTO prior FROM inbox_bridge.worksets WHERE id = replaces FOR UPDATE;
    IF NOT FOUND
       OR prior.user_id <> u
       OR prior.session_id <> sid
       OR prior.org_id <> org_id
       OR prior.access_epoch <> e
       OR prior.revoked THEN
      RAISE EXCEPTION 'INBOX_REPLACEMENT_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF (
    SELECT count(*)
      FROM inbox_bridge.worksets
     WHERE user_id = u
       AND session_id = sid
       AND NOT revoked
       AND expires_at > now_at
       AND id IS DISTINCT FROM replaces
  ) >= 2 THEN
    RAISE EXCEPTION 'INBOX_GENERATION_LIMIT' USING ERRCODE = '55000';
  END IF;

  IF cursor_id IS NOT NULL THEN
    SELECT w.id, w.org_id, w.user_id, w.session_id, w.access_epoch,
           w.generation, w.created_at, w.expires_at, w.filter, w.targets,
           w.handles, w.revoked, c.latest_at AS cursor_at,
           c.target_kind AS cursor_kind, c.target_id AS cursor_target
      INTO cur
      FROM inbox_bridge.cursors c
      JOIN inbox_bridge.worksets w ON w.id = c.scope_id
     WHERE c.id = cursor_id;
    IF NOT FOUND
       OR cur.user_id <> u
       OR cur.session_id <> sid
       OR cur.org_id <> org_id
       OR cur.access_epoch <> e
       OR cur.expires_at <= now_at
       OR cur.revoked
       OR cur.filter IS DISTINCT FROM f THEN
      RAISE EXCEPTION 'INBOX_CURSOR_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT coalesce(
           jsonb_agg(to_jsonb(rows) ORDER BY latest_at DESC NULLS LAST,
                    target_kind, target_id), '[]'::jsonb
         )
    INTO page_rows
    FROM (
      SELECT *
        FROM inbox_bridge.page(
          org_id,
          u,
          f,
          cur.cursor_at,
          cur.cursor_kind,
          cur.cursor_target,
          cursor_id IS NOT NULL,
          n + 1
        )
    ) rows;

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object('kind', x->>'target_kind', 'id', x->>'target_id')
             ORDER BY ordinal
           ), '[]'::jsonb
         )
    INTO ids
    FROM jsonb_array_elements(page_rows) WITH ORDINALITY elements(x, ordinal)
   WHERE ordinal <= n;

  INSERT INTO inbox_bridge.worksets(
    org_id, user_id, session_id, access_epoch, generation,
    created_at, expires_at, filter, targets, handles,
    source_cursor_id, source_cursor_bound, source_page_limit
  )
  VALUES (
    org_id, u, sid, e, coalesce(gen, 0) + 1,
    now_at,
    least(now_at + interval '15 minutes', (a->>'expires_at')::timestamptz),
    f,
    ids,
    (
      SELECT jsonb_agg(null::text)
        FROM generate_series(1, greatest(1, (jsonb_array_length(ids) + 99) / 100))
    ),
    cursor_id,
    true,
    n
  )
  RETURNING * INTO created;

  IF replaces IS NOT NULL THEN
    UPDATE inbox_bridge.worksets SET revoked = true WHERE id = replaces;
  END IF;

  IF jsonb_array_length(page_rows) > n THEN
    last_row := page_rows->(n - 1);
    INSERT INTO inbox_bridge.cursors(scope_id, latest_at, target_kind, target_id)
    VALUES (
      created.id,
      (last_row->>'latest_at')::timestamptz,
      last_row->>'target_kind',
      (last_row->>'target_id')::uuid
    )
    RETURNING id INTO next_id;
  END IF;

  RETURN inbox_bridge.scope_json(created)
      || jsonb_build_object(
           'next_cursor', next_id,
           'refreshed', cursor_id IS NOT NULL
         );
END;
$$;

-- A probe never writes worksets, cursors, handles, or projection rows.  It
-- reads the source cursor captured by the creation transaction, re-checks the
-- current authenticated organization/session/epoch, and compares only the
-- bounded page represented by this scope.  A revoked source scope is allowed
-- as an origin: replacing a page revokes its predecessor but must not erase
-- the cursor required to observe that same page again.
CREATE OR REPLACE FUNCTION inbox_bridge.probe_current_workset(scope_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
SET statement_timeout = '10s'
AS $$
DECLARE
  a jsonb;
  after jsonb;
  after_scope inbox_bridge.worksets;
  w inbox_bridge.worksets;
  cursor_row inbox_bridge.cursors;
  current_targets jsonb;
  page_limit integer;
  has_cursor boolean;
BEGIN
  IF scope_id IS NULL THEN
    RAISE EXCEPTION 'INBOX_SCOPE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO w FROM inbox_bridge.worksets WHERE id = scope_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INBOX_SCOPE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  a := inbox_bridge.authorize_serving(w.org_id);
  IF w.user_id <> (a->>'user_id')::uuid
     OR w.session_id <> (a->>'session_id')::uuid
     OR w.access_epoch <> (a->>'access_epoch')::bigint
     OR w.revoked
     OR w.expires_at <= clock_timestamp()
     OR (a->>'expires_at')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'INBOX_SCOPE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  IF NOT w.source_cursor_bound THEN
    RETURN jsonb_build_object(
      'has_updates', false,
      'refresh_required', true,
      'scope_id', w.id,
      'org_id', w.org_id,
      'requester_id', w.user_id,
      'session_id', w.session_id,
      'access_epoch', w.access_epoch::text,
      'generation', w.generation::text
    );
  END IF;

  has_cursor := w.source_cursor_id IS NOT NULL;
  IF has_cursor THEN
    SELECT c.* INTO cursor_row
      FROM inbox_bridge.cursors c
      JOIN inbox_bridge.worksets origin_scope ON origin_scope.id = c.scope_id
     WHERE c.id = w.source_cursor_id
       AND origin_scope.org_id = w.org_id
       AND origin_scope.user_id = w.user_id
       AND origin_scope.session_id = w.session_id
       AND origin_scope.access_epoch = w.access_epoch;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'has_updates', false,
        'refresh_required', true,
        'scope_id', w.id,
        'org_id', w.org_id,
        'requester_id', w.user_id,
        'session_id', w.session_id,
        'access_epoch', w.access_epoch::text,
        'generation', w.generation::text
      );
    END IF;
  END IF;

  page_limit := w.source_page_limit;
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 500 THEN
    RAISE EXCEPTION 'INBOX_SCOPE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object('kind', rows.target_kind, 'id', rows.target_id)
             ORDER BY rows.latest_at DESC NULLS LAST,
                      rows.target_kind, rows.target_id
           ),
           '[]'::jsonb
         )
    INTO current_targets
    FROM inbox_bridge.page(
      w.org_id,
      w.user_id,
      w.filter,
      CASE WHEN has_cursor THEN cursor_row.latest_at ELSE NULL END,
      CASE WHEN has_cursor THEN cursor_row.target_kind ELSE NULL END,
      CASE WHEN has_cursor THEN cursor_row.target_id ELSE NULL END,
      has_cursor,
      page_limit
    ) rows;

  -- Re-read identity after the bounded bridge.page call.  A revocation or
  -- epoch change that commits while the probe is running must invalidate the
  -- result instead of returning a late arrival signal for a stale scope.
  after := inbox_bridge.authorize_serving(w.org_id);
  IF after->>'user_id' IS DISTINCT FROM a->>'user_id'
     OR after->>'session_id' IS DISTINCT FROM a->>'session_id'
     OR after->>'org_id' IS DISTINCT FROM a->>'org_id'
     OR after->>'access_epoch' IS DISTINCT FROM a->>'access_epoch'
     OR (after->>'expires_at')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO after_scope FROM inbox_bridge.worksets WHERE id = scope_id;
  IF NOT FOUND
     OR after_scope.revoked
     OR after_scope.expires_at <= clock_timestamp()
     OR after_scope.org_id IS DISTINCT FROM w.org_id
     OR after_scope.user_id IS DISTINCT FROM w.user_id
     OR after_scope.session_id IS DISTINCT FROM w.session_id
     OR after_scope.access_epoch IS DISTINCT FROM w.access_epoch
     OR after_scope.generation IS DISTINCT FROM w.generation
     OR after_scope.filter IS DISTINCT FROM w.filter
     OR after_scope.targets IS DISTINCT FROM w.targets
     OR after_scope.source_cursor_id IS DISTINCT FROM w.source_cursor_id
     OR after_scope.source_cursor_bound IS DISTINCT FROM w.source_cursor_bound
     OR after_scope.source_page_limit IS DISTINCT FROM w.source_page_limit THEN
    RAISE EXCEPTION 'INBOX_SCOPE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'has_updates', current_targets IS DISTINCT FROM w.targets,
    'refresh_required', false,
    'scope_id', w.id,
    'org_id', w.org_id,
    'requester_id', w.user_id,
    'session_id', w.session_id,
    'access_epoch', w.access_epoch::text,
    'generation', w.generation::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.inbox_probe_workset_updates(scope_id uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
SET statement_timeout = '10s'
AS $$ SELECT inbox_bridge.probe_current_workset(scope_id) $$;

REVOKE ALL ON FUNCTION inbox_bridge.probe_current_workset(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_probe_workset_updates(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.inbox_probe_workset_updates(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';

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