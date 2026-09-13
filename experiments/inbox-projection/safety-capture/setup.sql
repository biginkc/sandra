-- Owned isolated fixture only. Summary invalidation, not command-policy versions.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE SCHEMA inbox_t2_safety AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_safety FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_safety.routes(
 org_id uuid NOT NULL,phone_e164 text NOT NULL, generation bigint NOT NULL CHECK(generation>0),
 ack bigint NOT NULL DEFAULT 0 CHECK(ack>=0 AND ack<=generation),scan_generation bigint,cursor uuid,
 claim_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(org_id,phone_e164),CHECK((claim_token IS NULL)=(lease_until IS NULL)),
 CHECK(scan_generation IS NULL OR (scan_generation>ack AND scan_generation<=generation))
);
CREATE INDEX route_pending ON inbox_t2_safety.routes(available_at,org_id,phone_e164) WHERE generation>ack;
CREATE FUNCTION inbox_t2_safety.consent_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.contact_id,OLD.channel,OLD.event_type,OLD.occurred_at) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.contact_id,NEW.channel,NEW.event_type,NEW.occurred_at) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.contact_id,'channel',NEW.channel,'event',NEW.event_type)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.contact_id,'channel',OLD.channel,'event',OLD.event_type)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.contact_id,'channel',OLD.channel,'event',OLD.event_type),jsonb_build_object('o',NEW.org_id,'c',NEW.contact_id,'channel',NEW.channel,'event',NEW.event_type)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) WHERE value->>'channel'='sms' AND value->>'event' IN ('opt_in_marketing_written','opt_in_informational','opt_in_confirmed','opt_out','provider_auto_opt_out') ORDER BY 1,2 LOOP
  INSERT INTO inbox_t2_parent.work(org_id,kind,entity_id,generation) VALUES(k.o,'contact',k.c,1) ON CONFLICT(org_id,kind,entity_id) DO UPDATE SET generation=inbox_t2_parent.work.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_t2_safety_consent AFTER INSERT OR UPDATE OR DELETE ON public.consent_events FOR EACH ROW EXECUTE FUNCTION inbox_t2_safety.consent_capture();
CREATE FUNCTION inbox_t2_safety.thread_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.org_id,OLD.conversation_id,OLD.ai_responder_status) IS NOT DISTINCT FROM (NEW.org_id,NEW.conversation_id,NEW.ai_responder_status) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id),jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_t2_message_capture.dirty VALUES(k.o,'known_conversation',k.c,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_t2_message_capture.dirty.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_t2_safety_thread AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION inbox_t2_safety.thread_capture();
CREATE FUNCTION inbox_t2_safety.suppression_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.org_id,OLD.channel,OLD.phone_e164) IS NOT DISTINCT FROM (NEW.org_id,NEW.channel,NEW.phone_e164) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'p',NEW.phone_e164,'channel',NEW.channel)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'p',OLD.phone_e164,'channel',OLD.channel)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'p',OLD.phone_e164,'channel',OLD.channel),jsonb_build_object('o',NEW.org_id,'p',NEW.phone_e164,'channel',NEW.channel)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,value->>'p' p FROM jsonb_array_elements(sides) WHERE value->>'channel'='sms' ORDER BY 1,2 LOOP
  INSERT INTO inbox_t2_safety.routes(org_id,phone_e164,generation) VALUES(k.o,k.p,1) ON CONFLICT(org_id,phone_e164) DO UPDATE SET generation=inbox_t2_safety.routes.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_t2_safety_suppression AFTER INSERT OR UPDATE OR DELETE ON public.sms_phone_suppressions FOR EACH ROW EXECUTE FUNCTION inbox_t2_safety.suppression_capture();
CREATE FUNCTION inbox_t2_safety.claim(p_limit integer DEFAULT 10,p_seconds integer DEFAULT 30) RETURNS SETOF inbox_t2_safety.routes LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_seconds IS NULL OR p_seconds<1 OR p_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS(SELECT org_id,phone_e164 FROM inbox_t2_safety.routes WHERE generation>ack AND available_at<=statement_timestamp() ORDER BY available_at,org_id,phone_e164 LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE inbox_t2_safety.routes w SET claim_token=gen_random_uuid(),lease_until=statement_timestamp()+make_interval(secs=>p_seconds),available_at=statement_timestamp()+make_interval(secs=>p_seconds),scan_generation=coalesce(w.scan_generation,w.generation) FROM picked p WHERE (w.org_id,w.phone_e164)=(p.org_id,p.phone_e164) RETURNING w.*;
END $$;
CREATE FUNCTION inbox_t2_safety.batch(o uuid,p text,token uuid,p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before inbox_t2_safety.routes%ROWTYPE;locked inbox_t2_safety.routes%ROWTYPE;links jsonb;child record;n integer;last_id uuid;result text;source_sql text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid batch bounds';END IF;
 SELECT * INTO before FROM inbox_t2_safety.routes WHERE org_id=o AND phone_e164=p;
 IF NOT FOUND OR token IS NULL OR before.claim_token IS DISTINCT FROM token OR before.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('result','stale_claim');END IF;
 source_sql:='SELECT message_id,conversation_id FROM inbox_t2_message_capture.route_edges WHERE org_id=$1 AND phone_e164=$2';
 IF before.cursor IS NOT NULL THEN source_sql:=source_sql||' AND message_id>$3';END IF;
 EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.message_id),''[]''::jsonb) FROM ('||source_sql||' ORDER BY message_id LIMIT $4) s' INTO links USING o,p,before.cursor,p_limit;
 n:=jsonb_array_length(links);last_id:=(links->(n-1)->>'message_id')::uuid;
 BEGIN
  FOR child IN SELECT DISTINCT (value->>'conversation_id')::uuid c FROM jsonb_array_elements(links) ORDER BY 1 LOOP
   INSERT INTO inbox_t2_message_capture.dirty VALUES(o,'known_conversation',child.c,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_t2_message_capture.dirty.generation+1;
  END LOOP;
  SELECT * INTO locked FROM inbox_t2_safety.routes WHERE org_id=o AND phone_e164=p FOR UPDATE;
  IF NOT FOUND OR locked.claim_token IS DISTINCT FROM token OR locked.lease_until<=clock_timestamp() OR (locked.scan_generation,locked.cursor) IS DISTINCT FROM (before.scan_generation,before.cursor) THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale route checkpoint';END IF;
  IF n=p_limit THEN UPDATE inbox_t2_safety.routes SET cursor=last_id WHERE org_id=o AND phone_e164=p;result:='advanced';
  ELSE UPDATE inbox_t2_safety.routes SET ack=before.scan_generation,scan_generation=NULL,cursor=NULL WHERE org_id=o AND phone_e164=p;result:='completed';END IF;
  UPDATE inbox_t2_safety.routes SET claim_token=NULL,lease_until=NULL,available_at=statement_timestamp() WHERE org_id=o AND phone_e164=p;
 EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN jsonb_build_object('result','stale_claim');END;
 RETURN jsonb_build_object('result',result,'source_rows',n,'scan_generation',before.scan_generation::text);
END $$;
ALTER TABLE inbox_t2_safety.routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_safety FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_safety FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
