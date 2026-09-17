-- Private durable bulk-reply send-attempt ledger (Lane 1 PR-D). No public API,
-- no route, no worker, no provider call, no send. This file ONLY records the
-- fenced state machine that PR-E (accept), PR-F (worker+dispatch) and PR-G
-- (callback) build on top of.
--
-- Fencing model (architect notes, binding):
--  - `generation` fences every mutation UP TO the claimed->dispatch_started
--    marker (claim/reclaim). Once that marker is written, `dispatch_token` is
--    the ONLY fence (persist). generation is never consulted again after the
--    marker, and no code path may reuse a generation value or re-issue a
--    dispatch_token once assigned.
--  - The BEFORE trigger enforces the transition matrix independently of every
--    function body below: even a buggy claim/start_dispatch/persist cannot
--    resurrect a terminal row or rewind a marker, because the trigger raises
--    on any UPDATE that isn't a listed edge, and DELETE always raises.
--  - Lock order: the operations row (FOR NO KEY UPDATE, via the INSERT
--    trigger's per-operation admission check) precedes any attempts row.
--    Within an attempt, the attempt row is always FOR UPDATE first; every
--    canonical read after that (sender, inbound head) is FOR SHARE only,
--    matching the prepare/worker inversion note — never FOR UPDATE on
--    heads/versions here. No path in this file, or any future PR-E/F
--    caller, may take the inbound-head row FOR UPDATE and then take a
--    write-lock on a sender row in the same transaction — that specific
--    order is the one shape that can deadlock against item_current()'s own
--    sender-then-head FOR SHARE order.
--  - THE INVARIANT (R3, binding): the last eligibility read happens after
--    the last statement that can WAIT in the transaction; the marker UPDATE
--    is the last statement that can wait, so item_current runs once MORE
--    after it returns. Nothing about a caller's business logic may run
--    between that final item_current() call and the RETURN of its result.
--  - THE ISOLATION CONTRACT (R4, binding): the R3 invariant above only holds
--    because each plpgsql statement takes a FRESH snapshot under READ
--    COMMITTED. Under REPEATABLE READ or SERIALIZABLE the whole transaction
--    shares ONE pinned snapshot, so the post-marker item_current() call would
--    see the exact same (stale) data as the pre-marker call and silently
--    miss a suppression committed during the marker's lock-wait — reverting
--    R3 without any code path looking broken. item_current() and
--    start_dispatch() both assert READ COMMITTED, as their VERY FIRST
--    statement (before any lock — start_dispatch's assert precedes its own
--    FOR UPDATE, so a REPEATABLE READ/SERIALIZABLE caller is rejected
--    immediately rather than left blocking toward a lock timeout), and raise
--    INBOX_REPLY_UNSUPPORTED_ISOLATION (0A000) otherwise. guard_attempt()'s
--    claimed->dispatch_started (marker) transition asserts the SAME thing
--    independently (R5): a caller that writes the marker via a direct
--    UPDATE, bypassing start_dispatch entirely, has no function-body assert
--    to catch it, so the trigger itself closes that hole. THIS IS A BINDING
--    CONTRACT ON PR-F: the reply worker MUST call start_dispatch() (and thus
--    item_current()) under READ COMMITTED — Postgres's default — and must
--    never raise the isolation level for that connection/transaction, in the
--    pg pool config, a Restate wrapper, or any BEGIN/SET on that path.
--  - No body/phone is ever put in an evidence string or RAISE message
--    (S11 audit trail). evidence is always a short lowercase code;
--    provider_reference is the provider's own id, never message content.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;

-- D-12: operations header. NO status column — status is always derived from
-- attempts by callers (PR-E). Reuses the same immutable_row trigger as every
-- other operations/preparations table in this codebase.
CREATE SCHEMA inbox_reply_send AUTHORIZATION postgres;
-- Named-role (anon/authenticated/service_role) revocation is the guarded
-- absence-checking loop near the end of this file (its only mechanism —
-- these unconditional grants would otherwise duplicate and could error on a
-- fixture missing one of those roles). Only the PUBLIC revoke belongs here.
REVOKE ALL ON SCHEMA inbox_reply_send FROM PUBLIC;

-- Ships (e): additive identity anchor for inbox_reply_send.operations' FK.
-- Reply preparations were only ever looked up by (org_id,requester_id,id)
-- until now (setup.sql:26); operations here must be addressable by
-- (org_id,id) alone since the requester who prepared a reply need not be the
-- requester who accepts/claims it in later lanes. Additive only: does not
-- touch inbox_reply_review.setup.sql.
ALTER TABLE inbox_reply_review.preparations ADD CONSTRAINT preparations_org_id_key UNIQUE(org_id,id);

CREATE TABLE inbox_reply_send.operations(
 org_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),requester_id uuid NOT NULL,
 preparation_id uuid NOT NULL,idempotency_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,id),
 UNIQUE(org_id,preparation_id),
 UNIQUE(org_id,requester_id,idempotency_key),
 FOREIGN KEY(org_id,preparation_id) REFERENCES inbox_reply_review.preparations(org_id,id)
);
CREATE TRIGGER immutable_reply_send_operation BEFORE UPDATE OR DELETE ON inbox_reply_send.operations FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();

