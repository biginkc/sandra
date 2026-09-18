-- GENERATED PROJECTION WORKER ROLE PACKET. No production execution authorization.
-- Apply only after the release database marker and role review are confirmed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'sandra_inbox_release_20260917' OR NOT EXISTS(
  SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-release-owned-synthetic'
 ) THEN RAISE EXCEPTION 'Owned release fixture required'; END IF;
END $$;
-- Reviewed role candidate; no production execution or LOGIN credential provisioning.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_projection_worker') THEN
  CREATE ROLE inbox_projection_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_projection_worker' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='inbox_projection_worker'::regrole) THEN
  RAISE EXCEPTION 'Unexpected privileged projection worker role';
 END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_control,inbox_backfill,inbox_parent,inbox_maintained FROM inbox_projection_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_control,inbox_backfill,inbox_parent,inbox_maintained FROM inbox_projection_worker;
GRANT USAGE ON SCHEMA inbox_control,inbox_backfill,inbox_parent,inbox_maintained TO inbox_projection_worker;
GRANT EXECUTE ON FUNCTION inbox_control.seed_baseline_batch(integer),inbox_control.wake_due_expiries(integer),inbox_control.readiness(),
 inbox_backfill.claim(integer,integer),inbox_backfill.batch(uuid,uuid,integer),
 inbox_parent.claim(integer,integer),inbox_parent.batch(uuid,text,uuid,uuid,integer),
 inbox_maintained.claim_work(integer,integer),inbox_maintained.snapshot(uuid,text,uuid,timestamptz),inbox_maintained.finish_work(uuid,jsonb)
 TO inbox_projection_worker;
DO $$ BEGIN
 IF NOT (NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') AND has_schema_privilege('inbox_projection_worker',n.oid,'USAGE') AND has_table_privilege('inbox_projection_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) OR NOT (NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef AND p.prorettype<>'trigger'::regtype AND has_schema_privilege('inbox_projection_worker',n.oid,'USAGE') AND has_function_privilege('inbox_projection_worker',p.oid,'EXECUTE') AND p.oid<>ALL(ARRAY['inbox_control.seed_baseline_batch(integer)'::regprocedure,'inbox_control.wake_due_expiries(integer)'::regprocedure,'inbox_control.readiness()'::regprocedure,'inbox_backfill.claim(integer,integer)'::regprocedure,'inbox_backfill.batch(uuid,uuid,integer)'::regprocedure,'inbox_parent.claim(integer,integer)'::regprocedure,'inbox_parent.batch(uuid,text,uuid,uuid,integer)'::regprocedure,'inbox_maintained.claim_work(integer,integer)'::regprocedure,'inbox_maintained.snapshot(uuid,text,uuid,timestamptz)'::regprocedure,'inbox_maintained.finish_work(uuid,jsonb)'::regprocedure]::oid[]))) THEN RAISE EXCEPTION 'Projection worker unexpectedly reaches direct data or another privileged function';END IF;
END $$;
COMMIT;
