-- Lane 1 PR-G: reply-specific Sendillo callback ingress + reconciliation.
-- Additive only — does NOT touch attempts.sql/accept.sql (byte-identical to
-- merged). Drives provider_accepted -> delivered|delivery_failed, the ONE
-- trigger edge attempts.sql already allows (attempts.sql:244) but that no
-- function before this file exercised.
--
-- Astra #6 (do not reuse the Outbox webhook helpers): public.webhook_events
-- (supabase/migrations/001_initial.sql:287-303) has NO org_id column and NO
-- lease/generation columns at all — confirmed by inspection, not assumed.
-- Retrofitting org-scoping + lease-fencing onto that shared table would
-- either widen a table other providers/lanes depend on, or bolt fencing onto
-- a dedup key `(provider,event_type,external_id)` that already has no
-- concept of a lease owner. Instead this file adds a NEW, fully-owned
-- reservation table in this schema (inbox_reply_send.callback_receipts)
-- with its own org_id + lease_owner/lease_generation columns, reachable only
-- through the service-role wrapper below. Its event_type is always prefixed
-- `inbox_reply_status_`, so its dedup key can never collide with the
-- Outbox's `sms_status_*` rows even if both tables are ever compared side by
-- side.
--
-- Astra #5 (callback-before-persist tolerance): persist() (attempts.sql:439)
-- is the ONLY writer of attempts.provider_reference, and it can commit AFTER
-- a delivery callback for the same reference already arrived. A callback
-- whose reference does not yet match any attempt is stored durably in
-- unmatched_callbacks (never discarded, never matched by phone) and later
-- drained by drain_unmatched() once persist() binds the reference. uncertain
-- attempts whose only identity was a dropped reportedExternalId
-- (attempts.sql:462 keeps only evidence) are NOT auto-reconciled by this
-- file — see the [ARCH] note below; their callbacks still land durably in
-- unmatched_callbacks for audit/manual association, never dropped.
--
-- No blind retry: nothing here ever calls the reply provider or issues a
-- new dispatch. This file only ever moves a row that is ALREADY
-- provider_accepted to a terminal state, or leaves it untouched.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;