-- D-5/D-6: the ledger itself. One row per send attempt; item_id is the frozen
-- item's own id (inbox_reply_review preparations.items[].id, setup.sql:122),
-- NEVER inbox_operations.steps (reply lane never used steps; accepted §6
-- deviation, D-1). A NEW attempt row (never an UPDATE) is how a retry after
-- confirmed_not_submitted/rejected_unsent happens — attempt_ordinal
-- increments and prior_attempt_id chains back.
CREATE TABLE inbox_reply_send.attempts(
 org_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 operation_id uuid NOT NULL,
 preparation_id uuid NOT NULL,
 item_id uuid NOT NULL,
 attempt_ordinal integer NOT NULL CHECK(attempt_ordinal>=1),
 prior_attempt_id uuid,
 contact_id uuid NOT NULL,
 from_e164 text NOT NULL CHECK(from_e164 ~ '^\+[1-9][0-9]{1,14}$'),
 to_e164 text NOT NULL CHECK(to_e164 ~ '^\+[1-9][0-9]{1,14}$'),
 body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('approved','claimed','dispatch_started','skipped_ineligible','provider_accepted','uncertain','confirmed_not_submitted','rejected_unsent','delivered','delivery_failed')),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 lease_until timestamptz,
 dispatch_started_at timestamptz,
 dispatch_token uuid,
 receipt_version bigint NOT NULL DEFAULT 0 CHECK(receipt_version>=0),
 provider_reference text CHECK(provider_reference IS NULL OR octet_length(provider_reference)<=512),
 provider_status text CHECK(provider_status IS NULL OR octet_length(provider_status)<=128),
 evidence text CHECK(evidence IS NULL OR (octet_length(evidence)<=128 AND evidence ~ '^[a-z][a-z0-9_:]*$')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,id),
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_reply_send.operations(org_id,id),
 -- D-5 CHECKs, one per ruling clause.
 CHECK((state='claimed')=(lease_until IS NOT NULL)),
 CHECK((dispatch_started_at IS NULL)=(dispatch_token IS NULL)),
 CHECK((dispatch_started_at IS NULL)=(state IN ('approved','claimed','skipped_ineligible'))),
 CHECK((attempt_ordinal=1)=(prior_attempt_id IS NULL)),
 CHECK((state='provider_accepted' OR state IN ('delivered','delivery_failed'))=(provider_reference IS NOT NULL))
);
-- D-6(3): a prior attempt has at most one successor; composite FK back into
-- this same table so a successor's prior_attempt_id must name a real row in
-- the same org.
CREATE UNIQUE INDEX inbox_reply_send_attempt_successor ON inbox_reply_send.attempts(org_id,prior_attempt_id) WHERE prior_attempt_id IS NOT NULL;
ALTER TABLE inbox_reply_send.attempts ADD FOREIGN KEY(org_id,prior_attempt_id) REFERENCES inbox_reply_send.attempts(org_id,id);
-- D-6(1): the "live attempt" partial-unique. rejected_unsent and
-- confirmed_not_submitted are the ONLY two states that permit a successor
-- attempt for the same (preparation,item) — cond7. skipped_ineligible does
-- NOT permit a successor: its remedy is a brand new review/freeze, never a
-- retry attempt chained off it.
CREATE UNIQUE INDEX inbox_reply_send_live_attempt ON inbox_reply_send.attempts(org_id,preparation_id,item_id) WHERE state NOT IN ('rejected_unsent','confirmed_not_submitted');
-- D-6(2): ordinal is unique per (preparation,item) regardless of state.
CREATE UNIQUE INDEX inbox_reply_send_attempt_ordinal ON inbox_reply_send.attempts(org_id,preparation_id,item_id,attempt_ordinal);
-- D-6(4): D2 inter-operation destination guard, verbatim — not widened to
-- more states. Two attempts (any operation) may never simultaneously be
-- live-and-unsent toward the same destination.
CREATE UNIQUE INDEX inbox_reply_send_destination_guard ON inbox_reply_send.attempts(org_id,to_e164) WHERE state IN ('approved','claimed','dispatch_started');
-- D-6(5): sender one-in-flight. Only one attempt per sending number may be
-- mid-flight to the provider at any instant.
CREATE UNIQUE INDEX inbox_reply_send_sender_inflight ON inbox_reply_send.attempts(org_id,from_e164) WHERE state='dispatch_started';

