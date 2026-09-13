-- Isolated canonical-schema rehearsal, NOT a production migration.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN
 RAISE EXCEPTION 'Owned fixture with canonical postgres owner required'; END IF;
 IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.inbox_capture_inbound_head()'::regprocedure)<>'postgres' THEN
 RAISE EXCEPTION 'Canonical head allocator owner mismatch'; END IF;
END $$;
CREATE SCHEMA inbox_t2_projection_proof AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_projection_proof FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_projection_proof.dirty (
 org_id uuid NOT NULL, conversation_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0), acknowledged_generation bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(org_id,conversation_id), CHECK(acknowledged_generation>=0 AND acknowledged_generation<=generation)
);
CREATE TABLE inbox_t2_projection_proof.projections (
 org_id uuid NOT NULL,conversation_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 0,source_generation bigint NOT NULL DEFAULT 0,
 message_count bigint NOT NULL DEFAULT 0,unread_count bigint NOT NULL DEFAULT 0,
 latest_message_id uuid,latest_created_at timestamptz,latest_preview text,latest_inbound_revision bigint,
 PRIMARY KEY(org_id,conversation_id),CHECK(revision>=0 AND source_generation>=0)
);
ALTER TABLE inbox_t2_projection_proof.dirty ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_projection_proof.projections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_projection_proof FROM PUBLIC,anon,authenticated,service_role;
-- No canonical foreign keys: commit phase never acquires source-row locks indirectly.
CREATE FUNCTION inbox_t2_projection_proof.capture_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k record;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id,NEW.org_id,NEW.conversation_id,NEW.channel,NEW.direction,NEW.body,NEW.read_at,NEW.created_at)
 IS NOT DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.channel,OLD.direction,OLD.body,OLD.read_at,OLD.created_at) THEN
 RETURN NULL; -- Includes allocator revision-only self-update: no duplicate dirty generation.
 END IF;
 -- Mark identity keys only; never project NEW's stale revision/body in an AFTER event.
 -- Sorted old/new keys reduce cross-identity dirty-lock inversions; source locks can still deadlock.
 FOR k IN
 SELECT DISTINCT org_id,conversation_id FROM (
  SELECT CASE WHEN TG_OP<>'INSERT' THEN OLD.org_id END AS org_id,
         CASE WHEN TG_OP<>'INSERT' AND OLD.channel='sms' THEN OLD.conversation_id END AS conversation_id
  UNION ALL
  SELECT CASE WHEN TG_OP<>'DELETE' THEN NEW.org_id END,
         CASE WHEN TG_OP<>'DELETE' AND NEW.channel='sms' THEN NEW.conversation_id END
 ) keys WHERE org_id IS NOT NULL AND conversation_id IS NOT NULL ORDER BY org_id,conversation_id
 LOOP
  INSERT INTO inbox_t2_projection_proof.dirty(org_id,conversation_id,generation) VALUES(k.org_id,k.conversation_id,1)
  ON CONFLICT(org_id,conversation_id) DO UPDATE SET generation=inbox_t2_projection_proof.dirty.generation+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzz_inbox_t2_projection_dirty AFTER INSERT OR UPDATE OR DELETE ON public.messages
 FOR EACH ROW EXECUTE FUNCTION inbox_t2_projection_proof.capture_dirty();
CREATE FUNCTION inbox_t2_projection_proof.snapshot(p_org uuid,p_conversation uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH base AS MATERIALIZED (
  SELECT d.generation,coalesce(p.revision,0) AS expected_revision
  FROM inbox_t2_projection_proof.dirty d LEFT JOIN inbox_t2_projection_proof.projections p
  USING(org_id,conversation_id) WHERE d.org_id=p_org AND d.conversation_id=p_conversation
 ), counts AS MATERIALIZED (
  SELECT count(*) AS message_count,count(*) FILTER(WHERE direction='inbound' AND read_at IS NULL) AS unread_count
  FROM public.messages WHERE org_id=p_org AND conversation_id=p_conversation AND channel='sms'
 ), latest AS MATERIALIZED (
  SELECT id,created_at,left(body,120) AS preview,inbox_inbound_revision
  FROM public.messages WHERE org_id=p_org AND conversation_id=p_conversation AND channel='sms'
  ORDER BY created_at DESC,id DESC LIMIT 1
 ) SELECT jsonb_build_object('org_id',p_org,'conversation_id',p_conversation,
  'generation',b.generation::text,'expected_revision',b.expected_revision::text,
  'message_count',c.message_count::text,'unread_count',c.unread_count::text,
  'latest_message_id',l.id,'latest_created_at',l.created_at,'latest_preview',l.preview,
  'latest_inbound_revision',l.inbox_inbound_revision::text)
 FROM base b CROSS JOIN counts c LEFT JOIN latest l ON true;
$$;
CREATE FUNCTION inbox_t2_projection_proof.commit_candidate(candidate jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o uuid:=(candidate->>'org_id')::uuid; c uuid:=(candidate->>'conversation_id')::uuid;
 g bigint:=(candidate->>'generation')::bigint; r bigint:=(candidate->>'expected_revision')::bigint;
 d inbox_t2_projection_proof.dirty%ROWTYPE; p inbox_t2_projection_proof.projections%ROWTYPE;
BEGIN
 IF o IS NULL OR c IS NULL OR g IS NULL OR r IS NULL OR g<=0 OR r<0 THEN RETURN 'invalid_candidate'; END IF;
 -- Only private projection tables below this point. Do not read canonical rows or acquire their locks.
 SELECT * INTO d FROM inbox_t2_projection_proof.dirty WHERE org_id=o AND conversation_id=c FOR UPDATE;
 IF NOT FOUND OR g>d.generation OR g<d.acknowledged_generation THEN RETURN 'invalid_generation'; END IF;
 INSERT INTO inbox_t2_projection_proof.projections(org_id,conversation_id) VALUES(o,c) ON CONFLICT DO NOTHING;
 SELECT * INTO p FROM inbox_t2_projection_proof.projections WHERE org_id=o AND conversation_id=c FOR UPDATE;
 IF p.revision<>r THEN RETURN 'projection_conflict'; END IF;
 IF g<=p.source_generation THEN RETURN 'already_applied'; END IF;
 UPDATE inbox_t2_projection_proof.projections SET revision=revision+1,source_generation=g,
 message_count=(candidate->>'message_count')::bigint,unread_count=(candidate->>'unread_count')::bigint,
 latest_message_id=(candidate->>'latest_message_id')::uuid,latest_created_at=(candidate->>'latest_created_at')::timestamptz,
 latest_preview=candidate->>'latest_preview',latest_inbound_revision=(candidate->>'latest_inbound_revision')::bigint
 WHERE org_id=o AND conversation_id=c;
 UPDATE inbox_t2_projection_proof.dirty SET acknowledged_generation=g WHERE org_id=o AND conversation_id=c;
 RETURN 'applied';
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_projection_proof FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
