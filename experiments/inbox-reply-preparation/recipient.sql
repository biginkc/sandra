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
CREATE FUNCTION inbox_reply_preparation.recipient(o uuid,c uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE initial jsonb;resolved jsonb;p public.properties;contact public.contacts;inbound public.messages;head public.inbox_inbound_heads;
 target_revision bigint;content_revision bigint;capture_generation uuid;destination text;business text;line_type text;consent text;sender uuid;inventory jsonb;organization jsonb;market jsonb;requirements jsonb;policy jsonb;
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
 SELECT t INTO line_type FROM (VALUES(1,contact.phone_1,contact.phone_1_type),(2,contact.phone_2,contact.phone_2_type),(3,contact.phone_3,contact.phone_3_type)) slots(ordinal,phone,t) WHERE inbox_reply_preparation.phone(phone)=destination ORDER BY ordinal LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('exclusion','phone_not_saved');END IF;
 -- Fail closed: eligible only when the saved slot is affirmatively mobile.
 -- Mirrors the bulk-queue precedent (audience-assessment.ts/bulk-queue.ts) —
 -- landline is a hard block, 'unknown' (never classified) needs an explicit
 -- operator opt-in there. Bulk-reply v1 has no such toggle, so 'unknown'
 -- fails closed the same as landline; it never falls through as eligible.
 IF line_type='landline' THEN RETURN jsonb_build_object('exclusion','landline');END IF;
 IF line_type IS DISTINCT FROM 'mobile' THEN RETURN jsonb_build_object('exclusion','unclassified_phone');END IF;
 requirements:=jsonb_build_array(
  jsonb_build_object('namespace','property_identity','key',jsonb_build_array(p.id)),jsonb_build_object('namespace','property_policy','key',jsonb_build_array(p.id)),
  jsonb_build_object('namespace','property_outcome','key',jsonb_build_array(p.id)),jsonb_build_object('namespace','property_reply_content','key',jsonb_build_array(p.id)),
  jsonb_build_object('namespace','contact_identity','key',jsonb_build_array(contact.id)),jsonb_build_object('namespace','contact_policy','key',jsonb_build_array(contact.id)),
  jsonb_build_object('namespace','contact_reply_content','key',jsonb_build_array(contact.id)),jsonb_build_object('namespace','contact_channel_consent','key',jsonb_build_array(contact.id,'sms')),
  jsonb_build_object('namespace','route_policy','key',jsonb_build_array('sms',destination)),jsonb_build_object('namespace','conversation_identity','key',jsonb_build_array(c)));
 policy:=inbox_action_api.policy(o,requirements);
 -- Deliberately stricter than the existing single-send/bulk-queue paths
 -- (src/lib/messaging/send.ts, suppression.ts's evaluateAutomatedSuppression
 -- used by bulk-queue.ts), which only hard-block explicit opt-out and let
 -- 'no_consent' fall through as eligible. Automated bulk-reply composition
 -- has no per-message human review at send time, so this boundary requires
 -- an affirmative opt-in event on file; 'no_consent' fails closed instead
 -- of defaulting to eligible. Ambiguous same-time opt-in/opt-out ties still
 -- prefer opt-out.
 SELECT event_type INTO consent FROM public.consent_events WHERE org_id=o AND contact_id=contact.id AND channel='sms' AND event_type IN ('opt_in_marketing_written','opt_in_confirmed','opt_in_informational','opt_out','provider_auto_opt_out') ORDER BY occurred_at DESC,(event_type IN ('opt_out','provider_auto_opt_out')) DESC,id DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM public.sms_phone_suppressions WHERE org_id=o AND channel='sms' AND phone_e164=destination) THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 IF consent IN ('opt_out','provider_auto_opt_out') THEN RETURN jsonb_build_object('exclusion','sms_suppressed');END IF;
 IF consent IS DISTINCT FROM 'opt_in_marketing_written' AND consent IS DISTINCT FROM 'opt_in_confirmed' AND consent IS DISTINCT FROM 'opt_in_informational' THEN RETURN jsonb_build_object('exclusion','no_consent');END IF;
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
