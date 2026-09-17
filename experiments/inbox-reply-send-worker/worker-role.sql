-- Dedicated role candidate for the reply-send worker. Mirrors
-- experiments/inbox-operation-preparation/worker-role.sql's inbox_action_worker
-- exactly, distinct role name and distinct (narrower) function allow-list —
-- claim/authorize/start_dispatch/persist/enumerate/ack, nothing else. No
-- password or LOGIN role is created here; credential/login provisioning is a
-- separate approved hosting operation.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker') THEN
  CREATE ROLE inbox_reply_send_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='inbox_reply_send_worker'::regrole) THEN
  RAISE EXCEPTION 'Unexpected privileged reply-send worker role';
 END IF;
END $$;
REVOKE ALL ON SCHEMA inbox_reply_send,inbox_reply_review,inbox_reply_preparation,inbox_reply_context FROM inbox_reply_send_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send,inbox_reply_review,inbox_reply_preparation,inbox_reply_context FROM inbox_reply_send_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send,inbox_reply_review,inbox_reply_preparation,inbox_reply_context FROM inbox_reply_send_worker;
GRANT USAGE ON SCHEMA inbox_reply_send TO inbox_reply_send_worker;
GRANT EXECUTE ON FUNCTION
 inbox_reply_send.claim_dispatch_batch(integer),
 inbox_reply_send.ack_dispatch(uuid,uuid,bigint),
 inbox_reply_send.operation_attempts(uuid,uuid),
 inbox_reply_send.worker_authorize(uuid,uuid),
 inbox_reply_send.worker_claim(uuid,uuid,integer),
 inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint),
 inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb)
 TO inbox_reply_send_worker;
-- operation_dispatch_complete is an internal helper for ack_dispatch/worker_claim
-- reasoning only; the worker never calls it directly, so it stays ungranted
-- (defense in depth — even the seven entry points above are already the
-- worker's whole reachable surface).
-- Explicit REVOKE cannot subtract an inherited PUBLIC privilege. Refuse the
-- installation if canonical schema ACLs grant this principal broader authority
-- than the seven functions above.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND c.relkind IN ('r','p','v','m','f')
   AND has_schema_privilege('inbox_reply_send_worker',n.oid,'USAGE')
   AND has_table_privilege('inbox_reply_send_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
  RAISE EXCEPTION 'Reply-send worker unexpectedly has direct data privileges';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND p.prosecdef AND p.prorettype<>'trigger'::regtype
   AND has_schema_privilege('inbox_reply_send_worker',n.oid,'USAGE')
   AND has_function_privilege('inbox_reply_send_worker',p.oid,'EXECUTE')
   AND p.oid<>ALL(ARRAY['inbox_reply_send.claim_dispatch_batch(integer)'::regprocedure,
    'inbox_reply_send.ack_dispatch(uuid,uuid,bigint)'::regprocedure,
    'inbox_reply_send.operation_attempts(uuid,uuid)'::regprocedure,
    'inbox_reply_send.worker_authorize(uuid,uuid)'::regprocedure,
    'inbox_reply_send.worker_claim(uuid,uuid,integer)'::regprocedure,
    'inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint)'::regprocedure,
    'inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb)'::regprocedure]::oid[])) THEN
  RAISE EXCEPTION 'Reply-send worker unexpectedly reaches another privileged function';
 END IF;
END $$;
COMMIT;
