-- RULING REPLY-PERSISTENCE v5: full-snapshot public.messages projection.
-- Additive activation-blocking migration. The three preceding Inbox
-- migrations remain byte-identical; this file owns only the message
-- projection, its retry backlog, the worker persist replay wrapper, and the
-- history fields required by the ruling.
--
-- Drips migration 20260930035000 is intentionally not copied here. T24-T26
-- load the merged migration into their disposable fixture verbatim; this
-- branch owns no Drips text.

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';

CREATE TABLE inbox_reply_send.message_projection_backlog(
 org_id uuid NOT NULL,
 attempt_id uuid NOT NULL,
 wanted_version bigint NOT NULL,
 tries integer NOT NULL DEFAULT 0 CHECK(tries>=0),
 last_code text,
 next_try_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,attempt_id),
 FOREIGN KEY(org_id,attempt_id) REFERENCES inbox_reply_send.attempts(org_id,id)
);
ALTER TABLE inbox_reply_send.message_projection_backlog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_reply_send.message_projection_backlog FROM PUBLIC,anon,authenticated,service_role,inbox_reply_send_worker;

-- A full snapshot is rebuilt for every ledger state. No UPDATE ever inserts a
-- missing message: a missing target is a durable projection failure.
CREATE FUNCTION inbox_reply_send.project_message(o uuid,attempt_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 row inbox_reply_send.attempts;
 item jsonb;
 marker jsonb;
 projected_metadata jsonb;
 projected_status text;
 projected_external_id text;
 projected_sent_at timestamptz;
 projected_delivered_at timestamptz;
 projected_failed_at timestamptz;
 projected_error text;
 changed integer;
BEGIN
 SELECT * INTO row
 FROM inbox_reply_send.attempts a
 WHERE a.org_id=o AND a.id=attempt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_PROJECTION_TARGET';END IF;
 IF row.state IN ('approved','claimed','skipped_ineligible') THEN RETURN;END IF;

 item:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 marker:=jsonb_build_object('attemptId',row.id,'operationId',row.operation_id);
 projected_status:=CASE row.state
  WHEN 'dispatch_started' THEN 'pending'
  WHEN 'provider_accepted' THEN 'sent'
  WHEN 'delivered' THEN 'delivered'
  WHEN 'delivery_failed' THEN 'failed'
  WHEN 'uncertain' THEN 'failed'
  WHEN 'confirmed_not_submitted' THEN 'failed'
  WHEN 'rejected_unsent' THEN 'failed'
  ELSE NULL
 END;
 IF projected_status IS NULL THEN RAISE EXCEPTION 'INBOX_REPLY_PROJECTION_TARGET';END IF;

 projected_external_id:=CASE WHEN row.state IN ('provider_accepted','delivered','delivery_failed') THEN row.provider_reference ELSE NULL END;
 projected_sent_at:=CASE WHEN row.state IN ('provider_accepted','delivered','delivery_failed') THEN clock_timestamp() ELSE NULL END;
 projected_delivered_at:=CASE WHEN row.state='delivered' THEN clock_timestamp() ELSE NULL END;
 projected_failed_at:=CASE WHEN row.state IN ('delivery_failed','uncertain','confirmed_not_submitted','rejected_unsent') THEN clock_timestamp() ELSE NULL END;
 projected_error:=CASE WHEN row.state IN ('delivery_failed','uncertain','confirmed_not_submitted','rejected_unsent') THEN row.evidence ELSE NULL END;

 projected_metadata:=jsonb_build_object('inboxReply',marker);
 IF row.provider_reference IS NOT NULL THEN
  projected_metadata:=projected_metadata||jsonb_build_object('providerStatus',row.provider_status);
 ELSIF row.state='uncertain' THEN
  projected_metadata:=projected_metadata||jsonb_build_object('providerOutcome','provider_unknown');
 END IF;

 -- Lock order is attempt -> backlog -> message. The caller already holds the
 -- attempt lock; this function deliberately locks only the exact target row.
 UPDATE public.messages AS m
 SET status=projected_status,
     external_id=projected_external_id,
     sent_at=CASE WHEN projected_sent_at IS NULL THEN NULL ELSE coalesce(m.sent_at,projected_sent_at) END,
     delivered_at=CASE WHEN projected_delivered_at IS NULL THEN NULL ELSE coalesce(m.delivered_at,projected_delivered_at) END,
     failed_at=CASE WHEN projected_failed_at IS NULL THEN NULL ELSE coalesce(m.failed_at,projected_failed_at) END,
     error_message=projected_error,
     metadata=projected_metadata
 WHERE m.org_id=o
   AND m.idempotency_key=row.id
   AND m.channel='sms'
   AND m.direction='outbound'
   AND m.metadata->'inboxReply'->>'attemptId'=row.id::text
   AND m.contact_id=row.contact_id
   AND m.from_address=row.from_e164
   AND m.to_address=row.to_e164;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'INBOX_REPLY_PROJECTION_TARGET';END IF;
END $$;

CREATE FUNCTION inbox_reply_send.project_message_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.state='dispatch_started' THEN
  -- Marker edge: deliberately plain and uncaught. Any conflict or trigger
  -- failure aborts the marker before a provider call can occur.
  INSERT INTO public.messages(
   org_id,contact_id,from_address,to_address,channel,direction,status,provider,
   campaign_id,property_id,conversation_id,body,idempotency_key,metadata
  )
  SELECT NEW.org_id,NEW.contact_id,NEW.from_e164,NEW.to_e164,'sms','outbound','pending','sendillo',
   NULL,(inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id)->'recipient'->>'propertyId')::uuid,
   (inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id)->'target'->>'id')::uuid,
   inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id)->'recipient'->>'renderedBody',
   NEW.id,jsonb_build_object('inboxReply',jsonb_build_object('attemptId',NEW.id,'operationId',NEW.operation_id));
  RETURN NEW;
 END IF;

 -- Post-marker ledger edges must have a durable retry row before their
 -- projection savepoint. A backlog failure is intentionally not caught.
 INSERT INTO inbox_reply_send.message_projection_backlog(org_id,attempt_id,wanted_version)
 VALUES(NEW.org_id,NEW.id,NEW.receipt_version)
 ON CONFLICT(org_id,attempt_id) DO UPDATE SET wanted_version=EXCLUDED.wanted_version;
 BEGIN
  PERFORM inbox_reply_send.project_message(NEW.org_id,NEW.id);
  DELETE FROM inbox_reply_send.message_projection_backlog
   WHERE org_id=NEW.org_id AND attempt_id=NEW.id;
 EXCEPTION WHEN query_canceled OR others THEN
  -- The savepoint is projection-only. Its handler writes nothing and cannot
  -- swallow the ledger update or the backlog upsert above.
  NULL;
 END;
 RETURN NEW;
