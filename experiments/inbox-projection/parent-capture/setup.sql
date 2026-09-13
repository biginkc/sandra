-- Offline owned fixture only; no production migration or backfill claim.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE SCHEMA inbox_t2_parent AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_parent FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_parent.work(
 org_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('property','contact')),entity_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),ack bigint NOT NULL DEFAULT 0 CHECK(ack>=0 AND ack<=generation),
 scan_generation bigint,stream text CHECK(stream IN ('messages','reviews')),cursor uuid,
 claim_token uuid,lease_until timestamptz,available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(org_id,kind,entity_id),CHECK((claim_token IS NULL)=(lease_until IS NULL)),
 CHECK((scan_generation IS NULL)=(stream IS NULL)),CHECK(scan_generation IS NULL OR (scan_generation>ack AND scan_generation<=generation))
);
CREATE INDEX parent_pending ON inbox_t2_parent.work(available_at,org_id,kind,entity_id) WHERE generation>ack;
-- Fixture-only index candidates; production requires migration/capacity review.
CREATE INDEX inbox_t2_parent_message_property ON public.messages(org_id,property_id,id);
CREATE INDEX inbox_t2_parent_message_contact ON public.messages(org_id,contact_id,id);
CREATE INDEX inbox_t2_parent_review_property ON public.ai_disposition_reviews(org_id,property_id,id);
CREATE FUNCTION inbox_t2_parent.capture_parent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed boolean:=true;sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='properties' THEN
   changed:=(OLD.id,OLD.org_id,OLD.address,OLD.city,OLD.state,OLD.status,OLD.outreach_dispo,OLD.is_dnc_locked,OLD.assigned_user_id,OLD.needs_human_attention)
    IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.address,NEW.city,NEW.state,NEW.status,NEW.outreach_dispo,NEW.is_dnc_locked,NEW.assigned_user_id,NEW.needs_human_attention);
  ELSE
   changed:=(OLD.id,OLD.org_id,OLD.entity_name,OLD.first_name,OLD.last_name,OLD.do_not_contact,OLD.sms_opted_out)
    IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.entity_name,NEW.first_name,NEW.last_name,NEW.do_not_contact,NEW.sms_opted_out);
  END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('org',NEW.org_id,'id',NEW.id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.id)) ELSE jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.id),jsonb_build_object('org',NEW.org_id,'id',NEW.id)) END;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid o,(value->>'id')::uuid id FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_t2_parent.work(org_id,kind,entity_id,generation) VALUES(k.o,TG_ARGV[0],k.id,1)
  ON CONFLICT(org_id,kind,entity_id) DO UPDATE SET generation=inbox_t2_parent.work.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_t2_parent AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION inbox_t2_parent.capture_parent('property');
