-- Private canonical recipient capture. No public API or send permission.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;
CREATE SCHEMA inbox_reply_preparation AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_reply_preparation FROM PUBLIC,anon,authenticated,service_role;
-- Exact current application normalization (csv/normalize.ts), not a new phone
-- policy. It admits ten digits, or eleven digits beginning with one.
CREATE FUNCTION inbox_reply_preparation.phone(raw text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN length(d)=10 THEN '+1'||d WHEN length(d)=11 AND left(d,1)='1' THEN '+'||d END FROM (SELECT regexp_replace(raw,'[^0-9]','','g') d) s
$$;
-- Single source of truth for the D5 bulk-reply recipient cap. batch.sql and
-- inbox_reply_review.view() (setup.sql) both call this instead of repeating
-- the literal; src/lib/inbox/reply-api-contract.ts's INBOX_REPLY_RECIPIENT_LIMIT
-- constant must stay in parity (checked by a TS test reading this source file).
CREATE FUNCTION inbox_reply_preparation.recipient_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT 50
$$;
-- E1-E4 (Fable round 4): the SOLE eligibility authority for the reply lane.
-- Previously, eligibility was re-derived ad hoc inside recipient() from just
-- the canonical (conversation's) contact row, which is how three separate
-- fail-open holes reached this file across rounds 1-3: a first-slot-only
-- pick (round 3), and no cross-contact/global-DNC awareness at all (this
-- round). destination_policy() is now the ONE place that decides whether a
-- normalized E.164 destination is eligible, evaluated org-wide — not
-- per-contact — so a fix here closes the hole for every caller, present and
-- future, instead of being re-litigated per caller.
--
-- Evaluated in order, first hit wins (tie prefers opt-out):
--  1. sms_phone_suppressions exact match — parity with send.ts's
--     isSmsPhoneSuppressed (opt-out-phone.ts).
--  2. global_phone_dnc_registry exact match — production code in src/ never
--     reads this table for send-eligibility today; this closes that gap for
--     the reply lane specifically.
--  3. ANY contact in the org with a phone slot normalizing to this
--     destination that is do_not_contact/sms_opted_out, or whose latest sms
--     consent event is an opt-out — closes cross-contact bleed (the same
--     number saved under a second contact record with a suppression flag
--     the canonical contact doesn't carry).
--  4. ANY matching slot across those contacts is 'landline' — hard block.
-- `strict` (default true, fail-closed) additionally requires EVERY matching
-- slot to be 'mobile' (else 'unclassified_phone') and the CANONICAL
-- contact's latest sms consent event to be an affirmative opt-in (else
-- 'no_consent'). Steps 1-4 run under both strict values; only the two extra
-- checks are strict-gated. Flipping strict to false (production parity with
-- send.ts/bulk-queue.ts) is Jarrad's call, and is a single argument change,
-- not a rewrite.
--
-- PLACEMENT (E4, not built in this PR): capture/freeze (this file, PR-A)
-- calls this once per candidate and freezes the result. Acceptance (PR C/E)
-- MUST re-run this predicate live per frozen item before commit — a newly
-- surfaced exclusion there is a 409 (stale review), and the 50-cap recounts
-- after removing newly-ineligible items. The dispatch worker's claim step
-- (PR F) MUST re-run it again per item immediately before dispatch_started —
-- an exclusion there terminates that item as 'skipped_ineligible' with no
-- provider attempt, never a silent send. Neither of those call sites exists
-- yet; this is the contract they must honor when built.
CREATE FUNCTION inbox_reply_preparation.destination_policy(o uuid,destination text,canonical_contact uuid,strict boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE any_landline boolean;any_non_mobile boolean;canonical_consent text;
BEGIN
 IF o IS NULL OR destination IS NULL OR canonical_contact IS NULL OR strict IS NULL THEN RAISE EXCEPTION 'Invalid destination policy input';END IF;
 -- 1. Explicit phone-level suppression (org-scoped exact E.164 match).
 IF EXISTS(SELECT 1 FROM public.sms_phone_suppressions WHERE org_id=o AND channel='sms' AND phone_e164=destination) THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 -- 2. Global DNC registry (org-scoped exact E.164 match) — never checked by
 -- production send.ts/bulk-queue.ts today.
 IF EXISTS(SELECT 1 FROM public.global_phone_dnc_registry WHERE org_id=o AND phone_e164=destination) THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 -- 3. Cross-contact bleed: ANY org contact sharing this destination across
 -- any of its saved slots, flagged suppressed or opted out — not just the
 -- canonical contact for this conversation.
 IF EXISTS(
   SELECT 1 FROM public.contacts ct WHERE ct.org_id=o
   AND EXISTS(SELECT 1 FROM (VALUES(ct.phone_1),(ct.phone_2),(ct.phone_3)) slots(phone) WHERE inbox_reply_preparation.phone(phone)=destination)
   AND (
     ct.do_not_contact IS TRUE OR ct.sms_opted_out IS TRUE
     OR (SELECT ce.event_type FROM public.consent_events ce WHERE ce.org_id=o AND ce.contact_id=ct.id AND ce.channel='sms' AND ce.event_type IN ('opt_in_marketing_written','opt_in_confirmed','opt_in_informational','opt_out','provider_auto_opt_out') ORDER BY ce.occurred_at DESC,(ce.event_type IN ('opt_out','provider_auto_opt_out')) DESC,ce.id DESC LIMIT 1) IN ('opt_out','provider_auto_opt_out')
   )
 ) THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 -- 4. Landline across every matching slot on every matching org contact.
 SELECT bool_or(t='landline'),bool_or(t IS DISTINCT FROM 'mobile') INTO any_landline,any_non_mobile
 FROM public.contacts ct,LATERAL (VALUES(ct.phone_1,ct.phone_1_type),(ct.phone_2,ct.phone_2_type),(ct.phone_3,ct.phone_3_type)) slots(phone,t)
 WHERE ct.org_id=o AND inbox_reply_preparation.phone(slots.phone)=destination;
 IF any_landline THEN RETURN jsonb_build_object('exclusion','landline');END IF;
 IF strict THEN
  IF any_non_mobile THEN RETURN jsonb_build_object('exclusion','unclassified_phone');END IF;
  SELECT ce.event_type INTO canonical_consent FROM public.consent_events ce WHERE ce.org_id=o AND ce.contact_id=canonical_contact AND ce.channel='sms' AND ce.event_type IN ('opt_in_marketing_written','opt_in_confirmed','opt_in_informational','opt_out','provider_auto_opt_out') ORDER BY ce.occurred_at DESC,(ce.event_type IN ('opt_out','provider_auto_opt_out')) DESC,ce.id DESC LIMIT 1;
  IF canonical_consent IS DISTINCT FROM 'opt_in_marketing_written' AND canonical_consent IS DISTINCT FROM 'opt_in_confirmed' AND canonical_consent IS DISTINCT FROM 'opt_in_informational' THEN RETURN jsonb_build_object('exclusion','no_consent');END IF;
 END IF;
 RETURN jsonb_build_object('exclusion',NULL);
END $$;
CREATE FUNCTION inbox_reply_preparation.recipient(o uuid,c uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE initial jsonb;resolved jsonb;p public.properties;contact public.contacts;inbound public.messages;head public.inbox_inbound_heads;
 target_revision bigint;content_revision bigint;capture_generation uuid;destination text;business text;destination_result jsonb;sender uuid;inventory jsonb;organization jsonb;market jsonb;requirements jsonb;policy jsonb;
BEGIN
 IF o IS NULL OR c IS NULL THEN RAISE EXCEPTION 'Invalid recipient identity';END IF;
 initial:=inbox_t2_summary_contract.compute(o,c,clock_timestamp());
 IF initial->>'exists' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('exclusion','conversation_unavailable');END IF;
 -- Canonical source locks precede version locks. The outer preparation orders
 -- conversations deterministically and retries whole aborted transactions.
 SELECT * INTO p FROM public.properties WHERE org_id=o AND id=(initial->>'property_id')::uuid FOR SHARE;
 IF NOT FOUND OR p.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('exclusion','property_unavailable');END IF;
 IF p.is_training IS TRUE OR p.is_dnc_locked IS TRUE OR p.outreach_dispo IN ('wrong_number','bad_number','dnc','opted_out') THEN RETURN jsonb_build_object('exclusion','property_suppressed');END IF;
 SELECT * INTO contact FROM public.contacts WHERE org_id=o AND id=(initial->>'contact_id')::uuid FOR SHARE;
 IF NOT FOUND OR contact.id IS DISTINCT FROM p.homeowner_contact_id THEN RETURN jsonb_build_object('exclusion','contact_mapping_unavailable');END IF;
 IF contact.do_not_contact IS TRUE OR contact.sms_opted_out IS TRUE THEN RETURN jsonb_build_object('exclusion','contact_suppressed');END IF;
 -- Historical baseline only after an actual canonical inbound exists. Do not
 -- allocate immortal heads/version rows for caller-generated nonexistent IDs.
 IF NOT EXISTS(SELECT 1 FROM public.messages WHERE org_id=o AND conversation_id=c AND channel='sms' AND direction='inbound' AND status NOT IN ('queued','paused')) THEN RETURN jsonb_build_object('exclusion','inbound_unavailable');END IF;
 SELECT generation INTO STRICT capture_generation FROM inbox_t2_capture_boundary.generation WHERE singleton IS TRUE FOR SHARE;
 INSERT INTO public.inbox_inbound_heads(org_id,conversation_id,revision) VALUES(o,c,1) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT head FROM public.inbox_inbound_heads WHERE org_id=o AND conversation_id=c FOR UPDATE;
 INSERT INTO inbox_t2_message_capture.versions VALUES(o,'known_reply',c,1) ON CONFLICT DO NOTHING;
 SELECT revision INTO STRICT content_revision FROM inbox_t2_message_capture.versions WHERE org_id=o AND namespace='known_reply' AND target_id=c FOR UPDATE;
 INSERT INTO inbox_operation_domain.target_versions VALUES(o,c,1) ON CONFLICT DO NOTHING;
 SELECT revision INTO STRICT target_revision FROM inbox_operation_domain.target_versions WHERE org_id=o AND conversation_id=c FOR UPDATE;
 resolved:=inbox_t2_summary_contract.compute(o,c,clock_timestamp());
 IF resolved->>'exists' IS DISTINCT FROM 'true' OR resolved->>'property_id' IS DISTINCT FROM p.id::text OR resolved->>'contact_id' IS DISTINCT FROM contact.id::text THEN RETURN jsonb_build_object('exclusion','conversation_changed');END IF;
 SELECT * INTO inbound FROM public.messages WHERE org_id=o AND conversation_id=c AND channel='sms' AND direction='inbound' AND status NOT IN ('queued','paused') ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND OR inbound.property_id IS DISTINCT FROM p.id OR inbound.contact_id IS DISTINCT FROM contact.id THEN RETURN jsonb_build_object('exclusion','inbound_mapping_changed');END IF;
 destination:=inbox_reply_preparation.phone(inbound.from_address);
 business:=inbox_reply_preparation.phone(inbound.to_address);
 IF destination IS NULL OR business IS NULL THEN RETURN jsonb_build_object('exclusion','reply_route_unavailable');END IF;
 -- Conversation identity only: does THIS contact (the one tied to this
 -- specific conversation) have the reply destination saved at all? This is
 -- NOT eligibility policy — destination_policy() below is the sole
 -- authority for whether the destination itself is textable, evaluated
 -- org-wide, not per-contact.
 IF NOT EXISTS(SELECT 1 FROM (VALUES(contact.phone_1),(contact.phone_2),(contact.phone_3)) slots(phone) WHERE inbox_reply_preparation.phone(phone)=destination) THEN RETURN jsonb_build_object('exclusion','phone_not_saved');END IF;
 requirements:=jsonb_build_array(
  jsonb_build_object('namespace','property_identity','key',jsonb_build_array(p.id)),jsonb_build_object('namespace','property_policy','key',jsonb_build_array(p.id)),
  jsonb_build_object('namespace','property_outcome','key',jsonb_build_array(p.id)),jsonb_build_object('namespace','property_reply_content','key',jsonb_build_array(p.id)),
  jsonb_build_object('namespace','contact_identity','key',jsonb_build_array(contact.id)),jsonb_build_object('namespace','contact_policy','key',jsonb_build_array(contact.id)),
  jsonb_build_object('namespace','contact_reply_content','key',jsonb_build_array(contact.id)),jsonb_build_object('namespace','contact_channel_consent','key',jsonb_build_array(contact.id,'sms')),
  jsonb_build_object('namespace','route_policy','key',jsonb_build_array('sms',destination)),jsonb_build_object('namespace','conversation_identity','key',jsonb_build_array(c)));
 policy:=inbox_action_api.policy(o,requirements);
 -- Single eligibility authority (E1-E4, round 4). strict=true is the
 -- current fail-closed default; see destination_policy()'s own header for
 -- what each of its 4 org-wide steps plus the 2 strict-only checks cover.
 destination_result:=inbox_reply_preparation.destination_policy(o,destination,contact.id,true);
 IF destination_result->>'exclusion' IS NOT NULL THEN RETURN destination_result;END IF;
 SELECT id INTO sender FROM public.provider_sender_numbers WHERE org_id=o AND provider='sendillo' AND phone_e164=business;
 IF NOT FOUND THEN RETURN jsonb_build_object('exclusion','sender_unavailable');END IF;
 inventory:=inbox_reply_context.snapshot(o,'sender_inventory',sender);
 IF inventory IS NULL OR inventory->'value'->>'status'<>'active' OR inventory->'value'->>'provider' IS DISTINCT FROM 'sendillo' OR inventory->'value'->>'phone_e164' IS DISTINCT FROM business THEN RETURN jsonb_build_object('exclusion','sender_unavailable');END IF;
 organization:=inbox_reply_context.snapshot(o,'organization_name',o);
 market:=inbox_reply_context.snapshot(o,'property_market',p.id);
 IF organization IS NULL OR market IS NULL THEN RETURN jsonb_build_object('exclusion','context_unavailable');END IF;
 IF (resolved->>'next_window_expiry')::timestamptz<=clock_timestamp() THEN RETURN jsonb_build_object('exclusion','conversation_window_expired');END IF;
 RETURN jsonb_build_object('exclusion',NULL,'conversation_id',c,'property_id',p.id,'contact_id',contact.id,'from',business,'to',destination,'state',p.state,
  'inbound_id',inbound.id,'inbound_created_at',inbound.created_at,'valid_until',resolved->'next_window_expiry',
  'variables',jsonb_build_object('first_name',contact.first_name,'last_name',contact.last_name,'property_address',p.address,'city',p.city,'state',p.state,'property_zip',p.zip,'market',market->'value'->'market','company_name',organization->'value'->'name'),
  'dependencies',jsonb_build_object('head',head.revision::text,'generation',capture_generation,'known_reply',content_revision::text,'target',target_revision::text,'policy',policy,'sender',inventory,'organization',organization,'market',market));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_preparation FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
