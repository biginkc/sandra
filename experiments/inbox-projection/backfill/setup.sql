-- Owned fixture historical backfill rehearsal, not a production migration.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE SCHEMA inbox_t2_backfill AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_backfill FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_backfill.jobs(
 org_id uuid PRIMARY KEY,stream text NOT NULL DEFAULT 'messages' CHECK(stream IN ('messages','reviews','threads','done')),
 cursor uuid,revision bigint NOT NULL DEFAULT 0,claim_token uuid,lease_until timestamptz,
 available_at timestamptz NOT NULL DEFAULT statement_timestamp(),capture_fingerprint text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT statement_timestamp(),completed_at timestamptz,
 CHECK((claim_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX backfill_available ON inbox_t2_backfill.jobs(available_at,org_id) WHERE stream<>'done';
CREATE TABLE inbox_t2_backfill.collisions(
 org_id uuid NOT NULL,conversation_id uuid NOT NULL,generation bigint NOT NULL DEFAULT 1,ack bigint NOT NULL DEFAULT 0,
 duplicate_thread_ids uuid[],checked_at timestamptz,PRIMARY KEY(org_id,conversation_id),CHECK(ack>=0 AND ack<=generation)
);
CREATE INDEX collision_pending ON inbox_t2_backfill.collisions(org_id,conversation_id) WHERE generation>ack;
CREATE INDEX inbox_t2_backfill_messages ON public.messages(org_id,id);
CREATE INDEX inbox_t2_backfill_reviews ON public.ai_disposition_reviews(org_id,id);
CREATE INDEX inbox_t2_backfill_threads ON public.message_threads(org_id,id);
CREATE INDEX inbox_t2_backfill_thread_identity ON public.message_threads(org_id,conversation_id,id);
CREATE FUNCTION inbox_t2_backfill.capture_collision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.conversation_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id),jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_t2_backfill.collisions(org_id,conversation_id) VALUES(k.o,k.c) ON CONFLICT(org_id,conversation_id) DO UPDATE SET generation=inbox_t2_backfill.collisions.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_t2_backfill_collision AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION inbox_t2_backfill.capture_collision();
CREATE FUNCTION inbox_t2_backfill.fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT md5(string_agg(t.tgrelid::regclass::text||':'||t.tgname||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid)||':'||pg_get_functiondef(t.tgfoid),'|' ORDER BY t.tgrelid,t.tgname))
 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN ('zzzzz_inbox_t2_message_direct','zzzzz_inbox_t2_parent','zzzzz_inbox_t2_parent_review','zzzzz_inbox_t2_safety_consent','zzzzz_inbox_t2_safety_thread','zzzzz_inbox_t2_safety_suppression','zzzzz_inbox_t2_backfill_collision');
$$;
CREATE FUNCTION inbox_t2_backfill.start(o uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF o IS NULL OR NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=o) THEN RAISE EXCEPTION 'Invalid organization';END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname IN ('zzzzz_inbox_t2_message_direct','zzzzz_inbox_t2_parent','zzzzz_inbox_t2_parent_review','zzzzz_inbox_t2_safety_consent','zzzzz_inbox_t2_safety_thread','zzzzz_inbox_t2_safety_suppression','zzzzz_inbox_t2_backfill_collision'))<>8 THEN RAISE EXCEPTION 'Required capture trigger set absent';END IF;
 INSERT INTO inbox_t2_backfill.jobs(org_id,capture_fingerprint) VALUES(o,inbox_t2_backfill.fingerprint());
