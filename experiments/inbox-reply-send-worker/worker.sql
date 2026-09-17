-- Lane 1 PR-F: durable reply-send worker SQL surface. Additive only — does NOT
-- touch attempts.sql or accept.sql (PR-D/PR-E are frozen). Every function here
-- is SECURITY DEFINER and is one of the EIGHT things granted to the dedicated
-- inbox_reply_send_worker role (worker-role.sql): claim_dispatch_batch,
-- ack_dispatch, operation_dispatch_complete, operation_attempts, worker_claim,
-- worker_start_dispatch (which folds the requester re-authorization check in —
-- see its own header below), worker_persist. The role never gets a direct
-- table grant or EXECUTE on attempts.sql's plain (non-DEFINER)
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

-- Thin SECURITY DEFINER pass-through onto attempts.sql's plain (invoker-
-- rights) claim() — attempts.sql is frozen (do not touch), and claim() was
-- deliberately left non-SECURITY-DEFINER there (D-9 header: "No public API,
-- no route, no worker"). Wrapping here, rather than granting the worker role
-- direct table privileges or EXECUTE on the raw function, keeps the worker's
-- reachable surface bounded (worker-role.sql enforces the exact list at
-- install time).
CREATE FUNCTION inbox_reply_send.worker_claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_reply_send.claim(o,attempt_id,seconds) $$;

-- [Astra B1, fixing the original Astra #3 finding] Requester re-authorization
-- FOLDED INTO the same transaction/statement as the ledger start_dispatch
-- call — not a separate prior statement whose locks release before the
-- marker. The original design (a standalone worker_authorize() call before
-- start_dispatch, and — worse — one that fabricated a browser session via
-- request.jwt.claims) had two real defects: (1) its FOR SHARE lock on the
-- access-epoch row was released the instant that statement committed, wide
-- open to a revocation committing in the gap before start_dispatch's own
-- marker write; (2) a background worker inventing a session claims object is
-- the wrong shape entirely — a worker holds no bearer token and must not
-- synthesize one, and worker_authorize was trivially skippable (nothing
-- forced runner.mjs to call it before start_dispatch; it was just a second,
-- separate, un-fenced RPC).
--
-- This function instead:
--  1. Resolves the attempt's operation and the operation's requester_id
--     (never a caller-supplied identity).
--  2. Takes the SAME access-epoch row inbox_t2_bridge.authorize's own
--     authorize() check takes, FOR SHARE, FIRST — inbox_t2_bridge.
--     capture_access() (inbox-workset-bridge/auth.sql:7-19) fires on every
--     memberships UPDATE and does an INSERT..ON CONFLICT DO UPDATE against
--     this exact row, which requires a conflicting row lock. Holding FOR
--     SHARE here means any concurrent membership revocation for this
--     requester now serializes behind THIS transaction — it cannot commit
--     until this function (and the start_dispatch call it makes, in the SAME
--     transaction, further below) has committed or rolled back. There is no
--     window between "check passes" and "marker written" for a revocation to
--     land unnoticed, because the epoch lock is held THROUGH the marker.
--  3. Checks the requester's CURRENT membership directly, using the exact
--     predicate inbox_t2_bridge.authorize uses (auth.sql:31-34): active,
--     not pending deletion, not expired, for the operation's own org. No
--     session, no JWT, no request.jwt.claims fabrication — this is a direct,
--     server-side membership read, exactly the shape a background worker
--     should use.
--  4. Only on success does it call inbox_reply_send.start_dispatch — in the
--     SAME function invocation, i.e. the SAME statement-level transaction —
--     so the epoch lock from step 2 is still held while the marker commits.
-- A revoked/expired/foreign-org membership, or a forged operation/attempt
-- relationship (attempt not found, or operation not found for org o), raises
-- 42501 and start_dispatch is never called — no token, no provider call.
CREATE FUNCTION inbox_reply_send.worker_start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE op uuid;requester uuid;active boolean;
BEGIN
 SELECT a.operation_id INTO op FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.id=attempt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 SELECT r.requester_id INTO requester FROM inbox_reply_send.operations r WHERE r.org_id=o AND r.id=op;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=requester FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACCESS_BASELINE_MISSING' USING ERRCODE='42501';END IF;
 SELECT EXISTS(
  SELECT 1 FROM public.memberships m
  WHERE m.user_id=requester AND m.org_id=o AND m.access_status='active' AND m.deletion_prepared_at IS NULL
   AND (m.access_expires_at IS NULL OR m.access_expires_at>clock_timestamp())
 ) INTO active;
 IF NOT active THEN RAISE EXCEPTION 'INBOX_REPLY_REQUESTER_UNAUTHORIZED' USING ERRCODE='42501';END IF;
 RETURN inbox_reply_send.start_dispatch(o,attempt_id,g);
END $$;

CREATE FUNCTION inbox_reply_send.worker_persist(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_reply_send.persist(o,attempt_id,token,result) $$;

-- [Astra B3] operation_dispatch_complete is called directly by the Restate
-- handler (server.mjs) to decide whether to ack — it is NOT merely an
-- internal helper for ack_dispatch, and must be granted. The worker's
-- reachable surface is EIGHT functions, not seven.
REVOKE ALL ON FUNCTION inbox_reply_send.claim_dispatch_batch(integer),inbox_reply_send.ack_dispatch(uuid,uuid,bigint),inbox_reply_send.operation_dispatch_complete(uuid,uuid),inbox_reply_send.operation_attempts(uuid,uuid),inbox_reply_send.worker_claim(uuid,uuid,integer),inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint),inbox_reply_send.worker_persist(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
