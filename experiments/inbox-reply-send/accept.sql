-- Lane 1 PR-E: wires PR-D's durable send-attempt ledger to the accept path.
-- Additive only — does NOT touch attempts.sql. Flags stay OFF, admission
-- stays CLOSED (require_admission() below), no sends, no worker. This file
-- adds: accept()/recover()/operation_status() in inbox_reply_send, plus a
-- durable dispatch_outbox table so an accepted operation can never be
-- stranded by a crash right after acceptance (PR-F consumes this outbox
-- with a durable claim/ack + recovery scan; this PR only creates the table
-- and the in-commit insert).
--
-- Astra #1 (atomic accept): the whole accept is ONE transaction inserting
-- the operations row + N attempts rows + the outbox row. The BEGIN/
-- EXCEPTION block below only inspects the failing constraint name before
-- re-raising a sanitized, distinct code — the re-raise still aborts the
-- WHOLE enclosing transaction (Postgres exception semantics), so a partial
-- batch can never persist; there is no per-item autonomous insert path.
--
-- Astra #1 (sanitized 23505s): every re-raise below carries no DETAIL/HINT,
-- so a raw constraint-violation message (which would include the phone
-- number for the destination-guard/live-attempt indexes) never leaves this
-- function. Only inbox_reply_send_destination_guard maps to
-- destination_in_progress (55006); every other 23505 gets its own distinct
-- code, matching the brief's per-constraint mapping table.
--
-- Astra #1 (subtractive-only E4): the eligible-set loop below skips a
-- frozen-EXCLUDED item outright (never rechecked, never revived) and drops
-- a frozen-eligible item whose FRESH item_current() recheck now returns an
-- exclusion code. It can never add an item item_current() didn't already
-- allow through freeze.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;

-- Full claim-ready shape (mirrors inbox_operations.dispatch_outbox,
-- experiments/inbox-operation-acceptance/setup.sql:60-65, plus the pending-
-- dispatch partial index) so PR-F's worker can reuse inbox-operation-
-- worker/core.mjs with no schema change. accept() below inserts only
-- (org_id,operation_id); generation/lease_until/acknowledged_at stay at
-- their defaults until PR-F's dispatcher drives them.
CREATE TABLE inbox_reply_send.dispatch_outbox(
 org_id uuid NOT NULL,operation_id uuid NOT NULL,
 event_id uuid NOT NULL DEFAULT gen_random_uuid(),
 generation bigint NOT NULL DEFAULT 0,
 lease_until timestamptz,acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,operation_id),UNIQUE(event_id),
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_reply_send.operations(org_id,id)
);
CREATE INDEX inbox_reply_send_pending_dispatch ON inbox_reply_send.dispatch_outbox(created_at,event_id) WHERE acknowledged_at IS NULL;