END $$;

CREATE TRIGGER inbox_reply_message_projection
AFTER UPDATE OF state ON inbox_reply_send.attempts
FOR EACH ROW
WHEN (NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('dispatch_started','provider_accepted','uncertain','confirmed_not_submitted','rejected_unsent','delivered','delivery_failed'))
EXECUTE FUNCTION inbox_reply_send.project_message_trigger();
REVOKE ALL ON FUNCTION inbox_reply_send.project_message(uuid,uuid),inbox_reply_send.project_message_trigger() FROM PUBLIC,anon,authenticated,service_role,inbox_reply_send_worker;

-- One item per call. The candidate read is unlocked; the attempt and then the
-- backlog row are locked outside the projection savepoint, preserving the
-- ruling's attempt -> backlog -> message lock order.
CREATE FUNCTION inbox_reply_send.drain_message_projection_one() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 key_row record;
 attempt_row inbox_reply_send.attempts;
 backlog_row inbox_reply_send.message_projection_backlog;
 failure_code text;
 next_tries integer;
BEGIN
 SELECT b.org_id,b.attempt_id INTO key_row
 FROM inbox_reply_send.message_projection_backlog b
 WHERE b.next_try_at<=clock_timestamp()
 ORDER BY b.next_try_at,b.attempt_id
 LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('drained',false,'reason','empty');END IF;

 SELECT * INTO attempt_row
 FROM inbox_reply_send.attempts a
 WHERE a.org_id=key_row.org_id AND a.id=key_row.attempt_id
 FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('drained',false,'reason','attempt_missing');END IF;
 SELECT * INTO backlog_row
 FROM inbox_reply_send.message_projection_backlog b
 WHERE b.org_id=key_row.org_id AND b.attempt_id=key_row.attempt_id
 FOR UPDATE;
 IF NOT FOUND OR backlog_row.next_try_at>clock_timestamp() THEN
  RETURN jsonb_build_object('drained',false,'reason','not_due');
 END IF;

 BEGIN
  PERFORM inbox_reply_send.project_message(key_row.org_id,key_row.attempt_id);
  DELETE FROM inbox_reply_send.message_projection_backlog b
   WHERE b.org_id=key_row.org_id AND b.attempt_id=key_row.attempt_id;
  RETURN jsonb_build_object('drained',true,'projected',true,'attempt_id',key_row.attempt_id);
 -- Deliberately omit query_canceled: cancellation aborts this transaction and
 -- rolls back any tries bump; a cancelled drain must not count as a retry.
 EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS failure_code=RETURNED_SQLSTATE;
  next_tries:=backlog_row.tries+1;
  UPDATE inbox_reply_send.message_projection_backlog b
  SET tries=next_tries,
      last_code=failure_code,
      next_try_at=clock_timestamp()+make_interval(secs=>least(3600,power(2::numeric,least(next_tries,12))::integer))
  WHERE b.org_id=key_row.org_id AND b.attempt_id=key_row.attempt_id;
  RETURN jsonb_build_object('drained',true,'projected',false,'attempt_id',key_row.attempt_id,'tries',next_tries,'last_code',failure_code);
 END;