-- D-3: BEFORE INSERT/UPDATE/DELETE transition guard. Independent of every
-- function body in this file — a bug in claim/start_dispatch/persist cannot
-- resurrect a terminal row, rewind a marker, or reuse a fence, because this
-- trigger is the last word on every write to this table.
--
-- The INSERT half also carries D-7's ledger-level P-GATE enforcement: the
-- ONLY reader of the frozen preparation row for send is frozen_item(), and a
-- row that doesn't match the frozen recipient byte-for-byte (or whose frozen
-- item carries an exclusion) is uninsertable, full stop — independent of
-- whatever validation any calling function did or didn't do.
-- text cannot itself contain a NUL byte (chr(0) as text is unrepresentable in
-- Postgres regardless of downstream use), so the chr(0) separator in D-5's
-- formula is realized at the bytea level with decode('00','hex') — the same
-- pattern inbox_operations.preparations' input_hash CHECK already uses.
CREATE FUNCTION inbox_reply_send.body_hash(rendered_body text,from_e164 text,to_e164 text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT encode(sha256(convert_to(coalesce(rendered_body,''),'utf8')||decode('00','hex')||convert_to(coalesce(from_e164,''),'utf8')||decode('00','hex')||convert_to(coalesce(to_e164,''),'utf8')),'hex')
$$;
CREATE FUNCTION inbox_reply_send.guard_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE frozen jsonb;recomputed text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable send attempt';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'approved' THEN RAISE EXCEPTION 'Invalid initial send attempt state';END IF;
  IF NEW.generation<>0 OR NEW.receipt_version<>0 OR NEW.lease_until IS NOT NULL OR NEW.dispatch_started_at IS NOT NULL OR NEW.dispatch_token IS NOT NULL OR NEW.provider_reference IS NOT NULL OR NEW.provider_status IS NOT NULL OR NEW.evidence IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid initial send attempt fields';
  END IF;
  -- Serialize per-operation admission: FOR NO KEY UPDATE (not FOR UPDATE —
  -- stays compatible with the attempts FK's KEY SHARE lock and never fires
  -- operations' own immutable_row trigger) makes two concurrent inserts
  -- against the same operation queue behind each other, so the distinct-
  -- item-count cap below can never be raced past 50 by two inserts that
  -- both read "49" before either commits.
  PERFORM 1 FROM inbox_reply_send.operations WHERE org_id=NEW.org_id AND id=NEW.operation_id AND preparation_id=NEW.preparation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Attempt preparation does not match operation';
  END IF;
  -- P-GATE 4: frozen_item raises on a missing row or exclusion IS NOT NULL.
  -- This makes such a row uninsertable regardless of any caller mistake.
  frozen:=inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id);
  recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
  IF NEW.contact_id IS DISTINCT FROM (frozen->'recipient'->>'contactId')::uuid
     OR NEW.from_e164 IS DISTINCT FROM frozen->'recipient'->>'from'
     OR NEW.to_e164 IS DISTINCT FROM frozen->'recipient'->>'to'
     OR NEW.body_hash IS DISTINCT FROM recomputed THEN
   RAISE EXCEPTION 'Attempt does not match frozen recipient';
  END IF;
  -- D-5/D-9 recipient_limit: the operation's distinct item_id count (this
  -- insert included) must never exceed the D5 bulk-reply cap.
  IF (SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id=NEW.org_id AND operation_id=NEW.operation_id AND item_id<>NEW.item_id)+1>inbox_reply_preparation.recipient_limit() THEN
   RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';
  END IF;
  RETURN NEW;
 END IF;
 -- UPDATE: immutable identity columns, monotonic counters, one-time markers,
 -- then the transition matrix itself.
 IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.preparation_id IS DISTINCT FROM OLD.preparation_id OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.attempt_ordinal IS DISTINCT FROM OLD.attempt_ordinal OR NEW.prior_attempt_id IS DISTINCT FROM OLD.prior_attempt_id
    OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.from_e164 IS DISTINCT FROM OLD.from_e164
    OR NEW.to_e164 IS DISTINCT FROM OLD.to_e164 OR NEW.body_hash IS DISTINCT FROM OLD.body_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Immutable send attempt identity';
 END IF;
 IF NEW.generation<OLD.generation OR NEW.receipt_version<OLD.receipt_version THEN RAISE EXCEPTION 'Send attempt counters may not decrease';END IF;
 IF OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN RAISE EXCEPTION 'dispatch_started_at is immutable once set';END IF;
 IF OLD.dispatch_token IS NOT NULL AND NEW.dispatch_token IS DISTINCT FROM OLD.dispatch_token THEN RAISE EXCEPTION 'dispatch_token is immutable once set';END IF;
 NEW.updated_at:=clock_timestamp();
 CASE
  WHEN OLD.state='approved' AND NEW.state='claimed' THEN NULL;
  -- Reclaim: generation strictly increases; CHECK((dispatch_started_at IS
  -- NULL)=(state IN (...,'claimed',...))) already guarantees the marker is
  -- still unset on both sides of a live 'claimed' state.
  WHEN OLD.state='claimed' AND NEW.state='claimed' THEN
   IF NEW.generation<=OLD.generation THEN RAISE EXCEPTION 'Reclaim must strictly increase generation';END IF;
  WHEN OLD.state='claimed' AND NEW.state='dispatch_started' THEN
   IF NEW.dispatch_started_at IS NULL OR NEW.dispatch_token IS NULL THEN RAISE EXCEPTION 'Dispatch marker must be set exactly once here';END IF;
   -- R5 defense-in-depth (same pattern as the R3-2b window-expiry check
   -- immediately below): the marker edge is the ONE transition whose
   -- correctness depends on start_dispatch's post-marker eligibility
   -- recheck taking a fresh READ COMMITTED snapshot. A caller that bypasses
   -- start_dispatch entirely (a direct UPDATE) has no function-body assert
   -- to catch it, so the trigger itself rejects the marker write outright
   -- under any other isolation level — independent of any function-body
   -- bug, and independent of start_dispatch's own assert. Deliberately NOT
   -- applied to any other transition: claim/skip/persist edges do not carry
   -- this eligibility-snapshot dependency.
   IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
   END IF;
   -- R3-2b defense-in-depth (same D-3/P-GATE-4 pattern as the INSERT path,
   -- which already pays this one-row frozen_item() read): a marker whose
   -- own timestamp is already past the frozen conversation window is
   -- unwritable regardless of any function-body bug in start_dispatch.
   IF NEW.dispatch_started_at>=(inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id)->>'validUntil')::timestamptz THEN
    RAISE EXCEPTION 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER';
   END IF;
  WHEN OLD.state='claimed' AND NEW.state='skipped_ineligible' THEN NULL;
  WHEN OLD.state='dispatch_started' AND NEW.state IN ('provider_accepted','uncertain','confirmed_not_submitted') THEN NULL;
  WHEN OLD.state='uncertain' AND NEW.state='provider_accepted' THEN NULL;
  WHEN OLD.state='provider_accepted' AND NEW.state IN ('delivered','delivery_failed') THEN NULL;
  ELSE RAISE EXCEPTION 'Invalid send attempt transition: % -> %',OLD.state,NEW.state;
 END CASE;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_reply_send_attempt BEFORE INSERT OR UPDATE OR DELETE ON inbox_reply_send.attempts FOR EACH ROW EXECUTE FUNCTION inbox_reply_send.guard_attempt();

