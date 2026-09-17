-- Lane 1 PR-F: durable reply-send worker SQL surface. Additive only — does NOT
-- touch attempts.sql or accept.sql (PR-D/PR-E are frozen). Every function here
-- is SECURITY DEFINER and is the ONLY thing granted to the dedicated
-- inbox_reply_send_worker role (worker-role.sql): claim, authorize,
-- start_dispatch, persist, enumerate (operation_attempts), ack. The role never
-- gets a direct table grant or EXECUTE on attempts.sql's plain (non-DEFINER)
-- claim()/start_dispatch()/persist() themselves — those stay reachable only
-- from inside a SECURITY DEFINER wrapper here, exactly like
-- inbox_action_api.run_step wraps inbox_operations.claim_step/execute_step
-- (experiments/inbox-operation-preparation/worker.sql:72-87) without exposing
-- them directly.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;

-- Outbox claim/ack. Byte-identical fencing to
-- inbox_action_api.claim_dispatch_batch/ack_dispatch
-- (experiments/inbox-operation-preparation/worker.sql:95-106), schema-swapped
-- onto inbox_reply_send.dispatch_outbox (PR-E, byte-identical outbox shape —
-- no schema gap). The outbox event ID is the durable-engine idempotency key;
-- a dispatcher only acknowledges after the engine accepts the invocation
-- durably, and only once EVERY attempt of the operation is
-- dispatched-or-terminal (operation_dispatch_complete below — Astra #4
-- ack-readiness). Lost responses leave the lease to expire and redeliver the
-- same immutable event identity.
CREATE FUNCTION inbox_reply_send.claim_dispatch_batch(batch_size integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid dispatch bound';END IF;
 WITH candidates AS(SELECT d.org_id,d.operation_id FROM inbox_reply_send.dispatch_outbox d WHERE d.acknowledged_at IS NULL AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp()) ORDER BY d.created_at,d.event_id LIMIT batch_size FOR UPDATE SKIP LOCKED), claimed AS(
  UPDATE inbox_reply_send.dispatch_outbox d SET generation=d.generation+1,lease_until=clock_timestamp()+interval '30 seconds' FROM candidates c WHERE d.org_id=c.org_id AND d.operation_id=c.operation_id RETURNING d.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('org_id',org_id,'operation_id',operation_id,'event_id',event_id,'generation',generation::text) ORDER BY event_id),'[]') INTO result FROM claimed;
 RETURN result;
END $$;

