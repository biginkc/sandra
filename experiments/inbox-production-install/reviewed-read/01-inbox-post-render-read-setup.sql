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
 next_batch integer NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false
);
CREATE TABLE inbox_t2_read.receipts (
 boundary_id uuid NOT NULL REFERENCES inbox_t2_read.boundaries(id), batch integer NOT NULL,
 changed integer NOT NULL CHECK(changed BETWEEN 0 AND 200), completed boolean NOT NULL,
 PRIMARY KEY(boundary_id,batch)
);
ALTER TABLE inbox_t2_read.boundaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_t2_read.receipts ENABLE ROW LEVEL SECURITY;

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
  SELECT inbox_t2_authenticated_detail.detail_v2(o,c) AS data,
   g.generation FROM inbox_t2_capture_boundary.generation g WHERE singleton IS TRUE
 ), recorded AS (
  INSERT INTO inbox_t2_read.boundaries(requester_id,org_id,conversation_id,generation,revision,created_at,expires_at)
  SELECT (a->>'user_id')::uuid,o,c,s.generation,(s.data->>'head_revision')::bigint,
   statement_timestamp(),least(statement_timestamp()+interval '5 minutes',(a->>'expires_at')::timestamptz)
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
 IF NOT FOUND OR w.requester_id<>(a->>'user_id')::uuid OR w.org_id<>(a->>'org_id')::uuid THEN
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
 PERFORM inbox_t2_bridge.authorize(w.org_id);
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