-- D-7: the ONLY reader of the frozen preparations row for send.
CREATE FUNCTION inbox_reply_send.frozen_item(o uuid,preparation_id uuid,item_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE prep inbox_reply_review.preparations;item jsonb;
BEGIN
 IF o IS NULL OR preparation_id IS NULL OR item_id IS NULL THEN RAISE EXCEPTION 'INBOX_REPLY_ITEM_UNAVAILABLE';END IF;
 SELECT * INTO prep FROM inbox_reply_review.preparations WHERE org_id=o AND id=preparation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ITEM_UNAVAILABLE';END IF;
 SELECT value INTO item FROM jsonb_array_elements(prep.items) value WHERE (value->>'id')::uuid=item_id;
 IF item IS NULL OR item->>'exclusion' IS NOT NULL THEN RAISE EXCEPTION 'INBOX_REPLY_ITEM_UNAVAILABLE';END IF;
 -- D-7: return ONLY recipient, validUntil, state, dependencies->>'head' and
 -- target — never the whole frozen item (which also carries id, exclusion,
 -- duplicateDestination and the full dependencies snapshot no caller here
 -- needs or should see).
 RETURN jsonb_build_object('recipient',item->'recipient','validUntil',item->'validUntil','state',item->'state','target',item->'target','dependencies',jsonb_build_object('head',item->'dependencies'->>'head'));
END $$;

-- D-8: live eligibility re-check at dispatch time. NULL = eligible, else the
-- exclusion code. Deliberately narrow (P3): does not compare the full
-- policy/known_reply/target/sender/context snapshot — only the five facts
-- listed in the ruling. A contact rename between freeze and dispatch must
-- NOT skip a reviewed send.
CREATE FUNCTION inbox_reply_send.item_current(o uuid,item jsonb) RETURNS text LANGUAGE plpgsql SET search_path='' AS $$
DECLARE qh jsonb;policy_result jsonb;sender public.provider_sender_numbers;head public.inbox_inbound_heads;
BEGIN
 -- R4 (binding, isolation contract): the post-marker savepoint recheck in
 -- start_dispatch relies on EVERY plpgsql statement in THIS function taking a
 -- FRESH snapshot under READ COMMITTED. Under REPEATABLE READ/SERIALIZABLE
 -- the transaction snapshot is pinned at the first query, so this function
 -- (called a second time after the marker UPDATE) would see the SAME stale
 -- snapshot and miss a suppression committed during the marker's lock-wait —
 -- silently reverting the R3 fix and issuing a token to a now-suppressed
 -- destination. Fail fast rather than risk that: every eligibility-recheck
 -- caller (start_dispatch pre-marker + post-marker, and any future PR-E
 -- accept-path E4 reuse) MUST run under READ COMMITTED, full stop.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
 END IF;
 -- INVARIANT: the last eligibility read happens after the last statement
 -- that can WAIT in the transaction; the marker UPDATE is the last
 -- statement that can wait, so item_current runs once MORE after it
 -- returns (see start_dispatch). Inside this function that same invariant
 -- means BOTH canonical FOR SHARE locks — sender, then head — are acquired
 -- FIRST, and only then are ALL FIVE eligibility facts evaluated (including
 -- validUntil and quiet_hours, which round 2 left evaluated before the
 -- locks — a concurrent writer racing the head/sender lock while this
 -- function is mid-wait was still invisible to a validUntil/quiet_hours
 -- check already made from an earlier statement). Each plpgsql statement
 -- takes a fresh snapshot under READ COMMITTED, so if a concurrent writer
 -- holds either row locked (e.g. touching it as part of committing a
 -- suppression) we block here, and once we unblock, EVERY eligibility read
 -- below — all later, separate statements — is guaranteed to see whatever
 -- that writer just committed. Only the lock acquisition and the
 -- clock_timestamp() sampling move; the exclusion precedence itself
 -- (validUntil -> quiet_hours -> destination_policy -> sender -> head) is
 -- unchanged. This function and destination_policy() MUST stay VOLATILE
 -- (never STABLE) — STABLE would pin the snapshot for the whole function
 -- call and silently revert this fix. Never FOR UPDATE on heads/versions or
 -- any suppression table, matching the prepare/worker lock inversion note;
 -- and never take head FOR UPDATE before a sender write-lock in any future
 -- caller — that specific order is the one shape that can deadlock against
 -- this function's own sender-then-head lock order.
 SELECT * INTO sender FROM public.provider_sender_numbers WHERE org_id=o AND provider='sendillo' AND phone_e164=item->'recipient'->>'from' FOR SHARE;
 SELECT * INTO head FROM public.inbox_inbound_heads WHERE org_id=o AND conversation_id=(item->'target'->>'id')::uuid FOR SHARE;
 IF (item->>'validUntil')::timestamptz<=clock_timestamp() THEN RETURN 'conversation_window_expired';END IF;
 qh:=inbox_reply_preparation.quiet_hours(item->>'state',clock_timestamp());
 IF qh->>'ok' IS DISTINCT FROM 'true' THEN
  IF qh->>'reason'='unknown_state' THEN RETURN 'unknown_state';ELSE RETURN 'outside_window';END IF;
 END IF;
 policy_result:=inbox_reply_preparation.destination_policy(o,item->'recipient'->>'to',(item->'recipient'->>'contactId')::uuid,true);
 IF policy_result->>'exclusion' IS NOT NULL THEN RETURN policy_result->>'exclusion';END IF;
 IF sender.status IS DISTINCT FROM 'active' THEN RETURN 'sender_unavailable';END IF;
 IF head.revision::text IS DISTINCT FROM item->'dependencies'->>'head' THEN RETURN 'inbound_changed';END IF;
 RETURN NULL;
END $$;

-- D-9: claim/reclaim. Admission-gated (deliberate; persist is not).
CREATE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 IF (SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id=o AND operation_id=row.operation_id)>inbox_reply_preparation.recipient_limit() THEN
  RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';
 END IF;
 IF row.state='approved' OR (row.state='claimed' AND row.lease_until<=clock_timestamp() AND row.dispatch_started_at IS NULL) THEN
  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;
  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);
 ELSIF row.state='claimed' THEN
  RETURN jsonb_build_object('kind','busy');
 ELSIF row.state='dispatch_started' THEN
  -- Re-entry after a crash/redeploy between the dispatch marker and any
  -- result: label uncertain, never re-claim (never a second token).
  UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='reentered_without_result',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','existing','state','uncertain');
 ELSE
  RETURN jsonb_build_object('kind','existing','state',row.state);
 END IF;
