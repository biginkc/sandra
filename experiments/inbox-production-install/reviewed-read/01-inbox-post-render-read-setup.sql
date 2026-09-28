-- Owned T2 candidate only. Not a production migration or an enabled endpoint.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(
  SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic'
 ) THEN RAISE EXCEPTION 'Owned fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_read;
REVOKE ALL ON SCHEMA inbox_t2_read FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_read.boundaries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid NOT NULL,
 org_id uuid NOT NULL, conversation_id uuid NOT NULL, generation uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>=0), created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, execution_deadline timestamptz,
 next_batch integer NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false,
 session_id uuid NOT NULL, access_epoch bigint NOT NULL
);
CREATE TABLE inbox_t2_read.receipts (
 boundary_id uuid NOT NULL REFERENCES inbox_t2_read.boundaries(id), batch integer NOT NULL,
 changed integer NOT NULL CHECK(changed BETWEEN 0 AND 200), completed boolean NOT NULL,
 PRIMARY KEY(boundary_id,batch)
);
ALTER TABLE inbox_t2_read.boundaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_read.receipts ENABLE ROW LEVEL SECURITY;

-- The history/detail projection above deliberately contains only message
-- bodies and receipt metadata.  Individual controls also need the
-- conversation's authoritative target and safety context.  Resolve that
-- context from the canonical tables in the same caller statement; never infer
-- property, phone, AI-review, responder, or DNC state from the history page.
-- This helper is private to inbox_t2_read.detail/history_page and is not a
-- browser API by itself.
CREATE FUNCTION inbox_t2_read.authoritative_context(o uuid,c uuid) RETURNS jsonb
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
REVOKE ALL ON FUNCTION inbox_t2_read.authoritative_context(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- The data snapshot and its stored boundary are created in ONE statement. The
-- STABLE canonical detail function and generation CTE share that statement snapshot.
-- No message is marked read here; recording a boundary does not acknowledge it.
CREATE FUNCTION inbox_t2_read.detail(o uuid,c uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb;
BEGIN
 a:=inbox_t2_bridge.authorize(o);
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_t2_bridge.authorize(o);
 WITH snapshot AS MATERIALIZED (
  SELECT inbox_t2_authenticated_detail.detail_v2(o,c) || inbox_t2_read.authoritative_context(o,c) AS data,
   g.generation FROM inbox_t2_capture_boundary.generation g WHERE singleton IS TRUE
 ), recorded AS (
  INSERT INTO inbox_t2_read.boundaries(requester_id,org_id,conversation_id,generation,revision,created_at,expires_at,session_id,access_epoch)
  SELECT (a->>'user_id')::uuid,o,c,s.generation,(s.data->>'head_revision')::bigint,
   statement_timestamp(),least(statement_timestamp()+interval '5 minutes',(a->>'expires_at')::timestamptz),
   (a->>'session_id')::uuid,(a->>'access_epoch')::bigint
  FROM snapshot s RETURNING id,expires_at
 ) SELECT s.data || jsonb_build_object('read_boundary',r.id,'boundary_expires_at',r.expires_at,
  'capture_generation',s.generation) INTO result FROM snapshot s CROSS JOIN recorded r;
 IF result IS NULL THEN RAISE EXCEPTION 'INBOX_CAPTURE_METADATA_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM inbox_t2_bridge.authorize(o);
 RETURN result;
END $$;

-- A caller advances the batch number only after receiving its committed receipt.
-- A lost response retries the SAME boundary/batch, including after completion.
-- No SKIP LOCKED: an empty batch cannot conceal a locked eligible message.
CREATE FUNCTION inbox_t2_read.acknowledge(b uuid,batch_number integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; w inbox_t2_read.boundaries; r inbox_t2_read.receipts;
 current_generation uuid; current_head bigint; property_id uuid; changed_count integer; done boolean;
BEGIN
 IF b IS NULL OR batch_number IS NULL OR batch_number<0 THEN
  RAISE EXCEPTION 'INBOX_INVALID_READ_BATCH' USING ERRCODE='22023'; END IF;
 a:=inbox_t2_bridge.authorize(NULL);
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_t2_bridge.authorize(NULL);
 SELECT * INTO w FROM inbox_t2_read.boundaries WHERE id=b FOR UPDATE;
 IF NOT FOUND OR w.requester_id<>(a->>'user_id')::uuid OR w.org_id<>(a->>'org_id')::uuid
  OR w.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR w.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
  RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM inbox_t2_read.receipts WHERE boundary_id=b AND batch=batch_number;
 IF FOUND THEN RETURN jsonb_build_object('boundary_id',b,'batch',r.batch,'changed',r.changed,'completed',r.completed); END IF;
 IF w.completed OR batch_number<>w.next_batch THEN
  RAISE EXCEPTION 'INBOX_READ_BATCH_CONFLICT' USING ERRCODE='55000'; END IF;
 IF (w.execution_deadline IS NULL AND w.expires_at<=clock_timestamp()) OR w.execution_deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000'; END IF;
 -- Serialize capture resets with this whole batch, without locking the arrival head.
 SELECT generation INTO current_generation FROM inbox_t2_capture_boundary.generation WHERE singleton IS TRUE FOR SHARE;
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
 a:=inbox_t2_bridge.authorize(w.org_id);
 IF w.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
  RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF (w.execution_deadline IS NULL AND w.expires_at<=clock_timestamp()) OR w.execution_deadline<=clock_timestamp() THEN
  RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000'; END IF;
 SELECT NOT EXISTS(SELECT 1 FROM public.messages WHERE org_id=w.org_id AND conversation_id=w.conversation_id
  AND channel='sms' AND direction='inbound' AND read_at IS NULL AND inbox_inbound_revision<=w.revision) INTO done;
 INSERT INTO inbox_t2_read.receipts VALUES(b,batch_number,changed_count,done);
 UPDATE inbox_t2_read.boundaries SET next_batch=next_batch+1,completed=done,
  execution_deadline=coalesce(execution_deadline,clock_timestamp()+interval '10 minutes') WHERE id=b;
 RETURN jsonb_build_object('boundary_id',b,'batch',batch_number,'changed',changed_count,'completed',done);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_read FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_read FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA inbox_t2_read TO authenticated;
GRANT EXECUTE ON FUNCTION inbox_t2_read.detail(uuid,uuid),inbox_t2_read.acknowledge(uuid,integer) TO authenticated;
COMMIT;