-- D-1: single transaction. Steps numbered per the architect brief.
CREATE FUNCTION inbox_reply_send.accept(o uuid,requester uuid,k uuid,preparation_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
 existing_op inbox_reply_send.operations;
 relookup inbox_reply_send.operations;
 prep inbox_reply_review.preparations;
 raw_item jsonb;
 ev text;
 eligible jsonb:='[]'::jsonb;
 eligible_count integer;
 op_id uuid;
 accepted_at timestamptz;
 cn text;
BEGIN
 -- 1. Isolation assert, first statement (same guard as attempts.sql's
 -- item_current/start_dispatch): the fresh-snapshot E4 recheck below
 -- depends on it.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
 END IF;
 IF o IS NULL OR requester IS NULL OR k IS NULL OR preparation_id IS NULL THEN RAISE EXCEPTION 'Invalid accept identity';END IF;
 -- 2. Admission: keeps accept inert while the flag/admission are off.
 PERFORM inbox_reply_review.require_admission();
 -- 3. Idempotent-replay resolution, before any insert.
 SELECT * INTO existing_op FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;
 IF FOUND THEN
  IF existing_op.preparation_id=preparation_id THEN
   RETURN jsonb_build_object('operation_id',existing_op.id,'preparation_id',existing_op.preparation_id,'accepted_at',existing_op.created_at);
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_KEY_REUSED';
  END IF;
 END IF;
 -- 4. Preparation lookup + binding + expiry. Preparations are immutable
 -- (immutable_reply_preparation trigger blocks UPDATE/DELETE for every
 -- non-owner role), so no row lock is required to read it safely; the
 -- expires_at check itself is deferred to just before the insert below (see
 -- note there) so a lock-wait earlier in this function cannot push the
 -- accept past expiry without being caught (mirrors PR-D R3-2).
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=preparation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 IF prep.request_key<>k THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_KEY_MISMATCH';END IF;
 -- 5. Requester authorization: reuses inbox_action_api.authorize(o,u), the
 -- SAME live session/membership check capture()/freeze() already run (and
 -- re-run post-batch) for this lane. A revoked/mismatched requester raises
 -- INBOX_ACTION_FORBIDDEN (42501), already mapped to 403 by reply-api.ts's
 -- failure(). A preparation requested by someone else can never be accepted
 -- by this caller even if the caller's own membership is fine.
 PERFORM inbox_action_api.authorize(o,requester);
 IF prep.requester_id<>requester THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 -- 6. Eligible set: subtractive-only E4 recheck via item_current(). A
 -- frozen-EXCLUDED item (exclusion IS NOT NULL) is skipped WITHOUT any
 -- recheck — never revived. A frozen-eligible item that is now
 -- ineligible (item_current returns a code) or now duplicate-destination is
 -- DROPPED, never re-added. Nothing here can add an item item_current()
 -- wouldn't independently allow.
 FOR raw_item IN SELECT value FROM jsonb_array_elements(prep.items) LOOP
  IF raw_item->>'exclusion' IS NOT NULL THEN CONTINUE;END IF;
  IF coalesce((raw_item->>'duplicateDestination')::boolean,false) THEN CONTINUE;END IF;
  ev:=inbox_reply_send.item_current(o,raw_item);
  IF ev IS NOT NULL THEN CONTINUE;END IF;
  eligible:=eligible||jsonb_build_array(jsonb_build_object(
   'item_id',raw_item->>'id','contact_id',raw_item->'recipient'->>'contactId',
   'from_e164',raw_item->'recipient'->>'from','to_e164',raw_item->'recipient'->>'to',
   'rendered_body',raw_item->'recipient'->>'renderedBody'));
 END LOOP;
 eligible_count:=jsonb_array_length(eligible);
 -- 7. 50-cap up front (E4/D5). guard_attempt()'s own per-insert cap is the
 -- backstop; this rejects an already-over-cap batch before creating
 -- anything at all.
 IF eligible_count>inbox_reply_preparation.recipient_limit() THEN RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';END IF;
 -- Expiry, read last (after every lock-wait-capable statement above:
 -- require_admission's FOR SHARE, authorize()'s access-epoch FOR SHARE) so
 -- a caller delayed past expires_at by a lock wait is still rejected —
 -- clock_timestamp() here is a fresh read, never reused from step 4.
 IF prep.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_EXPIRED';END IF;
 -- 8-9. Atomic insert: operations row + N attempts rows + ONE dispatch_outbox
 -- row, all in THIS transaction/commit (Astra #2). ANY conflict below rolls
 -- back the ENTIRE batch — see the file-header note on exception semantics.
 BEGIN
  INSERT INTO inbox_reply_send.operations(org_id,requester_id,preparation_id,idempotency_key) VALUES(o,requester,preparation_id,k) RETURNING id,created_at INTO op_id,accepted_at;
  IF eligible_count>0 THEN
   INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
    SELECT o,op_id,preparation_id,(x->>'item_id')::uuid,1,(x->>'contact_id')::uuid,x->>'from_e164',x->>'to_e164',
     inbox_reply_send.body_hash(x->>'rendered_body',x->>'from_e164',x->>'to_e164'),'approved'
    FROM jsonb_array_elements(eligible) x;
  END IF;
  INSERT INTO inbox_reply_send.dispatch_outbox(org_id,operation_id) VALUES(o,op_id);
 EXCEPTION
  WHEN unique_violation THEN
   -- Every branch re-raises a sanitized, message-keyed P0001 (no
   -- DETAIL/HINT — the raw 23505 detail would include the phone number for
   -- the destination-guard/live-attempt indexes). reply-api.ts's P0001
   -- conflicts map turns each distinct message into its own HTTP code.
   GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
   IF cn='inbox_reply_send_destination_guard' THEN RAISE EXCEPTION 'INBOX_REPLY_DESTINATION_IN_PROGRESS';
   ELSIF cn IN ('inbox_reply_send_live_attempt','inbox_reply_send_attempt_ordinal','inbox_reply_send_attempt_successor') THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_IDENTITY';
   ELSIF cn IN ('operations_org_id_preparation_id_key','operations_org_id_requester_id_idempotency_key_key') THEN
    -- Astra round-2 finding: do NOT route the idempotency decision on WHICH
    -- of these two operations-table unique indexes fired. A race between
    -- two accepts sharing the SAME (org,requester,key,preparation) violates
    -- BOTH indexes at once, and Postgres reports whichever it happens to
    -- check first — non-deterministic from this function's point of view.
    -- Routing on cn alone would let that race's loser wrongly see
    -- PREPARATION_ACCEPTED instead of replaying the winner's operation, so
    -- a legitimate same-key retry could get a false conflict instead of the
    -- idempotent operationId it's entitled to. Resolve BOTH constraint
    -- names identically, by re-looking up the existing operation by
    -- (org,requester,key) — the same predicate step 3 already used, and the
    -- ONLY reliable signal for "is this actually the same request replaying
    -- or a genuine conflict":
    --  * found, same preparation_id -> idempotent replay, regardless of
    --    which index fired (this is the race step 3's own pre-check can
    --    lose: a concurrent accept committed the same key between our
    --    pre-check and this insert).
    --  * found, different preparation_id -> a genuine key reuse.
    --  * not found by key at all -> this insert's OWN key never matched an
    --    existing operation, so the conflict can only be the OTHER caller's
    --    key already holding this preparation -> preparation already
    --    accepted under a different key.
    SELECT * INTO relookup FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;
    IF FOUND THEN
     IF relookup.preparation_id=preparation_id THEN
      RETURN jsonb_build_object('operation_id',relookup.id,'preparation_id',relookup.preparation_id,'accepted_at',relookup.created_at);
     ELSE
      RAISE EXCEPTION 'INBOX_REPLY_KEY_REUSED';
     END IF;
    ELSE
     RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_ACCEPTED';
    END IF;
   ELSE
    RAISE;
   END IF;
 END;
 RETURN jsonb_build_object('operation_id',op_id,'preparation_id',preparation_id,'accepted_at',accepted_at);
END $$;

-- Mirrors inbox_recover_operation (action-api.ts:150 / review.sql). Given
-- (requester,key,preparation): an existing operation -> 'accepted'; no
-- operation and an expired preparation -> 'expired_not_accepted'; else
-- 'prepared' (reply-api-contract.ts's InboxReplyRecovery vocabulary — the
-- metadata lane's analogous state is spelled 'pending', reply's is
-- 'prepared'; both mean "no operation yet, not expired"). Requester-scoped:
-- a different requester can never recover another's operation or even see
-- whether their preparation exists.
CREATE FUNCTION inbox_reply_send.recover(o uuid,requester uuid,k uuid,preparation_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE existing_op inbox_reply_send.operations;prep inbox_reply_review.preparations;
BEGIN
 IF o IS NULL OR requester IS NULL OR k IS NULL OR preparation_id IS NULL THEN RAISE EXCEPTION 'Invalid recovery reference';END IF;
 PERFORM inbox_reply_review.require_admission();
 PERFORM inbox_action_api.authorize(o,requester);
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=preparation_id;
 IF NOT FOUND OR prep.requester_id<>requester THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 IF prep.request_key<>k THEN RAISE EXCEPTION 'INBOX_REPLY_PREPARATION_KEY_MISMATCH';END IF;
 SELECT * INTO existing_op FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;
 IF FOUND THEN
  IF existing_op.preparation_id<>preparation_id THEN RAISE EXCEPTION 'INBOX_REPLY_KEY_REUSED';END IF;
  RETURN jsonb_build_object('state','accepted','operation',jsonb_build_object('operationId',existing_op.id,'preparationId',existing_op.preparation_id,'idempotencyKey',k));
 ELSE
  RETURN jsonb_build_object('state',CASE WHEN prep.expires_at<=clock_timestamp() THEN 'expired_not_accepted' ELSE 'prepared' END,'preparationId',preparation_id,'idempotencyKey',k,'operation',NULL);
 END IF;
END $$;

-- Mirrors inbox_operation_status (action-api.ts:158). Total, exhaustive
-- per-attempt state->wire mapping: the CASE below has no ELSE, so an
-- attempts.state value outside the ten literals the CHECK constraint
-- permits raises CASE_NOT_FOUND rather than silently defaulting.
CREATE FUNCTION inbox_reply_send.operation_status(o uuid,target_operation_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE op inbox_reply_send.operations;prep inbox_reply_review.preparations;receipts jsonb;complete boolean;
BEGIN
 IF o IS NULL OR target_operation_id IS NULL THEN RAISE EXCEPTION 'Invalid operation reference';END IF;
 SELECT * INTO op FROM inbox_reply_send.operations WHERE org_id=o AND id=target_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=op.preparation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
    'itemId',a.item_id,'attemptId',a.id,'version',a.receipt_version::text,
    'state',CASE a.state
     WHEN 'approved' THEN 'pending' WHEN 'claimed' THEN 'pending'
     WHEN 'dispatch_started' THEN 'dispatch_started'
     WHEN 'skipped_ineligible' THEN 'blocked'
     WHEN 'provider_accepted' THEN 'provider_accepted'
     WHEN 'uncertain' THEN 'uncertain'
     WHEN 'confirmed_not_submitted' THEN 'confirmed_not_submitted'
     WHEN 'rejected_unsent' THEN 'rejected_unsent'
     WHEN 'delivered' THEN 'delivered'
     WHEN 'delivery_failed' THEN 'delivery_failed'
    END,
    'reason',a.evidence) ORDER BY a.item_id),'[]'::jsonb),
   bool_and(a.state IN ('provider_accepted','delivered','delivery_failed','rejected_unsent','confirmed_not_submitted'))
  INTO receipts,complete FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.operation_id=target_operation_id;
 RETURN jsonb_build_object('operationId',op.id,'preparationId',op.preparation_id,'dispatchComplete',coalesce(complete,true),'items',prep.items,'receipts',receipts);
END $$;

DO $$ DECLARE t record;BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='inbox_reply_send' LOOP EXECUTE format('ALTER TABLE inbox_reply_send.%I ENABLE ROW LEVEL SECURITY',t.tablename);END LOOP;END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send FROM PUBLIC;
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA inbox_reply_send FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_send FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send FROM %I',r.rolname);
 END LOOP;
END $$;
COMMIT;