END $$;

-- D-10: the fenced hand-off to the provider call. MUST be the last statement
-- in its transaction — the caller (PR-F) commits and releases every lock
-- before making the outbound provider call.
CREATE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;cn text;
BEGIN
 -- R4/R5 (binding, isolation contract, same as item_current): this MUST be
 -- the very first statement, before the FOR UPDATE row lock below. Under
 -- REPEATABLE READ/SERIALIZABLE a caller sharing a sender with an
 -- in-flight dispatch would otherwise block on the attempt row's FOR
 -- UPDATE (or the sender-inflight index later) and surface as a lock
 -- timeout instead of a clean, immediate rejection — belt-and-suspenders
 -- with the item_current assert, since a caller could theoretically
 -- bypass item_current entirely. Reading current_setting() needs no lock.
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';
 END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 -- P2.4 fast path (kept) — a cheap pre-check that avoids running item_current
 -- at all when the sender is obviously already busy. The real fence is the
 -- unique index guarding the marker UPDATE below.
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 -- Pre-marker cheap skip: returns without ever touching the sender-inflight
 -- index when the item is already visibly ineligible. This does NOT
 -- satisfy the invariant below by itself — see the post-marker recheck.
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 token:=gen_random_uuid();
 -- INVARIANT: the last eligibility read happens after the last statement
 -- that can WAIT in the transaction; the marker UPDATE is the last
 -- statement that can wait (it can block on the D-6(5) sender-inflight
 -- unique index), so item_current runs once MORE after it returns — inside
 -- this same savepoint-shaped EXCEPTION block, so a stale-at-marker result
 -- rolls the marker/token back in-tx rather than ever being returned to a
 -- caller. The pre-marker call above is a cheap optimization only; this one
 -- is the actual gate. frozen need not be re-read (preparations are
 -- immutable) and the outer attempt row's FOR UPDATE lock is retained
 -- throughout — only the marker write itself rolls back.
 BEGIN
  UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
  -- The LAST read, after the marker's own wait. `ev` is reassigned here (not
  -- reused from the pre-marker call above) so a caught IR001 below records
  -- the FRESH reason as evidence.
  ev:=inbox_reply_send.item_current(o,frozen);
  IF ev IS NOT NULL THEN RAISE EXCEPTION 'stale after marker' USING ERRCODE='IR001';END IF;
 EXCEPTION
  WHEN SQLSTATE 'IR001' THEN
   -- The marker UPDATE above rolled back to this block's implicit savepoint:
   -- state, dispatch_started_at and dispatch_token are all back to their
   -- pre-BEGIN ('claimed') values, so this UPDATE's OLD.state='claimed' is a
   -- listed trigger edge, exactly like the pre-marker skip path.
   UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
   RETURN jsonb_build_object('kind','skipped','reason',ev);
  WHEN unique_violation THEN
   -- P2.4: the fast pre-check above can miss a same-instant competitor (it
   -- only sees already-committed dispatch_started rows). The D-6(5) unique
   -- index on (org_id,from_e164) WHERE state='dispatch_started' is the real
   -- fence; a unique_violation here is only ever this specific race —
   -- anything else re-raises unchanged. The 55P03 carries no DETAIL/HINT so
   -- the raw 23505 detail (which would include the phone number) never
   -- leaks. Deliberately no WHEN OTHERS here: any other error must abort
   -- the whole transaction, never be swallowed by this block.
   GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
   IF cn='inbox_reply_send_sender_inflight' THEN RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
   ELSE RAISE;
   END IF;
 END;
 -- Body is read VERBATIM from the frozen row (P-GATE 3/R4) — never copied
 -- into this table, never re-rendered, never re-parsed as template syntax.
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $$;