END $$;
REVOKE ALL ON FUNCTION inbox_reply_send.drain_message_projection_one() FROM PUBLIC,anon,authenticated,service_role,inbox_reply_send_worker;

CREATE FUNCTION public.inbox_reply_drain_message_projection_one() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='20s' AS $$
BEGIN
 RETURN inbox_reply_send.drain_message_projection_one();
END $$;
REVOKE ALL ON FUNCTION public.inbox_reply_drain_message_projection_one() FROM PUBLIC,anon,authenticated,inbox_reply_send_worker;
GRANT EXECUTE ON FUNCTION public.inbox_reply_drain_message_projection_one() TO service_role;

-- Durable worker-facing replay wrapper. It locks and validates before
-- delegating to the frozen persist() body; the two replay cases below never
-- create a new ledger edge and never call the provider again.
CREATE FUNCTION inbox_reply_send.worker_persist_result(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE
 row inbox_reply_send.attempts;
 kind text;
 reason text;
 reference text;
BEGIN
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR token IS NULL OR row.dispatch_token IS DISTINCT FROM token THEN RAISE EXCEPTION 'INBOX_REPLY_STALE_TOKEN';END IF;
 IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid dispatch result';END IF;
 kind:=result->>'kind';
 IF kind IS NULL OR kind NOT IN ('accepted','not_attempted','uncertain') THEN RAISE EXCEPTION 'Invalid dispatch result';END IF;
 IF kind='accepted' THEN
  reference:=result->>'externalId';
  IF reference IS NULL OR btrim(reference)='' OR octet_length(reference)>512 THEN RAISE EXCEPTION 'Invalid provider reference';END IF;
 ELSIF kind='not_attempted' THEN
  reason:=result->>'reason';
  IF reason IS NULL OR reason NOT IN ('invalid_input','cancelled_before_dispatch') THEN RAISE EXCEPTION 'Invalid not_attempted reason';END IF;
 END IF;
 IF row.state='confirmed_not_submitted' THEN
  IF kind='not_attempted' AND row.evidence IS NOT DISTINCT FROM 'local_not_attempted:'||reason THEN
   RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
  END IF;
  RAISE EXCEPTION 'INBOX_REPLY_CONTRADICTORY_RECEIPT';
 ELSIF row.state='uncertain' AND kind='not_attempted' THEN
  RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
 END IF;
 RETURN inbox_reply_send.persist(o,attempt_id,token,result);
END $$;

-- The pre-existing worker role was granted the raw wrapper in 040200. Replace
-- that allow-list with the ruling's replay wrapper and re-run the exact
-- constrained-principal check.
REVOKE ALL ON FUNCTION inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb) FROM inbox_reply_send_worker;
REVOKE ALL ON FUNCTION inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb) TO inbox_reply_send_worker;
DO $$
BEGIN
 IF EXISTS(
  SELECT 1
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='inbox_reply_send'
    AND p.prosecdef
    AND p.prorettype<>'trigger'::regtype
    AND has_function_privilege('inbox_reply_send_worker',p.oid,'EXECUTE')
    AND p.oid<>ALL(ARRAY[
      'inbox_reply_send.claim_dispatch_batch(integer)'::regprocedure,
      'inbox_reply_send.ack_dispatch(uuid,uuid,bigint)'::regprocedure,
      'inbox_reply_send.operation_dispatch_complete(uuid,uuid)'::regprocedure,
      'inbox_reply_send.operation_attempts(uuid,uuid)'::regprocedure,
      'inbox_reply_send.worker_claim(uuid,uuid,integer)'::regprocedure,
      'inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint)'::regprocedure,
      'inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb)'::regprocedure]::oid[])
 ) THEN RAISE EXCEPTION 'Reply-send worker unexpectedly reaches another privileged function';END IF;
