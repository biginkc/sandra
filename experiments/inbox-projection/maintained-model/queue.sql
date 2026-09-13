-- Private fixture queue. One key per target; source writes remain transactional.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE TABLE inbox_t2_maintained.queue(
 org_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,
 available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 claim_token uuid,lease_until timestamptz,
 PRIMARY KEY(org_id,target_kind,target_id),CHECK((claim_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX queue_available ON inbox_t2_maintained.queue(available_at,org_id,target_kind,target_id);
ALTER TABLE inbox_t2_maintained.queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_t2_maintained.queue FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_t2_maintained.enqueue_dirty() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO inbox_t2_maintained.queue(org_id,target_kind,target_id) VALUES(NEW.org_id,NEW.target_kind,NEW.target_id)
 ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER maintained_queue AFTER INSERT OR UPDATE OF generation ON inbox_t2_message_capture.dirty FOR EACH ROW EXECUTE FUNCTION inbox_t2_maintained.enqueue_dirty();
-- Owned fixture bootstrap only. Production backfill needs its separate concurrent-write protocol.
INSERT INTO inbox_t2_maintained.queue(org_id,target_kind,target_id)
 SELECT d.org_id,d.target_kind,d.target_id FROM inbox_t2_message_capture.dirty d LEFT JOIN inbox_t2_maintained.rows p USING(org_id,target_kind,target_id)
 WHERE d.generation>coalesce(p.source_generation,0) ON CONFLICT DO NOTHING;
CREATE FUNCTION inbox_t2_maintained.claim_work(p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 30)
RETURNS SETOF inbox_t2_maintained.queue LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_lease_seconds IS NULL OR p_lease_seconds<1 OR p_lease_seconds>300 THEN RAISE EXCEPTION 'Invalid claim bounds';END IF;
 RETURN QUERY WITH picked AS (
 SELECT q.org_id,q.target_kind,q.target_id FROM inbox_t2_maintained.queue q
 WHERE q.available_at<=statement_timestamp() ORDER BY q.available_at,q.org_id,q.target_kind,q.target_id
 LIMIT p_limit FOR UPDATE SKIP LOCKED
 ) UPDATE inbox_t2_maintained.queue q SET claim_token=gen_random_uuid(),
 lease_until=statement_timestamp()+make_interval(secs=>p_lease_seconds),available_at=statement_timestamp()+make_interval(secs=>p_lease_seconds)
 FROM picked p WHERE (q.org_id,q.target_kind,q.target_id)=(p.org_id,p.target_kind,p.target_id) RETURNING q.*;
END $$;
CREATE FUNCTION inbox_t2_maintained.finish_work(token uuid,candidate jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o uuid:=(candidate->>'org_id')::uuid;k text:=candidate->>'target_kind';t uuid:=(candidate->>'target_id')::uuid;
 q inbox_t2_maintained.queue%ROWTYPE;g bigint;result text;ack bigint;
BEGIN
 -- Match source-trigger lock order. The queue claim transaction ended before compute.
 SELECT generation INTO g FROM inbox_t2_message_capture.dirty WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND THEN RETURN 'missing_target';END IF;
 SELECT * INTO q FROM inbox_t2_maintained.queue WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND OR token IS NULL OR q.claim_token IS DISTINCT FROM token OR q.lease_until<=clock_timestamp() THEN RETURN 'stale_claim';END IF;
 result:=inbox_t2_maintained.publish(candidate);
 SELECT source_generation INTO ack FROM inbox_t2_maintained.rows WHERE org_id=o AND target_kind=k AND target_id=t;
 IF result IN ('applied','already_applied') AND ack=g THEN
 DELETE FROM inbox_t2_maintained.queue WHERE org_id=o AND target_kind=k AND target_id=t;
 ELSE
 UPDATE inbox_t2_maintained.queue SET claim_token=NULL,lease_until=NULL,available_at=statement_timestamp()+interval '100 milliseconds' WHERE org_id=o AND target_kind=k AND target_id=t;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_maintained FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