-- [ARCH] Global-unique on the Sendillo externalId: Sendillo's own message
-- ids are globally unique, so a callback can be matched by reference alone
-- without knowing the org up front (the webhook carries no org identity).
-- A second persist() binding an already-used reference now hits 23505
-- instead of silently mis-associating two attempts with one provider
-- message. provider_reference never carries phone/body content (it is the
-- provider's own opaque id, CHECK-bounded at attempts.sql:110), so the raw
-- constraint DETAIL from a 23505 here cannot leak a phone number even
-- unsanitized — verified by proof, not merely asserted.
CREATE UNIQUE INDEX inbox_reply_send_provider_reference ON inbox_reply_send.attempts(provider_reference) WHERE provider_reference IS NOT NULL;

-- Astra #5: durable holding table for a callback that arrived before the
-- matching persist() committed. No org column — org is unknown until a
-- matching attempts row exists. PRIMARY KEY(provider,provider_reference)
-- makes the insert itself the dedup key; ON CONFLICT DO NOTHING below means
-- the FIRST captured terminal status for a given reference is retained
-- (first-terminal-wins, mirroring reconcile_delivery's own precedence) —
-- never overwritten by a later, possibly-contradictory redelivery, and
-- never discarded either way.
CREATE TABLE inbox_reply_send.unmatched_callbacks(
 provider text NOT NULL,
 provider_reference text NOT NULL CHECK(provider_reference<>'' AND octet_length(provider_reference)<=512),
 terminal_status text NOT NULL CHECK(terminal_status IN ('delivered','delivery_failed')),
 payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(provider,provider_reference)
);

-- Astra #6: the reply-namespaced, org-scoped, lease-fenced idempotency
-- table. Only ever written for a MATCHED callback (org known) — an
-- unmatched callback dedups in unmatched_callbacks above instead, exactly
-- as the brief requires (never a sentinel-org row here). event_type is
-- always 'inbox_reply_status_delivered' or 'inbox_reply_status_delivery_failed',
-- so PRIMARY KEY(provider,event_type,external_id) can never collide with
-- the Outbox's own `sms_status_*` webhook_events rows even though the key
-- shape looks similar — this is a wholly separate table.
CREATE TABLE inbox_reply_send.callback_receipts(
 org_id uuid NOT NULL,
 provider text NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('inbox_reply_status_delivered','inbox_reply_status_delivery_failed')),
 external_id text NOT NULL CHECK(external_id<>'' AND octet_length(external_id)<=512),
 processing_status text NOT NULL DEFAULT 'processing' CHECK(processing_status IN ('processing','processed','error')),
 lease_owner uuid NOT NULL,
 lease_generation bigint NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
 lease_until timestamptz NOT NULL,
 payload jsonb NOT NULL,
 error_message text CHECK(error_message IS NULL OR octet_length(error_message)<=256),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 processed_at timestamptz,
 PRIMARY KEY(provider,event_type,external_id)
);
CREATE INDEX inbox_reply_send_callback_receipts_org ON inbox_reply_send.callback_receipts(org_id);

-- D-11-style reconcile: the ONLY function that drives provider_accepted ->
-- delivered|delivery_failed. FOR UPDATE mirrors persist()'s own locking.
-- Org-scoped (WHERE org_id=o AND ...): a reference that exists but under a
-- DIFFERENT org is NOT FOUND here (rejected), never touched — this is what
-- makes a cross-org callback safely a no-op/reject rather than a leak or a
-- cross-tenant write, independent of how the caller resolved `o`.
--
-- Status precedence [ARCH]: terminal states are mutually exclusive and
-- first-terminal-wins. A matching redelivery (row already at `terminal`) is
-- an idempotent no-op. A genuinely contradictory second terminal (delivered
-- then delivery_failed, or vice-versa) raises INBOX_REPLY_CONTRADICTORY_RECEIPT
-- — reusing persist()'s own code for the same underlying concept (attempts.sql:495)
-- — and never silently flips the row.
CREATE FUNCTION inbox_reply_send.reconcile_delivery(o uuid,provider text,provider_reference text,terminal text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;v bigint;
BEGIN
 IF o IS NULL OR provider IS DISTINCT FROM 'sendillo' OR provider_reference IS NULL OR btrim(provider_reference)='' OR terminal NOT IN ('delivered','delivery_failed') OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_CALLBACK';
 END IF;
 SELECT * INTO row FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.provider_reference=reconcile_delivery.provider_reference FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'INBOX_REPLY_CALLBACK_UNMATCHED';
 END IF;
 IF row.state='provider_accepted' THEN
  UPDATE inbox_reply_send.attempts SET state=terminal,receipt_version=receipt_version+1 WHERE org_id=o AND id=row.id RETURNING receipt_version INTO v;
  RETURN jsonb_build_object('state',terminal,'receipt_version',v::text,'applied',true);
 ELSIF row.state IN ('delivered','delivery_failed') THEN
  IF row.state=terminal THEN
   RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text,'applied',false);
  ELSE
   RAISE EXCEPTION 'INBOX_REPLY_CONTRADICTORY_RECEIPT';
  END IF;
 ELSE
  -- Includes 'uncertain' deliberately: [ARCH] this file never reopens the
  -- merged ledger to bind a dropped reportedExternalId, so an uncertain
  -- attempt is never auto-reconciled by reference here even if a later
  -- callback happens to name it (it can't — uncertain rows have no
  -- provider_reference, so the lookup above would never have found them in
  -- the first place; this branch exists only as defense-in-depth for any
  -- future caller).
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_PERSIST_TRANSITION';
 END IF;
END $$;

-- Astra #5: drains a now-persisted reference's holding row. FOR UPDATE on
-- the holding row serializes concurrent drains of the SAME reference; once
-- reconcile_delivery succeeds the holding row is deleted, so a second call
-- (opportunistic ingress retry + a later sweep both racing the same
-- reference) finds NOT FOUND and is a clean no-op — applies exactly once.
CREATE FUNCTION inbox_reply_send.drain_unmatched(provider text,provider_reference text) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE held inbox_reply_send.unmatched_callbacks;att_org uuid;result jsonb;
BEGIN
 SELECT * INTO held FROM inbox_reply_send.unmatched_callbacks u WHERE u.provider=drain_unmatched.provider AND u.provider_reference=drain_unmatched.provider_reference FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('drained',false,'reason','no_holding_row');END IF;
 SELECT a.org_id INTO att_org FROM inbox_reply_send.attempts a WHERE a.provider_reference=drain_unmatched.provider_reference;
 IF NOT FOUND THEN RETURN jsonb_build_object('drained',false,'reason','still_unmatched');END IF;
 result:=inbox_reply_send.reconcile_delivery(att_org,held.provider,held.provider_reference,held.terminal_status,held.payload);
 DELETE FROM inbox_reply_send.unmatched_callbacks u WHERE u.provider=drain_unmatched.provider AND u.provider_reference=drain_unmatched.provider_reference;
 RETURN jsonb_build_object('drained',true,'result',result);
END $$;

-- Public/service wrapper. Mirrors public-api.sql's SECURITY DEFINER idiom,
-- but granted to service_role only, never authenticated/anon — the caller
-- is the ingress route's admin client (no user session), not a signed-in
-- member. This is the ONLY service-role reach into inbox_reply_send (the
-- ledger revokes service_role wholesale at attempts.sql:508-514); it does
-- the org resolution + reserve/reconcile/store-unmatched atomically in one
-- transaction so there is no TOCTOU window between "who owns this
-- reference" and "did we already process this exact callback".
--
-- Reservation/completion is fenced by (lease_owner,lease_generation): this
-- call always mints a FRESH lease_owner and increments lease_generation
-- past whatever is currently stored, then only marks the row
-- processed/error if that exact (lease_owner,lease_generation) still owns
-- the row at completion time — a losing concurrent claim can never mark a
-- winner's row processed, and a stale retry can never re-open a completed
-- one.
CREATE FUNCTION public.inbox_reply_reconcile_callback(in_provider text,in_external_id text,in_terminal text,in_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE att_org uuid;in_event_type text;existing inbox_reply_send.callback_receipts;my_owner uuid:=gen_random_uuid();my_generation bigint;claimed boolean:=false;result jsonb;completed integer;
BEGIN
 IF in_provider IS DISTINCT FROM 'sendillo' OR in_external_id IS NULL OR btrim(in_external_id)='' OR octet_length(in_external_id)>512 OR in_terminal NOT IN ('delivered','delivery_failed') OR jsonb_typeof(in_payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_CALLBACK';
 END IF;
 in_event_type:='inbox_reply_status_'||in_terminal;

 SELECT a.org_id INTO att_org FROM inbox_reply_send.attempts a WHERE a.provider_reference=in_external_id;
 IF NOT FOUND THEN
  INSERT INTO inbox_reply_send.unmatched_callbacks AS u(provider,provider_reference,terminal_status,payload)
   VALUES(in_provider,in_external_id,in_terminal,in_payload) ON CONFLICT (provider,provider_reference) DO NOTHING;
  RETURN jsonb_build_object('kind','stored_unmatched');
 END IF;

 -- Reserve/claim, lease-fenced. Try the fast INSERT path first (first-ever
 -- delivery of this exact reply-namespaced event); fall back to a fenced
 -- reclaim only on conflict.
 BEGIN
  INSERT INTO inbox_reply_send.callback_receipts AS c(org_id,provider,event_type,external_id,processing_status,lease_owner,lease_generation,lease_until,payload)
   VALUES(att_org,in_provider,in_event_type,in_external_id,'processing',my_owner,0,clock_timestamp()+interval '5 minutes',in_payload);
  my_generation:=0;claimed:=true;
 EXCEPTION WHEN unique_violation THEN
  SELECT * INTO existing FROM inbox_reply_send.callback_receipts c WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id FOR UPDATE;
  IF NOT FOUND THEN RAISE; END IF;
  IF existing.processing_status='processed' THEN
   RETURN jsonb_build_object('kind','already_processed');
  ELSIF existing.processing_status='processing' AND existing.lease_until>clock_timestamp() THEN
   RETURN jsonb_build_object('kind','busy');
  ELSE
   my_generation:=existing.lease_generation+1;
   UPDATE inbox_reply_send.callback_receipts AS c
    SET processing_status='processing',lease_owner=my_owner,lease_generation=my_generation,lease_until=clock_timestamp()+interval '5 minutes',payload=in_payload,error_message=NULL
    WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id
      AND c.lease_generation=existing.lease_generation;
   GET DIAGNOSTICS completed=ROW_COUNT;
   IF completed<>1 THEN RETURN jsonb_build_object('kind','busy');END IF;
   claimed:=true;
  END IF;
 END;
 IF NOT claimed THEN RETURN jsonb_build_object('kind','busy');END IF;

 BEGIN
  result:=inbox_reply_send.reconcile_delivery(att_org,in_provider,in_external_id,in_terminal,in_payload);
  UPDATE inbox_reply_send.callback_receipts AS c
   SET processing_status='processed',processed_at=clock_timestamp()
   WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id
     AND c.lease_owner=my_owner AND c.lease_generation=my_generation;
  RETURN jsonb_build_object('kind','reconciled','result',result);
 EXCEPTION WHEN OTHERS THEN
  UPDATE inbox_reply_send.callback_receipts AS c
   SET processing_status='error',processed_at=clock_timestamp(),error_message=left(SQLERRM,256)
   WHERE c.provider=in_provider AND c.event_type=in_event_type AND c.external_id=in_external_id
     AND c.lease_owner=my_owner AND c.lease_generation=my_generation;
  RAISE;
 END;
END $$;
REVOKE ALL ON FUNCTION public.inbox_reply_reconcile_callback(text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_reply_reconcile_callback(text,text,text,jsonb) TO service_role;

DO $$ DECLARE t record;BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='inbox_reply_send' AND tablename IN ('unmatched_callbacks','callback_receipts') LOOP EXECUTE format('ALTER TABLE inbox_reply_send.%I ENABLE ROW LEVEL SECURITY',t.tablename);END LOOP;END $$;
REVOKE ALL ON inbox_reply_send.unmatched_callbacks,inbox_reply_send.callback_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION inbox_reply_send.reconcile_delivery(uuid,text,text,text,jsonb),inbox_reply_send.drain_unmatched(text,text) FROM PUBLIC;
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON inbox_reply_send.unmatched_callbacks,inbox_reply_send.callback_receipts FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON FUNCTION inbox_reply_send.reconcile_delivery(uuid,text,text,text,jsonb),inbox_reply_send.drain_unmatched(text,text) FROM %I',r.rolname);
 END LOOP;
END $$;
COMMIT;