CREATE TRIGGER zzzzz_inbox_t2_parent AFTER INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION inbox_t2_parent.capture_parent('contact');
CREATE FUNCTION inbox_t2_parent.capture_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.conversation_id,OLD.property_id,OLD.status,OLD.disposition,OLD.source_inbound_message_id,OLD.created_at)
 IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.property_id,NEW.status,NEW.disposition,NEW.source_inbound_message_id,NEW.created_at) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('org',NEW.org_id,'id',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.conversation_id),jsonb_build_object('org',NEW.org_id,'id',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid o,(value->>'id')::uuid id FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_t2_message_capture.dirty VALUES(k.o,'known_conversation',k.id,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_t2_message_capture.dirty.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_t2_parent_review AFTER INSERT OR UPDATE OR DELETE ON public.ai_disposition_reviews FOR EACH ROW EXECUTE FUNCTION inbox_t2_parent.capture_review();
CREATE FUNCTION inbox_t2_parent.claim(p_limit integer DEFAULT 10,p_seconds integer DEFAULT 30) RETURNS SETOF inbox_t2_parent.work LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_seconds IS NULL OR p_seconds<1 OR p_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS(SELECT org_id,kind,entity_id FROM inbox_t2_parent.work WHERE generation>ack AND available_at<=statement_timestamp() ORDER BY available_at,org_id,kind,entity_id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE inbox_t2_parent.work w SET claim_token=gen_random_uuid(),lease_until=statement_timestamp()+make_interval(secs=>p_seconds),available_at=statement_timestamp()+make_interval(secs=>p_seconds),scan_generation=coalesce(w.scan_generation,w.generation),stream=coalesce(w.stream,'messages') FROM picked p WHERE (w.org_id,w.kind,w.entity_id)=(p.org_id,p.kind,p.entity_id) RETURNING w.*;
END $$;
CREATE FUNCTION inbox_t2_parent.batch(o uuid,k text,e uuid,token uuid,p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before inbox_t2_parent.work%ROWTYPE;locked inbox_t2_parent.work%ROWTYPE;links jsonb;child record;n integer;last_id uuid;result text;source_sql text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid batch bound';END IF;
 -- MVCC source reads occur before any private write locks. No canonical row locks.
 SELECT * INTO before FROM inbox_t2_parent.work WHERE org_id=o AND kind=k AND entity_id=e;
 IF NOT FOUND OR token IS NULL OR before.claim_token IS DISTINCT FROM token OR before.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('result','stale_claim');END IF;
 IF before.stream='reviews' THEN
  source_sql:='SELECT id,conversation_id FROM public.ai_disposition_reviews WHERE org_id=$1 AND property_id=$2';
 ELSIF k='property' THEN
  source_sql:='SELECT id,CASE WHEN channel=''sms'' THEN conversation_id END AS conversation_id FROM public.messages WHERE org_id=$1 AND property_id=$2';
 ELSE
  source_sql:='SELECT id,CASE WHEN channel=''sms'' THEN conversation_id END AS conversation_id FROM public.messages WHERE org_id=$1 AND contact_id=$2';
 END IF;
 -- Separate first/cursor shapes; avoid a generic OR plan scanning a deep prefix.
 IF before.cursor IS NOT NULL THEN source_sql:=source_sql||' AND id>$3';END IF;
 EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),''[]''::jsonb) FROM ('||source_sql||' ORDER BY id LIMIT $4) s' INTO links USING o,e,before.cursor,p_limit;
 n:=jsonb_array_length(links);last_id:=(links->(n-1)->>'id')::uuid;
 BEGIN
  -- Child before parent, matching nested legacy property->review dirty->parent capture.
  -- A failed fence rolls back all child enqueues in this subtransaction.
  FOR child IN SELECT DISTINCT (value->>'conversation_id')::uuid id FROM jsonb_array_elements(links) WHERE value->>'conversation_id' IS NOT NULL ORDER BY 1 LOOP
   INSERT INTO inbox_t2_message_capture.dirty VALUES(o,'known_conversation',child.id,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_t2_message_capture.dirty.generation+1;
  END LOOP;
  SELECT * INTO locked FROM inbox_t2_parent.work WHERE org_id=o AND kind=k AND entity_id=e FOR UPDATE;
  IF NOT FOUND OR locked.claim_token IS DISTINCT FROM token OR locked.lease_until<=clock_timestamp() OR (locked.scan_generation,locked.stream,locked.cursor) IS DISTINCT FROM (before.scan_generation,before.stream,before.cursor) THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale parent checkpoint';END IF;
  IF n=p_limit THEN
   UPDATE inbox_t2_parent.work SET cursor=last_id WHERE org_id=o AND kind=k AND entity_id=e;result:='advanced';
  ELSIF k='property' AND before.stream='messages' THEN
   UPDATE inbox_t2_parent.work SET stream='reviews',cursor=NULL WHERE org_id=o AND kind=k AND entity_id=e;result:='next_stream';
  ELSE
   UPDATE inbox_t2_parent.work SET ack=before.scan_generation,scan_generation=NULL,stream=NULL,cursor=NULL WHERE org_id=o AND kind=k AND entity_id=e;result:='completed';
  END IF;
  UPDATE inbox_t2_parent.work SET claim_token=NULL,lease_until=NULL,available_at=statement_timestamp() WHERE org_id=o AND kind=k AND entity_id=e;
 EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN jsonb_build_object('result','stale_claim');
 END;
 RETURN jsonb_build_object('result',result,'source_rows',n,'scan_generation',before.scan_generation::text);
END $$;
ALTER TABLE inbox_t2_parent.work ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_parent FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_parent FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