-- [Astra #4, ack-readiness] Net-new gate absent from the metadata worker's own
-- ack_dispatch: this operation's outbox row is acknowledgeable ONLY when NO
-- attempt is still in {approved,claimed,dispatch_started}. 'uncertain' counts
-- as dispatched-awaiting-callback — the DISPATCH job is done; PR-G's callback
-- lifecycle (uncertain -> provider_accepted, provider_accepted -> delivered/
-- delivery_failed) is a separate concern this worker does not drive. An
-- operation with zero attempts (every item ineligible at accept time) is
-- vacuously complete and acks on the very first pass.
CREATE FUNCTION inbox_reply_send.operation_dispatch_complete(o uuid,op uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.operation_id=op AND a.state IN ('approved','claimed','dispatch_started'))
$$;

CREATE FUNCTION inbox_reply_send.ack_dispatch(o uuid,op uuid,g bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT inbox_reply_send.operation_dispatch_complete(o,op) THEN RETURN false;END IF;
 UPDATE inbox_reply_send.dispatch_outbox SET acknowledged_at=clock_timestamp(),lease_until=NULL WHERE org_id=o AND operation_id=op AND generation=g AND acknowledged_at IS NULL AND lease_until>clock_timestamp();
 RETURN FOUND;
END $$;

-- Net-new enumerator the Restate handler iterates (one ctx.run per attempt).
-- Returns each item's CURRENT (tip-of-chain) attempt id only: a row with a
-- successor (prior_attempt_id pointing back to it) is a retired retry
-- predecessor, always already terminal (D-6(1)'s live-attempt partial unique
-- guarantees at most one non-terminal row per item, and only
-- confirmed_not_submitted/rejected_unsent rows may have a successor at all —
-- attempts.sql:129-134), so it is correctly excluded here: there is nothing
-- left for the worker to do with a row that already has a fresher successor.
-- Stable order: (attempt_ordinal, item_id).
CREATE FUNCTION inbox_reply_send.operation_attempts(o uuid,op uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.id FROM inbox_reply_send.attempts a
 WHERE a.org_id=o AND a.operation_id=op
   AND NOT EXISTS(SELECT 1 FROM inbox_reply_send.attempts s WHERE s.org_id=o AND s.prior_attempt_id=a.id)
 ORDER BY a.attempt_ordinal,a.item_id
$$;

-- [Astra #3] Requester re-authorization, on the SAME connection, between claim
-- and start_dispatch (before the marker). Neither load_operation/run_step
-- (metadata lane) nor PR-D's claim()/start_dispatch() ever call authorize() —
-- both only gate on the global require_admission(). The requester's CURRENT
-- membership was unchecked at dispatch time until this function.
--
-- inbox_action_api.authorize(o,u) (inbox-operation-preparation/setup.sql:13)
-- delegates to inbox_t2_bridge.authorize(o) (inbox-workset-bridge/auth.sql:22),
-- which is fundamentally session/JWT-shaped: it reads auth.uid()/auth.jwt()
-- off `request.jwt.claims` in the CALLING session — there is no variant that
-- takes an arbitrary user id and checks their membership independent of a
-- live session context. A backend worker holds no caller bearer token and
-- must never be handed one. So this function reconstructs the requester's own
-- claims SERVER-SIDE, from their most recent still-live session row (never a
-- caller-supplied token), and runs the SAME check a live request would: a
-- revoked/expired membership, or a missing/expired session (the requester
-- logged out or their session lapsed since acceptance), raises 42501 exactly
-- as inbox_t2_bridge.authorize would for a real expired/revoked caller
-- (INBOX_SESSION_REVOKED/INBOX_SESSION_EXPIRED/INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING).
-- set_config(...,true) is transaction-LOCAL — the claim never leaks past this
-- connection's current transaction. The caller (runner.dispatchAttempt) MUST
-- NOT start_dispatch or send on a raise here — no provider call, ever.
CREATE FUNCTION inbox_reply_send.worker_authorize(o uuid,op uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE requester uuid;sess auth.sessions;claims jsonb;
BEGIN
 SELECT requester_id INTO requester FROM inbox_reply_send.operations WHERE org_id=o AND id=op;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 SELECT * INTO sess FROM auth.sessions WHERE user_id=requester AND not_after>clock_timestamp() ORDER BY not_after DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_SESSION_REVOKED' USING ERRCODE='42501';END IF;
 claims:=jsonb_build_object('sub',requester,'role','authenticated','session_id',sess.id,'exp',extract(epoch FROM sess.not_after)::bigint);
 PERFORM set_config('request.jwt.claims',claims::text,true);
 PERFORM inbox_action_api.authorize(o,requester);
END $$;

-- Thin SECURITY DEFINER pass-throughs onto attempts.sql's plain (invoker-
-- rights) claim()/start_dispatch()/persist() — attempts.sql is frozen (do not
-- touch), and those functions were deliberately left non-SECURITY-DEFINER
-- there (D-9/D-10/D-11 header: "No public API, no route, no worker"). Wrapping
-- here, rather than granting the worker role direct table privileges or
-- EXECUTE on the raw functions, keeps the worker's whole reachable surface to
-- exactly six entry points (worker-role.sql enforces this at install time).
CREATE FUNCTION inbox_reply_send.worker_claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_reply_send.claim(o,attempt_id,seconds) $$;

CREATE FUNCTION inbox_reply_send.worker_start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_reply_send.start_dispatch(o,attempt_id,g) $$;

CREATE FUNCTION inbox_reply_send.worker_persist(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_reply_send.persist(o,attempt_id,token,result) $$;

REVOKE ALL ON FUNCTION inbox_reply_send.claim_dispatch_batch(integer),inbox_reply_send.ack_dispatch(uuid,uuid,bigint),inbox_reply_send.operation_dispatch_complete(uuid,uuid),inbox_reply_send.operation_attempts(uuid,uuid),inbox_reply_send.worker_authorize(uuid,uuid),inbox_reply_send.worker_claim(uuid,uuid,integer),inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint),inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
