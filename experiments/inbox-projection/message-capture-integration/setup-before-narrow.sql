-- Private offline rehearsal only. Coexists with, does not replace, earlier lab capture.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(
 SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN
 RAISE EXCEPTION 'Owned fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_message_capture AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_message_capture FROM PUBLIC,anon,authenticated,service_role;
-- Hash selects a bounded lock bucket; raw equality, never hash equality, determines identity.
-- This avoids an unbounded raw text btree key and does not merge hash collisions.
CREATE TABLE inbox_t2_message_capture.sender_buckets(org_id uuid NOT NULL,raw_hash text NOT NULL,PRIMARY KEY(org_id,raw_hash));
CREATE TABLE inbox_t2_message_capture.sender_groups(
 sender_group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,
 raw_hash text NOT NULL,raw_sender text NOT NULL CHECK(raw_sender<>''));
CREATE INDEX sender_group_lookup ON inbox_t2_message_capture.sender_groups(org_id,raw_hash);
CREATE TABLE inbox_t2_message_capture.dirty(
 org_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('known_conversation','unknown_sender')),
 target_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),
 PRIMARY KEY(org_id,target_kind,target_id));
CREATE TABLE inbox_t2_message_capture.versions(
 org_id uuid NOT NULL,namespace text NOT NULL CHECK(namespace IN ('message_content','known_reply','unknown_action')),
 target_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),PRIMARY KEY(org_id,namespace,target_id));
CREATE TABLE inbox_t2_message_capture.route_edges(
 org_id uuid NOT NULL,message_id uuid NOT NULL,conversation_id uuid NOT NULL,phone_e164 text NOT NULL,
 PRIMARY KEY(org_id,message_id));
