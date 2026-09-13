-- Owned canonical fixture integration. Not a production migration.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(
 SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic')
 THEN RAISE EXCEPTION 'Owned canonical fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_maintained AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_maintained FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_maintained.rows(
 org_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('known_conversation','unknown_sender')),
 target_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 source_generation bigint NOT NULL DEFAULT 0 CHECK(source_generation>=0),
 summary jsonb, next_expiry timestamptz,
 PRIMARY KEY(org_id,target_kind,target_id)
);
CREATE INDEX due_expiries ON inbox_t2_maintained.rows(next_expiry,org_id,target_kind,target_id) WHERE next_expiry IS NOT NULL;
ALTER TABLE inbox_t2_maintained.rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_maintained FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_t2_maintained.snapshot(o uuid,k text,t uuid,at_time timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH b AS MATERIALIZED (
 SELECT d.*,coalesce(p.revision,0) AS r FROM inbox_t2_message_capture.dirty d
 LEFT JOIN inbox_t2_maintained.rows p USING(org_id,target_kind,target_id)
 WHERE d.org_id=o AND d.target_kind=k AND d.target_id=t AND at_time IS NOT NULL
 ), computed AS MATERIALIZED (
 SELECT b.*,CASE k WHEN 'known_conversation' THEN inbox_t2_summary_contract.compute(o,t,at_time)
 WHEN 'unknown_sender' THEN (SELECT inbox_t2_unknown_summary.compute(o,g.raw_sender,at_time)
 ||jsonb_build_object('sender_group_id',g.sender_group_id,'identity_mapping_required',false)
 FROM inbox_t2_message_capture.sender_groups g WHERE g.org_id=o AND g.sender_group_id=t) END AS data FROM b
 ) SELECT jsonb_build_object('org_id',o,'target_kind',k,'target_id',t,'generation',generation::text,
 'expected_revision',r::text,'summary',data) FROM computed WHERE data IS NOT NULL;
$$;
CREATE FUNCTION inbox_t2_maintained.publish(candidate jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o uuid:=(candidate->>'org_id')::uuid;k text:=candidate->>'target_kind';t uuid:=(candidate->>'target_id')::uuid;
 g bigint:=(candidate->>'generation')::bigint;r bigint:=(candidate->>'expected_revision')::bigint;
 s jsonb:=candidate->'summary';current_g bigint;p inbox_t2_maintained.rows%ROWTYPE;expiry timestamptz;
BEGIN
 IF o IS NULL OR t IS NULL OR k IS NULL OR k NOT IN ('known_conversation','unknown_sender')
 OR g IS NULL OR g<=0 OR r IS NULL OR r<0 OR jsonb_typeof(s) IS DISTINCT FROM 'object'
 OR (s->>'org_id') IS DISTINCT FROM o::text OR jsonb_typeof(s->'exists') IS DISTINCT FROM 'boolean'
 OR (k='known_conversation' AND ((s->>'target_kind') IS DISTINCT FROM k OR (s->>'conversation_id') IS DISTINCT FROM t::text))
 OR (k='unknown_sender' AND ((s->>'target_kind') IS DISTINCT FROM 'unknown_sender_group' OR (s->>'sender_group_id') IS DISTINCT FROM t::text))
 THEN RETURN 'invalid_candidate'; END IF;
 expiry:=CASE WHEN k='known_conversation' THEN (s->>'next_window_expiry')::timestamptz END;
 -- Source tables are never read/locked after this point. No canonical FKs.
 SELECT generation INTO current_g FROM inbox_t2_message_capture.dirty WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND OR g>current_g THEN RETURN 'invalid_generation'; END IF;
 INSERT INTO inbox_t2_maintained.rows(org_id,target_kind,target_id) VALUES(o,k,t) ON CONFLICT DO NOTHING;
 SELECT * INTO p FROM inbox_t2_maintained.rows WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF g<p.source_generation THEN RETURN 'invalid_generation'; END IF;
 IF p.revision<>r THEN RETURN 'projection_conflict'; END IF;
 IF g=p.source_generation THEN RETURN 'already_applied'; END IF;
 UPDATE inbox_t2_maintained.rows SET revision=revision+1,source_generation=g,summary=s,next_expiry=expiry
 WHERE org_id=o AND target_kind=k AND target_id=t;
 RETURN 'applied';
END $$;
-- The persisted source_generation is the acknowledgment for this maintained model.
-- An older-G publication leaves d.generation > p.source_generation for pending repair.
CREATE FUNCTION inbox_t2_maintained.wake_expiry(o uuid,k text,t uuid,expected_r bigint,at_time timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p inbox_t2_maintained.rows%ROWTYPE;
BEGIN
 IF at_time IS NULL OR expected_r IS NULL THEN RETURN false; END IF;
 PERFORM 1 FROM inbox_t2_message_capture.dirty WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO p FROM inbox_t2_maintained.rows WHERE org_id=o AND target_kind=k AND target_id=t FOR UPDATE;
 IF NOT FOUND OR p.revision<>expected_r OR p.next_expiry IS NULL OR p.next_expiry>=at_time THEN RETURN false; END IF;
 UPDATE inbox_t2_message_capture.dirty SET generation=generation+1 WHERE org_id=o AND target_kind=k AND target_id=t;
 UPDATE inbox_t2_maintained.rows SET next_expiry=NULL WHERE org_id=o AND target_kind=k AND target_id=t;
 RETURN true;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_maintained FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