-- D-11: reconcile a provider result. Deliberately NOT admission-gated — a
-- result already in flight must always be recordable so the ledger never
-- drifts from reality merely because admission was flipped off mid-flight.
CREATE FUNCTION inbox_reply_send.persist(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;kind text;reference text;reason text;v bigint;
BEGIN
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR token IS NULL OR row.dispatch_token IS DISTINCT FROM token THEN RAISE EXCEPTION 'INBOX_REPLY_STALE_TOKEN';END IF;
 -- B1: compute kind first and check it for NULL explicitly. `result->>'kind'
 -- NOT IN (...)` is itself NULL (never TRUE) when the key is absent or JSON
 -- null, so a `{}` or `{"kind":null}` result previously sailed past this
 -- guard and fell into the ELSE branch below as a silent not_attempted ->
 -- confirmed_not_submitted (a terminal state that frees a successor attempt
 -- for the same item) — a double/wrong-send door with no explicit result at
 -- all. jsonb_typeof(result) is checked first so kind:=result->>'kind' is
 -- always evaluated against a genuine object.
 IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid dispatch result';END IF;
 kind:=result->>'kind';
 IF kind IS NULL OR kind NOT IN ('accepted','not_attempted','uncertain') THEN RAISE EXCEPTION 'Invalid dispatch result';END IF;
 IF row.state='dispatch_started' THEN
  IF kind='accepted' THEN
   reference:=result->>'externalId';
   IF reference IS NULL OR btrim(reference)='' OR octet_length(reference)>512 THEN RAISE EXCEPTION 'Invalid provider reference';END IF;
   UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference=reference,provider_status=left(result->>'status',128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','provider_accepted','receipt_version',v::text);
  ELSIF kind='uncertain' THEN
   reason:=coalesce(result->>'reason','unknown');
   UPDATE inbox_reply_send.attempts SET state='uncertain',evidence=left(reason,128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','uncertain','receipt_version',v::text);
  ELSIF kind='not_attempted' THEN
   -- B2: D-4 bounds not_attempted's reason to the two proven-non-submit
   -- codes. A provider TIMEOUT (or any other reason) is NOT a proven
   -- non-submit — it is uncertain by definition — so it must never reach
   -- confirmed_not_submitted, a terminal state that frees a successor
   -- attempt. Any other reason raises rather than silently defaulting.
   reason:=result->>'reason';
   IF reason IS NULL OR reason NOT IN ('invalid_input','cancelled_before_dispatch') THEN RAISE EXCEPTION 'Invalid not_attempted reason';END IF;
   UPDATE inbox_reply_send.attempts SET state='confirmed_not_submitted',evidence=left('local_not_attempted:'||reason,128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','confirmed_not_submitted','receipt_version',v::text);
  END IF;
 ELSIF row.state='uncertain' THEN
  IF kind='accepted' THEN
   reference:=result->>'externalId';
   IF reference IS NULL OR btrim(reference)='' OR octet_length(reference)>512 THEN RAISE EXCEPTION 'Invalid provider reference';END IF;
   UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference=reference,provider_status=left(result->>'status',128),receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
   RETURN jsonb_build_object('state','provider_accepted','receipt_version',v::text);
  ELSIF kind='uncertain' THEN
   RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
  END IF;
 ELSIF row.state IN ('provider_accepted','delivered','delivery_failed') THEN
  IF kind='uncertain' THEN
   RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
  ELSIF kind='accepted' THEN
   reference:=result->>'externalId';
   IF reference IS NOT DISTINCT FROM row.provider_reference THEN
    RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);
   ELSE
    RAISE EXCEPTION 'INBOX_REPLY_CONTRADICTORY_RECEIPT';
   END IF;
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
  END IF;
 ELSE
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
 END IF;
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
