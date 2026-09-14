-- Worker-private offline fixture integration, not a production migration.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR
 NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN
 RAISE EXCEPTION 'Owned canonical fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_summary_worker AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_summary_worker FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_summary_worker.summaries (
 org_id uuid NOT NULL, conversation_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), source_generation bigint NOT NULL CHECK(source_generation>0),
 summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object'),
 PRIMARY KEY(org_id,conversation_id)
);
ALTER TABLE inbox_t2_summary_worker.summaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_t2_summary_worker.summaries FROM PUBLIC,anon,authenticated,service_role;
-- No FK: publication must not acquire canonical source locks.
CREATE FUNCTION inbox_t2_summary_worker.snapshot(p_org uuid,p_conversation uuid,p_as_of timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH captured AS MATERIALIZED (
  SELECT inbox_t2_projection_proof.snapshot(p_org,p_conversation) AS value
 ) SELECT value || jsonb_build_object('summary',inbox_t2_summary_contract.compute(p_org,p_conversation,p_as_of))
 FROM captured WHERE value IS NOT NULL;
$$;
CREATE FUNCTION inbox_t2_summary_worker.commit_candidate(candidate jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result text; s jsonb:=candidate->'summary';
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object'
 OR (s->>'target_kind') IS DISTINCT FROM 'known_conversation'
 OR (s->>'org_id') IS DISTINCT FROM (candidate->>'org_id')
 OR (s->>'conversation_id') IS DISTINCT FROM (candidate->>'conversation_id')
 OR jsonb_typeof(s->'exists') IS DISTINCT FROM 'boolean' THEN RETURN 'invalid_summary'; END IF;
 -- Installed CAS holds dirty then projection locks. Neither it nor this commit
 -- reads canonical messages/contacts/properties. Full JSON is persisted in the
 -- same transaction, so an error here also rolls back CAS/acknowledgment.
 result:=inbox_t2_projection_proof.commit_candidate(candidate);
 IF result<>'applied' THEN RETURN result; END IF;
 INSERT INTO inbox_t2_summary_worker.summaries(org_id,conversation_id,revision,source_generation,summary)
 VALUES((candidate->>'org_id')::uuid,(candidate->>'conversation_id')::uuid,
  (candidate->>'expected_revision')::bigint+1,(candidate->>'generation')::bigint,s)
 ON CONFLICT(org_id,conversation_id) DO UPDATE SET revision=excluded.revision,
 source_generation=excluded.source_generation,summary=excluded.summary;
 RETURN result;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_summary_worker FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