END $$;

-- History projection: preserve the existing access/keyset behavior and add
-- failed state rendered as not_confirmed; inbound messages are already
-- delivered to the workspace.
CREATE OR REPLACE FUNCTION inbox_authenticated_detail.detail(p_org uuid,p_conversation uuid,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE visible_orgs uuid[]; requester uuid:=auth.uid(); result jsonb;
BEGIN
 IF requester IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';END IF;
 IF p_org IS NULL OR p_conversation IS NULL OR ((p_before IS NULL) <> (p_before_id IS NULL)) THEN RAISE EXCEPTION 'INBOX_INVALID_ARGUMENT' USING ERRCODE='22023';END IF;
 SELECT array_agg(m.org_id ORDER BY m.org_id) INTO visible_orgs
 FROM public.memberships m
 WHERE m.user_id=requester AND m.access_status='active' AND m.deletion_prepared_at IS NULL
 AND (m.access_expires_at IS NULL OR m.access_expires_at>statement_timestamp())
 AND EXISTS(SELECT 1 FROM public.messages x WHERE x.org_id=m.org_id AND x.conversation_id=p_conversation AND x.channel='sms');
 IF coalesce(cardinality(visible_orgs),0)>1 THEN RAISE EXCEPTION 'SMS_CONVERSATION_ORG_AMBIGUOUS' USING ERRCODE='P0001';END IF;
 IF coalesce(cardinality(visible_orgs),0)<>1 OR visible_orgs[1] IS DISTINCT FROM p_org THEN RAISE EXCEPTION 'INBOX_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 WITH head AS MATERIALIZED (
  SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads WHERE org_id=p_org AND conversation_id=p_conversation),0)::text AS revision
 ), page AS MATERIALIZED (
  SELECT id,created_at FROM public.messages WHERE org_id=p_org AND conversation_id=p_conversation AND channel='sms'
   AND (p_before IS NULL OR (created_at,id)<(p_before,p_before_id)) ORDER BY created_at DESC,id DESC LIMIT 50
 ), bodies AS (
  SELECT m.id,p.created_at,m.body,m.direction,m.read_at,m.inbox_inbound_revision,m.status,m.metadata
  FROM page p JOIN public.messages m ON m.id=p.id AND m.org_id=p_org AND m.conversation_id=p_conversation AND m.channel='sms'
 ) SELECT jsonb_build_object('requester_id',requester,'org_id',p_org,'conversation_id',p_conversation,'head_revision',(SELECT revision FROM head),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'created_at_raw',b.created_at::text,'body',b.body,'direction',b.direction,
   'read_at_raw',b.read_at::text,'inbound_revision',b.inbox_inbound_revision::text,'status',b.status,'delivery',
   CASE WHEN b.direction='inbound' THEN 'delivered'
    WHEN b.status IN ('pending','queued') THEN 'sending'
    WHEN b.status='failed' AND b.metadata->>'providerOutcome'='provider_unknown' THEN 'not_confirmed'
    WHEN b.status IN ('sent','delivered') THEN b.status
    WHEN b.status IN ('failed','bounced') THEN 'failed'
    ELSE 'failed' END)
   ORDER BY b.created_at DESC,b.id DESC) FROM bodies b),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION inbox_authenticated_detail.detail(uuid,uuid,timestamptz,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inbox_authenticated_detail.detail(uuid,uuid,timestamptz,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION inbox_authenticated_detail.detail_v2(p_org uuid,p_conversation uuid,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE visible_orgs uuid[]; requester uuid:=auth.uid(); result jsonb;
BEGIN
 IF requester IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';END IF;
 IF p_org IS NULL OR p_conversation IS NULL OR ((p_before IS NULL) <> (p_before_id IS NULL)) THEN RAISE EXCEPTION 'INBOX_INVALID_ARGUMENT' USING ERRCODE='22023';END IF;
 SELECT array_agg(m.org_id ORDER BY m.org_id) INTO visible_orgs
 FROM public.memberships m
 WHERE m.user_id=requester AND m.access_status='active' AND m.deletion_prepared_at IS NULL
 AND (m.access_expires_at IS NULL OR m.access_expires_at>statement_timestamp())
 AND EXISTS(SELECT 1 FROM public.messages x WHERE x.org_id=m.org_id AND x.conversation_id=p_conversation AND x.channel='sms');
 IF coalesce(cardinality(visible_orgs),0)>1 THEN RAISE EXCEPTION 'SMS_CONVERSATION_ORG_AMBIGUOUS' USING ERRCODE='P0001';END IF;
 IF coalesce(cardinality(visible_orgs),0)<>1 OR visible_orgs[1] IS DISTINCT FROM p_org THEN RAISE EXCEPTION 'INBOX_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 WITH head AS MATERIALIZED (
  SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads WHERE org_id=p_org AND conversation_id=p_conversation),0)::text AS revision
 ), page AS MATERIALIZED (
  SELECT id,created_at FROM public.messages WHERE org_id=p_org AND conversation_id=p_conversation AND channel='sms'
   AND (p_before IS NULL OR (created_at,id)<(p_before,p_before_id)) ORDER BY created_at DESC,id DESC LIMIT 50
 ), bodies AS (
  SELECT m.id,p.created_at,m.body,m.direction,m.read_at,m.inbox_inbound_revision,m.status,m.metadata
  FROM page p JOIN public.messages m ON m.id=p.id AND m.org_id=p_org AND m.conversation_id=p_conversation AND m.channel='sms'
 ) SELECT jsonb_build_object('requester_id',requester,'org_id',p_org,'conversation_id',p_conversation,'head_revision',(SELECT revision FROM head),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,'created_at_raw',b.created_at::text,'body',b.body,'direction',b.direction,
   'read_at_raw',b.read_at::text,'inbound_revision',b.inbox_inbound_revision::text,'status',b.status,'delivery',
   CASE WHEN b.direction='inbound' THEN 'delivered'
    WHEN b.status IN ('pending','queued') THEN 'sending'
    WHEN b.status='failed' AND b.metadata->>'providerOutcome'='provider_unknown' THEN 'not_confirmed'
    WHEN b.status IN ('sent','delivered') THEN b.status
    WHEN b.status IN ('failed','bounced') THEN 'failed'
    ELSE 'failed' END)
   ORDER BY b.created_at DESC,b.id DESC) FROM bodies b),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION inbox_authenticated_detail.detail_v2(uuid,uuid,timestamptz,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inbox_authenticated_detail.detail_v2(uuid,uuid,timestamptz,uuid) TO authenticated;

DO $$ DECLARE r record;
BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','inbox_reply_send_worker') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION inbox_reply_send.project_message(uuid,uuid),inbox_reply_send.project_message_trigger(),inbox_reply_send.drain_message_projection_one() FROM %I',r.rolname);
 END LOOP;
END $$;

COMMIT;