CREATE INDEX route_edge_fanout ON inbox_t2_message_capture.route_edges(org_id,phone_e164,message_id);
-- All rows/counters survive source deletion except current relationship edges; no canonical FKs.
CREATE FUNCTION inbox_t2_message_capture.sender_id(p_org uuid,p_raw text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE found_id uuid; h text:=md5(p_raw);
BEGIN
 IF p_org IS NULL OR p_raw IS NULL OR p_raw='' THEN RAISE EXCEPTION 'Invalid raw sender'; END IF;
 SELECT sender_group_id INTO found_id FROM inbox_t2_message_capture.sender_groups
 WHERE org_id=p_org AND raw_hash=h AND raw_sender COLLATE "C"=p_raw COLLATE "C";
 IF found_id IS NOT NULL THEN RETURN found_id; END IF;
 -- Write barrier, not just a row lock: stale REPEATABLE READ snapshots must
 -- abort with40001 rather than insert another group after waiting.
 INSERT INTO inbox_t2_message_capture.sender_buckets VALUES(p_org,h)
 ON CONFLICT(org_id,raw_hash) DO UPDATE SET raw_hash=excluded.raw_hash;
 SELECT sender_group_id INTO found_id FROM inbox_t2_message_capture.sender_groups
 WHERE org_id=p_org AND raw_hash=h AND raw_sender COLLATE "C"=p_raw COLLATE "C";
 IF found_id IS NULL THEN
  INSERT INTO inbox_t2_message_capture.sender_groups(org_id,raw_hash,raw_sender) VALUES(p_org,h,p_raw)
  RETURNING sender_group_id INTO found_id;
 END IF;
 RETURN found_id;
END $$;
CREATE FUNCTION inbox_t2_message_capture.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE known_changed boolean:=true; unknown_changed boolean:=true; content_changed boolean:=true;
 status_eligibility_changed boolean:=false; dismissed_changed boolean:=true; edge_changed boolean:=true;
 sides jsonb; side jsonb; targets jsonb:='[]'; versions jsonb:='[]'; k record;
 o uuid; c uuid; mid uuid; group_id uuid; phone text;
BEGIN
 IF TG_OP='UPDATE' THEN
  known_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,NEW.direction,NEW.status,NEW.created_at,NEW.body,NEW.from_address,NEW.to_address,NEW.read_at)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,OLD.direction,OLD.status,OLD.created_at,OLD.body,OLD.from_address,OLD.to_address,OLD.read_at);
  unknown_changed:=(NEW.id,NEW.org_id,NEW.channel,NEW.direction,NEW.contact_id,NEW.from_address,NEW.to_address,NEW.body,NEW.created_at,NEW.dismissed_at)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.channel,OLD.direction,OLD.contact_id,OLD.from_address,OLD.to_address,OLD.body,OLD.created_at,OLD.dismissed_at);
  content_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,NEW.direction,NEW.body,NEW.from_address,NEW.to_address,NEW.metadata)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,OLD.direction,OLD.body,OLD.from_address,OLD.to_address,OLD.metadata);
  -- Conservative private candidate assumption: queue/paused entry/exit changes known eligibility.
  status_eligibility_changed:=(NEW.status IN ('queued','paused')) IS DISTINCT FROM (OLD.status IN ('queued','paused'));
  dismissed_changed:=NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at;
  edge_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.channel,NEW.direction,NEW.from_address,NEW.to_address)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.channel,OLD.direction,OLD.from_address,OLD.to_address);
  IF NOT(known_changed OR unknown_changed OR content_changed OR status_eligibility_changed OR dismissed_changed OR edge_changed) THEN RETURN NULL; END IF;
 END IF;
 sides:=CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW)) WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END;
 -- Acquire new raw identity buckets in stable org/hash/raw order before dirty/version locks.
 FOR side IN SELECT value FROM jsonb_array_elements(sides)
  ORDER BY value->>'org_id',md5(value->>'from_address'),(value->>'from_address') COLLATE "C"
 LOOP
  o:=(side->>'org_id')::uuid; c:=(side->>'conversation_id')::uuid; mid:=(side->>'id')::uuid;
  IF content_changed OR status_eligibility_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','message_content','id',mid)); END IF;
  IF side->>'channel'='sms' AND c IS NOT NULL THEN
   IF known_changed THEN targets:=targets||jsonb_build_array(jsonb_build_object('org',o,'kind','known_conversation','id',c)); END IF;
   IF content_changed OR status_eligibility_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','known_reply','id',c)); END IF;
  END IF;
  IF side->>'channel'='sms' AND side->>'direction'='inbound' AND side->>'contact_id' IS NULL
   AND side->>'from_address' IS NOT NULL AND side->>'from_address'<>'' THEN
   group_id:=inbox_t2_message_capture.sender_id(o,side->>'from_address');
   IF unknown_changed THEN targets:=targets||jsonb_build_array(jsonb_build_object('org',o,'kind','unknown_sender','id',group_id)); END IF;
   IF content_changed OR dismissed_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','unknown_action','id',group_id)); END IF;
  END IF;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid AS org,value->>'kind' AS kind,(value->>'id')::uuid AS id FROM jsonb_array_elements(targets) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_t2_message_capture.dirty VALUES(k.org,k.kind,k.id,1)
  ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_t2_message_capture.dirty.generation+1;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid AS org,value->>'namespace' AS namespace,(value->>'id')::uuid AS id FROM jsonb_array_elements(versions) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_t2_message_capture.versions VALUES(k.org,k.namespace,k.id,1)
  ON CONFLICT(org_id,namespace,target_id) DO UPDATE SET revision=inbox_t2_message_capture.versions.revision+1;
 END LOOP;
 IF edge_changed THEN
  -- At most old/new source edges, never a fanout scan.
  IF TG_OP<>'INSERT' THEN DELETE FROM inbox_t2_message_capture.route_edges WHERE org_id=OLD.org_id AND message_id=OLD.id; END IF;
  IF TG_OP<>'DELETE' AND NEW.channel='sms' AND NEW.conversation_id IS NOT NULL THEN
   phone:=regexp_replace(coalesce(CASE WHEN NEW.direction='inbound' THEN NEW.from_address ELSE NEW.to_address END,''),'[^0-9]','','g');
   phone:=CASE WHEN length(phone)=10 THEN '+1'||phone WHEN length(phone)=11 AND left(phone,1)='1' THEN '+'||phone ELSE NULL END;
   IF phone IS NOT NULL THEN INSERT INTO inbox_t2_message_capture.route_edges VALUES(NEW.org_id,NEW.id,NEW.conversation_id,phone)
    ON CONFLICT(org_id,message_id) DO UPDATE SET conversation_id=excluded.conversation_id,phone_e164=excluded.phone_e164; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzz_inbox_t2_message_direct AFTER INSERT OR UPDATE OR DELETE ON public.messages
 FOR EACH ROW EXECUTE FUNCTION inbox_t2_message_capture.capture();
ALTER TABLE inbox_t2_message_capture.sender_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_message_capture.sender_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_message_capture.dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_message_capture.versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_message_capture.route_edges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_message_capture FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_message_capture FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