END $$;
CREATE FUNCTION inbox_t2_backfill.claim(p_limit integer DEFAULT 10,p_seconds integer DEFAULT 30) RETURNS SETOF inbox_t2_backfill.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_seconds IS NULL OR p_seconds<1 OR p_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS(SELECT org_id FROM inbox_t2_backfill.jobs WHERE stream<>'done' AND available_at<=statement_timestamp() ORDER BY available_at,org_id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE inbox_t2_backfill.jobs j SET claim_token=gen_random_uuid(),lease_until=statement_timestamp()+make_interval(secs=>p_seconds),available_at=statement_timestamp()+make_interval(secs=>p_seconds) FROM picked p WHERE j.org_id=p.org_id RETURNING j.*;
END $$;
CREATE FUNCTION inbox_t2_backfill.batch(o uuid,token uuid,p_limit integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE before inbox_t2_backfill.jobs%ROWTYPE;locked inbox_t2_backfill.jobs%ROWTYPE;rows jsonb;targets jsonb:='[]';r jsonb;k record;n integer;last_id uuid;group_id uuid;phone text;source_sql text;next_stream text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid batch bound';END IF;
 SELECT * INTO before FROM inbox_t2_backfill.jobs WHERE org_id=o;
 IF NOT FOUND OR token IS NULL OR before.claim_token IS DISTINCT FROM token OR before.lease_until<=clock_timestamp() OR before.stream='done' THEN RETURN jsonb_build_object('result','stale_claim');END IF;
 IF before.capture_fingerprint IS DISTINCT FROM inbox_t2_backfill.fingerprint() THEN RAISE EXCEPTION 'Capture fingerprint changed';END IF;
 BEGIN
  -- Lock the entire bounded source page before any registry/dirty/edge writes.
  -- No SKIP LOCKED: a locked historical row must retry, never disappear behind a cursor.
  source_sql:=CASE before.stream WHEN 'messages' THEN 'SELECT id,org_id,conversation_id,contact_id,channel,direction,from_address,to_address FROM public.messages WHERE org_id=$1' WHEN 'reviews' THEN 'SELECT id,org_id,conversation_id FROM public.ai_disposition_reviews WHERE org_id=$1' ELSE 'SELECT id,org_id,conversation_id FROM public.message_threads WHERE org_id=$1' END;
  IF before.cursor IS NOT NULL THEN source_sql:=source_sql||' AND id>$2';END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),''[]''::jsonb) FROM ('||source_sql||' ORDER BY id LIMIT $3 FOR UPDATE) s' INTO rows USING o,before.cursor,p_limit;
  n:=jsonb_array_length(rows);last_id:=(rows->(n-1)->>'id')::uuid;
  IF before.stream='messages' THEN
   -- Raw bucket locks precede dirty/edge writes, as in the source capture trigger.
   FOR r IN SELECT value FROM jsonb_array_elements(rows) ORDER BY md5(value->>'from_address'),(value->>'from_address') COLLATE "C" LOOP
    IF r->>'channel'='sms' AND r->>'conversation_id' IS NOT NULL THEN targets:=targets||jsonb_build_array(jsonb_build_object('kind','known_conversation','id',r->>'conversation_id'));END IF;
    IF r->>'channel'='sms' AND r->>'direction'='inbound' AND r->>'contact_id' IS NULL AND r->>'from_address' IS NOT NULL AND r->>'from_address'<>'' THEN
     group_id:=inbox_t2_message_capture.sender_id(o,r->>'from_address');targets:=targets||jsonb_build_array(jsonb_build_object('kind','unknown_sender','id',group_id));
    END IF;
   END LOOP;
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('kind','known_conversation','id',value->>'conversation_id')),'[]') INTO targets FROM jsonb_array_elements(rows);
  END IF;
  FOR k IN SELECT DISTINCT value->>'kind' kind,(value->>'id')::uuid id FROM jsonb_array_elements(targets) ORDER BY 1,2 LOOP
   INSERT INTO inbox_t2_message_capture.dirty VALUES(o,k.kind,k.id,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_t2_message_capture.dirty.generation+1;
  END LOOP;
  IF before.stream='messages' THEN
   FOR r IN SELECT value FROM jsonb_array_elements(rows) ORDER BY value->>'id' LOOP
    DELETE FROM inbox_t2_message_capture.route_edges WHERE org_id=o AND message_id=(r->>'id')::uuid;
    IF r->>'channel'='sms' AND r->>'conversation_id' IS NOT NULL THEN
     phone:=regexp_replace(coalesce(CASE WHEN r->>'direction'='inbound' THEN r->>'from_address' ELSE r->>'to_address' END,''),'[^0-9]','','g');
     phone:=CASE WHEN length(phone)=10 THEN '+1'||phone WHEN length(phone)=11 AND left(phone,1)='1' THEN '+'||phone ELSE NULL END;
     IF phone IS NOT NULL THEN INSERT INTO inbox_t2_message_capture.route_edges VALUES(o,(r->>'id')::uuid,(r->>'conversation_id')::uuid,phone);END IF;
    END IF;
   END LOOP;
  ELSIF before.stream='threads' THEN
   FOR k IN SELECT DISTINCT (value->>'conversation_id')::uuid id FROM jsonb_array_elements(rows) ORDER BY 1 LOOP
    INSERT INTO inbox_t2_backfill.collisions(org_id,conversation_id) VALUES(o,k.id) ON CONFLICT(org_id,conversation_id) DO UPDATE SET generation=inbox_t2_backfill.collisions.generation+1;
   END LOOP;
  END IF;
  SELECT * INTO locked FROM inbox_t2_backfill.jobs WHERE org_id=o FOR UPDATE;
  IF NOT FOUND OR locked.claim_token IS DISTINCT FROM token OR locked.lease_until<=clock_timestamp() OR (locked.revision,locked.stream,locked.cursor) IS DISTINCT FROM (before.revision,before.stream,before.cursor) THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Stale backfill checkpoint';END IF;
  next_stream:=CASE WHEN n=p_limit THEN before.stream WHEN before.stream='messages' THEN 'reviews' WHEN before.stream='reviews' THEN 'threads' ELSE 'done' END;
  UPDATE inbox_t2_backfill.jobs SET stream=next_stream,cursor=CASE WHEN n=p_limit THEN last_id END,revision=revision+1,claim_token=NULL,lease_until=NULL,available_at=statement_timestamp(),completed_at=CASE WHEN next_stream='done' THEN statement_timestamp() END WHERE org_id=o;
 EXCEPTION WHEN SQLSTATE 'P0002' THEN RETURN jsonb_build_object('result','stale_claim');END;
 RETURN jsonb_build_object('result','advanced','source_rows',n,'stream',next_stream);
END $$;
CREATE FUNCTION inbox_t2_backfill.inspect_collisions(o uuid,p_limit integer DEFAULT 100) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE candidate record;ids uuid[];processed integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid collision bound';END IF;
 FOR candidate IN SELECT * FROM inbox_t2_backfill.collisions WHERE org_id=o AND generation>ack ORDER BY conversation_id LIMIT p_limit LOOP
  -- Read-only two-row index probe, no canonical locks while private state is locked.
  SELECT array_agg(id ORDER BY id) INTO ids FROM(SELECT id FROM public.message_threads WHERE org_id=o AND conversation_id=candidate.conversation_id ORDER BY id LIMIT 2) s;
  UPDATE inbox_t2_backfill.collisions SET ack=candidate.generation,duplicate_thread_ids=CASE WHEN cardinality(ids)=2 THEN ids END,checked_at=statement_timestamp() WHERE org_id=o AND conversation_id=candidate.conversation_id AND ack<candidate.generation;
  processed:=processed+1;
 END LOOP;
 RETURN processed;
END $$;
CREATE FUNCTION inbox_t2_backfill.readiness(o uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('historical_scan_complete',j.stream='done','capture_unchanged',j.capture_fingerprint=inbox_t2_backfill.fingerprint(),
 'collision_checks_pending',EXISTS(SELECT 1 FROM inbox_t2_backfill.collisions WHERE org_id=o AND generation>ack),
 'thread_collision_found',EXISTS(SELECT 1 FROM inbox_t2_backfill.collisions WHERE org_id=o AND cardinality(duplicate_thread_ids)=2),
 'production_cutover_authorized',false) FROM inbox_t2_backfill.jobs j WHERE j.org_id=o;
$$;
ALTER TABLE inbox_t2_backfill.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_backfill.collisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_backfill FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_backfill FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
