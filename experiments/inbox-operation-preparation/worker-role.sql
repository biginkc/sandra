-- Dedicated role candidate. Credential/login provisioning is a separate approved
-- hosting operation; this file deliberately creates no password or LOGIN role.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_action_worker') THEN
  CREATE ROLE inbox_action_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_action_worker' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='inbox_action_worker'::regrole) THEN
  RAISE EXCEPTION 'Unexpected privileged action worker role';
 END IF;
END $$;
REVOKE ALL ON SCHEMA inbox_operations,inbox_t2_policy,inbox_operation_domain FROM inbox_action_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_operations,inbox_t2_policy,inbox_operation_domain,inbox_action_api FROM inbox_action_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_operations,inbox_t2_policy,inbox_operation_domain,inbox_action_api FROM inbox_action_worker;
GRANT USAGE ON SCHEMA inbox_action_api TO inbox_action_worker;
GRANT EXECUTE ON FUNCTION inbox_action_api.load_operation(uuid,uuid),inbox_action_api.run_step(uuid,uuid,uuid),inbox_action_api.claim_dispatch_batch(integer),inbox_action_api.ack_dispatch(uuid,uuid,bigint),inbox_action_api.worker_readiness() TO inbox_action_worker;
-- Explicit REVOKE cannot subtract an inherited PUBLIC privilege. Refuse the
-- installation if canonical schema ACLs grant this principal broader authority.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND c.relkind IN ('r','p','v','m','f')
   AND has_schema_privilege('inbox_action_worker',n.oid,'USAGE')
   AND has_table_privilege('inbox_action_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
  RAISE EXCEPTION 'Action worker unexpectedly has direct data privileges';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND p.prosecdef AND p.prorettype<>'trigger'::regtype
   AND has_schema_privilege('inbox_action_worker',n.oid,'USAGE')
   AND has_function_privilege('inbox_action_worker',p.oid,'EXECUTE')
   AND p.oid<>ALL(ARRAY['inbox_action_api.load_operation(uuid,uuid)'::regprocedure,
    'inbox_action_api.run_step(uuid,uuid,uuid)'::regprocedure,
    'inbox_action_api.claim_dispatch_batch(integer)'::regprocedure,
    'inbox_action_api.ack_dispatch(uuid,uuid,bigint)'::regprocedure,
    'inbox_action_api.worker_readiness()'::regprocedure]::oid[])) THEN
  RAISE EXCEPTION 'Action worker unexpectedly reaches another privileged function';
 END IF;
END $$;
COMMIT;
