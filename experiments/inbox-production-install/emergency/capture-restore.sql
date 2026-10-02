-- GENERATED FILE. Source: 20261002130000_inbox_control_foundation.sql, 20261002130100_inbox_read_companion.sql, 20261002130200_inbox_backend_operation_reply.sql at 4ee23fcb25d05bad77e2cf74189c24bb1f9ea4c2.
-- Tooling-only emergency restore packet; never place this file in supabase/migrations.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';

DO $$
DECLARE approved_count integer; no_op_count integer; total_count integer; attached_count integer;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_ROLE_REQUIRED';
  END IF;
  IF NOT has_table_privilege('postgres', 'auth.sessions', 'SELECT')
     OR NOT has_table_privilege('postgres', 'auth.sessions', 'TRIGGER') THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_AUTH_SESSIONS_PRIVILEGE_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='inbox_bridge' AND p.proname='capture_access'
        AND pg_get_userbyid(p.proowner)='postgres') <> 1 THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_AUTH_FUNCTION_OWNER_DRIFT';
  END IF;
  WITH expected(name, approved_md5, no_op_md5) AS (VALUES
      ('inbox_backfill.capture_collision()', '58b44491162a135f0d2e46d73bb6b79c', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_bridge.capture_access()', '8583671b0e8b10f83edff9c7ba961eb2', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_message_capture.capture()', 'c65d454fcef9e87512af5e97e17e599d', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_sms_scope()', '3344af15a68206052158425e4283179e', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_target()', '380bbd13de051c04e6acd3ee90c269db', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_parent()', '94f86879c7985e63cd0ca7b3e4572b56', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_review()', '16c2de2584351a782e356f01db2bbf41', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_ai_disposition_reviews()', '065afb4f2ecf83ca93211c1a89d3f1b0', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_consent_events()', '1b9f5ebd06f62a86e0c2101ef9acbeb9', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_contacts()', '4d99f53f06cb667721c65cb50ea40b10', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_memberships()', '8d83deb6ed81fb0a3023898f225c6d38', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_message_threads()', '07da9ee2e294444a5f86ce4b44bbe3a6', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_properties()', 'bfba50ac7077a0b4c7b56855aca9c6e8', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_sms_phone_suppressions()', 'b16569b969660fa433e8b90550c483f0', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_organization()', '752e3e58dfec918fe6cd5496faef5ac3', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_property()', 'ebe4c89c956aaf51468f09fe067b82ef', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_sender()', '5c7330d97d21c39e0cfe49aa3535f2a9', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.consent_capture()', '80f52a0718eedb03f177516b20ab3c4d', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.suppression_capture()', 'c70a2d52b000a4dad46ccfa137e44680', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.thread_capture()', '0e284768a7315bbbb1adb8730bd42cc2', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('public.inbox_capture_inbound_head()', '06d8dd4070ff5b45032f44033dea0053', '8ab64bae8d78de0c4333d9b2820a4168')
  )
  SELECT count(*) FILTER (WHERE p.oid IS NULL),
         count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.approved_md5),
         count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.no_op_md5),
         count(*)
    INTO total_count, approved_count, no_op_count, attached_count
    FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.name);
  IF total_count <> 0 THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_FUNCTION_MISSING'; END IF;
  IF approved_count <> 21 AND no_op_count <> 21 THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_FUNCTION_BODY_DRIFT';
  END IF;
  WITH expected(identity, function_name, tgtype) AS (VALUES
      ('auth.sessions.zzzzzzz_inbox_access', 'inbox_bridge.capture_access()', 29),
      ('public.ai_disposition_reviews.zzzzz_inbox_parent_review', 'inbox_parent.capture_review()', 29),
      ('public.ai_disposition_reviews.zzzzzz_inbox_policy', 'inbox_policy.capture_ai_disposition_reviews()', 29),
      ('public.ai_disposition_reviews.zzzzzzzz_inbox_operation_target', 'inbox_operation_domain.capture_target()', 29),
      ('public.consent_events.zzzzz_inbox_safety_consent', 'inbox_safety.consent_capture()', 29),
      ('public.consent_events.zzzzzz_inbox_policy', 'inbox_policy.capture_consent_events()', 29),
      ('public.contacts.zzzzz_inbox_parent', 'inbox_parent.capture_parent()', 29),
      ('public.contacts.zzzzzz_inbox_policy', 'inbox_policy.capture_contacts()', 29),
      ('public.memberships.zzzzzz_inbox_policy', 'inbox_policy.capture_memberships()', 29),
      ('public.memberships.zzzzzzz_inbox_access', 'inbox_bridge.capture_access()', 29),
      ('public.message_threads.zzzzz_inbox_backfill_collision', 'inbox_backfill.capture_collision()', 29),
      ('public.message_threads.zzzzz_inbox_safety_thread', 'inbox_safety.thread_capture()', 29),
      ('public.message_threads.zzzzzz_inbox_policy', 'inbox_policy.capture_message_threads()', 29),
      ('public.messages.inbox_capture_inbound_head', 'public.inbox_capture_inbound_head()', 21),
      ('public.messages.zzzzz_inbox_message_direct', 'inbox_message_capture.capture()', 29),
      ('public.messages.zzzzzzzz_inbox_operation_target', 'inbox_operation_domain.capture_target()', 29),
      ('public.organizations.zzzzzzz_inbox_reply_context', 'inbox_reply_context.capture_organization()', 29),
      ('public.properties.zzzzz_inbox_parent', 'inbox_parent.capture_parent()', 29),
      ('public.properties.zzzzzz_inbox_policy', 'inbox_policy.capture_properties()', 29),
      ('public.properties.zzzzzzz_inbox_reply_context', 'inbox_reply_context.capture_property()', 29),
      ('public.properties.zzzzzzzzz_inbox_sms_scope', 'inbox_operation_domain.capture_sms_scope()', 29),
      ('public.provider_sender_numbers.zzzzzzz_inbox_reply_context', 'inbox_reply_context.capture_sender()', 29),
      ('public.sequence_enrollments.zzzzzzzzz_inbox_sms_scope', 'inbox_operation_domain.capture_sms_scope()', 29),
      ('public.sms_phone_suppressions.zzzzz_inbox_safety_suppression', 'inbox_safety.suppression_capture()', 29),
      ('public.sms_phone_suppressions.zzzzzz_inbox_policy', 'inbox_policy.capture_sms_phone_suppressions()', 29)
  )
  SELECT count(*) INTO attached_count
    FROM expected e
    JOIN pg_trigger t ON NOT t.tgisinternal AND t.tgname = split_part(e.identity, '.', 3)
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace cn ON cn.oid=c.relnamespace
      AND cn.nspname||'.'||c.relname = split_part(e.identity, '.', 1)||'.'||split_part(e.identity, '.', 2)
    WHERE t.tgfoid=to_regprocedure(e.function_name) AND t.tgtype=e.tgtype AND t.tgenabled='O';
  IF attached_count <> 25 THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_TRIGGER_CATALOG_DRIFT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION inbox_backfill.capture_collision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.conversation_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id),jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_backfill.collisions(org_id,conversation_id) VALUES(k.o,k.c) ON CONFLICT(org_id,conversation_id) DO UPDATE SET generation=inbox_backfill.collisions.generation+1;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_bridge.capture_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed boolean:=true;users uuid[];u uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='sessions' THEN changed:=(OLD.id,OLD.user_id,OLD.not_after) IS DISTINCT FROM (NEW.id,NEW.user_id,NEW.not_after);
  ELSE changed:=(OLD.id,OLD.org_id,OLD.user_id,OLD.role,OLD.access_status,OLD.access_expires_at,OLD.deletion_prepared_at,OLD.deletion_operation_id,OLD.hugo_config,OLD.acquisitions_enabled) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.user_id,NEW.role,NEW.access_status,NEW.access_expires_at,NEW.deletion_prepared_at,NEW.deletion_operation_id,NEW.hugo_config,NEW.acquisitions_enabled);END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 users:=CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.user_id] WHEN 'DELETE' THEN ARRAY[OLD.user_id] ELSE ARRAY[OLD.user_id,NEW.user_id] END;
 FOR u IN SELECT DISTINCT value FROM unnest(users) value ORDER BY 1 LOOP
  INSERT INTO inbox_bridge.access_epochs VALUES(u,1) ON CONFLICT(user_id) DO UPDATE SET revision=inbox_bridge.access_epochs.revision+1;
 END LOOP;RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_message_capture.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE known_changed boolean:=true; unknown_changed boolean:=true; content_changed boolean:=true;
 status_eligibility_changed boolean:=false; dismissed_changed boolean:=true; edge_changed boolean:=true;
 sides jsonb; side jsonb; targets jsonb:='[]'; versions jsonb:='[]'; k record;
 o uuid; c uuid; mid uuid; group_id uuid; phone text;
BEGIN
 IF TG_OP='UPDATE' THEN
  known_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,NEW.direction,NEW.status,NEW.created_at,NEW.body,NEW.from_address,NEW.to_address,NEW.read_at)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,OLD.direction,OLD.status,OLD.created_at,OLD.body,OLD.from_address,OLD.to_address,OLD.read_at);
  unknown_changed:=(NEW.id,NEW.org_id,NEW.channel,NEW.direction,NEW.contact_id,NEW.from_address,NEW.to_address,NEW.body,NEW.created_at,NEW.dismissed_at)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.channel,OLD.direction,OLD.contact_id,OLD.from_address,OLD.to_address,OLD.body,OLD.created_at,OLD.dismissed_at);
  content_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,NEW.direction,NEW.body,NEW.from_address,NEW.to_address,NEW.metadata)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,OLD.direction,OLD.body,OLD.from_address,OLD.to_address,OLD.metadata);
  -- Conservative private candidate assumption: queue/paused entry/exit changes known eligibility.
  status_eligibility_changed:=(NEW.status IN ('queued','paused')) IS DISTINCT FROM (OLD.status IN ('queued','paused'));
  dismissed_changed:=NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at;
  edge_changed:=(NEW.id,NEW.org_id,NEW.conversation_id,NEW.channel,NEW.direction,NEW.from_address,NEW.to_address)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.channel,OLD.direction,OLD.from_address,OLD.to_address);
  IF NOT(known_changed OR unknown_changed OR content_changed OR status_eligibility_changed OR dismissed_changed OR edge_changed) THEN RETURN NULL; END IF;
 END IF;
 sides:=CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(jsonb_build_object('id',NEW.id,'org_id',NEW.org_id,'conversation_id',NEW.conversation_id,'contact_id',NEW.contact_id,'channel',NEW.channel,'direction',NEW.direction,'from_address',NEW.from_address)) WHEN TG_OP='DELETE' THEN jsonb_build_array(jsonb_build_object('id',OLD.id,'org_id',OLD.org_id,'conversation_id',OLD.conversation_id,'contact_id',OLD.contact_id,'channel',OLD.channel,'direction',OLD.direction,'from_address',OLD.from_address)) ELSE jsonb_build_array(jsonb_build_object('id',OLD.id,'org_id',OLD.org_id,'conversation_id',OLD.conversation_id,'contact_id',OLD.contact_id,'channel',OLD.channel,'direction',OLD.direction,'from_address',OLD.from_address),jsonb_build_object('id',NEW.id,'org_id',NEW.org_id,'conversation_id',NEW.conversation_id,'contact_id',NEW.contact_id,'channel',NEW.channel,'direction',NEW.direction,'from_address',NEW.from_address)) END;
 -- Acquire new raw identity buckets in stable org/hash/raw order before dirty/version locks.
 FOR side IN SELECT value FROM jsonb_array_elements(sides)
  ORDER BY value->>'org_id',md5(value->>'from_address'),(value->>'from_address') COLLATE "C"
 LOOP
  o:=(side->>'org_id')::uuid; c:=(side->>'conversation_id')::uuid; mid:=(side->>'id')::uuid;
  IF content_changed OR status_eligibility_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','message_content','id',mid)); END IF;
  IF side->>'channel'='sms' AND c IS NOT NULL THEN
   IF known_changed THEN targets:=targets||jsonb_build_array(jsonb_build_object('org',o,'kind','known_conversation','id',c)); END IF;
   IF content_changed OR status_eligibility_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','known_reply','id',c)); END IF;
  END IF;
  IF side->>'channel'='sms' AND side->>'direction'='inbound' AND side->>'contact_id' IS NULL
   AND side->>'from_address' IS NOT NULL AND side->>'from_address'<>'' THEN
   group_id:=inbox_message_capture.sender_id(o,side->>'from_address');
   IF unknown_changed THEN targets:=targets||jsonb_build_array(jsonb_build_object('org',o,'kind','unknown_sender','id',group_id)); END IF;
   IF content_changed OR dismissed_changed THEN versions:=versions||jsonb_build_array(jsonb_build_object('org',o,'namespace','unknown_action','id',group_id)); END IF;
  END IF;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid AS org,value->>'kind' AS kind,(value->>'id')::uuid AS id FROM jsonb_array_elements(targets) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_message_capture.dirty VALUES(k.org,k.kind,k.id,1)
  ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid AS org,value->>'namespace' AS namespace,(value->>'id')::uuid AS id FROM jsonb_array_elements(versions) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_message_capture.versions VALUES(k.org,k.namespace,k.id,1)
  ON CONFLICT(org_id,namespace,target_id) DO UPDATE SET revision=inbox_message_capture.versions.revision+1;
 END LOOP;
 IF edge_changed THEN
  -- At most old/new source edges, never a fanout scan.
  IF TG_OP<>'INSERT' THEN DELETE FROM inbox_message_capture.route_edges WHERE org_id=OLD.org_id AND message_id=OLD.id; END IF;
  IF TG_OP<>'DELETE' AND NEW.channel='sms' AND NEW.conversation_id IS NOT NULL THEN
   phone:=regexp_replace(coalesce(CASE WHEN NEW.direction='inbound' THEN NEW.from_address ELSE NEW.to_address END,''),'[^0-9]','','g');
   phone:=CASE WHEN length(phone)=10 THEN '+1'||phone WHEN length(phone)=11 AND left(phone,1)='1' THEN '+'||phone ELSE NULL END;
   IF phone IS NOT NULL THEN INSERT INTO inbox_message_capture.route_edges VALUES(NEW.org_id,NEW.id,NEW.conversation_id,phone)
    ON CONFLICT(org_id,message_id) DO UPDATE SET conversation_id=excluded.conversation_id,phone_e164=excluded.phone_e164; END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_operation_domain.capture_sms_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb:='[]';side jsonb;candidate record;
BEGIN
 IF TG_TABLE_NAME='properties' THEN
  IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.homeowner_contact_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.homeowner_contact_id) THEN RETURN NULL;END IF;
  IF TG_OP<>'INSERT' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'contact',OLD.homeowner_contact_id));END IF;
  IF TG_OP<>'DELETE' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'contact',NEW.homeowner_contact_id));END IF;
 ELSE
  -- The canonical enrollment guard locks both old/new property rows before
  -- mutation. Its exact installed body and coverage must be verified before
  -- enabling this capture; no unprotected property lookup is sufficient.
  FOR candidate IN SELECT DISTINCT k.org,k.property FROM (VALUES
   (CASE WHEN TG_OP<>'INSERT' THEN OLD.org_id END,CASE WHEN TG_OP<>'INSERT' THEN OLD.property_id END),
   (CASE WHEN TG_OP<>'DELETE' THEN NEW.org_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.property_id END)
  ) k(org,property) WHERE k.org IS NOT NULL AND k.property IS NOT NULL ORDER BY 1,2 LOOP
   SELECT jsonb_build_object('org',p.org_id,'contact',p.homeowner_contact_id) INTO side
    FROM public.properties p WHERE p.id=candidate.property AND p.org_id=candidate.org;
   IF FOUND THEN sides:=sides||jsonb_build_array(side);END IF;
  END LOOP;
 END IF;
 FOR side IN SELECT DISTINCT value FROM jsonb_array_elements(sides)
  WHERE value->>'org' IS NOT NULL AND value->>'contact' IS NOT NULL ORDER BY value LOOP
  INSERT INTO inbox_operation_domain.sms_scopes VALUES((side->>'org')::uuid,(side->>'contact')::uuid,1)
   ON CONFLICT(org_id,contact_id) DO UPDATE SET revision=inbox_operation_domain.sms_scopes.revision+1;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_operation_domain.capture_target() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb:='[]';side jsonb;changed boolean:=true;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='messages' THEN changed:=(OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,(OLD.status IN ('queued','paused')),OLD.created_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,(NEW.status IN ('queued','paused')),NEW.created_at);
  ELSE changed:=(OLD.id,OLD.org_id,OLD.conversation_id,OLD.property_id,OLD.status,OLD.created_at,OLD.source_inbound_message_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.property_id,NEW.status,NEW.created_at,NEW.source_inbound_message_id);END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'conversation',OLD.conversation_id));END IF;
 IF TG_OP<>'DELETE' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'conversation',NEW.conversation_id));END IF;
 FOR side IN SELECT DISTINCT value FROM jsonb_array_elements(sides) WHERE value->>'conversation' IS NOT NULL AND value->>'org' IS NOT NULL ORDER BY value LOOP
  INSERT INTO inbox_operation_domain.target_versions VALUES((side->>'org')::uuid,(side->>'conversation')::uuid,1) ON CONFLICT(org_id,conversation_id) DO UPDATE SET revision=inbox_operation_domain.target_versions.revision+1;
 END LOOP;RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_parent.capture_parent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed boolean:=true;sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='properties' THEN
   changed:=(OLD.id,OLD.org_id,OLD.address,OLD.city,OLD.state,OLD.status,OLD.outreach_dispo,OLD.is_dnc_locked,OLD.assigned_user_id,OLD.needs_human_attention)
    IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.address,NEW.city,NEW.state,NEW.status,NEW.outreach_dispo,NEW.is_dnc_locked,NEW.assigned_user_id,NEW.needs_human_attention);
  ELSE
   changed:=(OLD.id,OLD.org_id,OLD.entity_name,OLD.first_name,OLD.last_name,OLD.do_not_contact,OLD.sms_opted_out)
    IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.entity_name,NEW.first_name,NEW.last_name,NEW.do_not_contact,NEW.sms_opted_out);
  END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('org',NEW.org_id,'id',NEW.id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.id)) ELSE jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.id),jsonb_build_object('org',NEW.org_id,'id',NEW.id)) END;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid o,(value->>'id')::uuid id FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_parent.work(org_id,kind,entity_id,generation) VALUES(k.o,TG_ARGV[0],k.id,1)
  ON CONFLICT(org_id,kind,entity_id) DO UPDATE SET generation=inbox_parent.work.generation+1;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_parent.capture_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.conversation_id,OLD.property_id,OLD.status,OLD.disposition,OLD.source_inbound_message_id,OLD.created_at)
 IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.property_id,NEW.status,NEW.disposition,NEW.source_inbound_message_id,NEW.created_at) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('org',NEW.org_id,'id',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('org',OLD.org_id,'id',OLD.conversation_id),jsonb_build_object('org',NEW.org_id,'id',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid o,(value->>'id')::uuid id FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_message_capture.dirty VALUES(k.o,'known_conversation',k.id,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_ai_disposition_reviews() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.property_id,OLD.conversation_id,OLD.status,OLD.disposition,OLD.source_inbound_message_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.property_id,NEW.conversation_id,NEW.status,NEW.disposition,NEW.source_inbound_message_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','review_action','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','review_action','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.property_id,OLD.conversation_id,OLD.status,OLD.disposition,OLD.source_inbound_message_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.property_id,NEW.conversation_id,NEW.status,NEW.disposition,NEW.source_inbound_message_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_reviews','key',jsonb_build_array(OLD.property_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_reviews','key',jsonb_build_array(NEW.property_id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_consent_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.contact_id,OLD.channel,OLD.event_type,OLD.occurred_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.contact_id,NEW.channel,NEW.event_type,NEW.occurred_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_channel_consent','key',jsonb_build_array(OLD.contact_id,OLD.channel)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_channel_consent','key',jsonb_build_array(NEW.contact_id,NEW.channel)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_contacts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id) IS DISTINCT FROM (NEW.id,NEW.org_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_identity','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_identity','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.do_not_contact,OLD.sms_opted_out,OLD.phone_1,OLD.phone_2,OLD.phone_3,OLD.phone_1_type,OLD.phone_2_type,OLD.phone_3_type) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.do_not_contact,NEW.sms_opted_out,NEW.phone_1,NEW.phone_2,NEW.phone_3,NEW.phone_1_type,NEW.phone_2_type,NEW.phone_3_type);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_policy','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_policy','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.first_name,OLD.last_name,OLD.entity_name) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.first_name,NEW.last_name,NEW.entity_name);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_reply_content','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_reply_content','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_memberships() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.user_id,OLD.role,OLD.access_status,OLD.access_expires_at,OLD.deletion_prepared_at,OLD.deletion_operation_id,OLD.hugo_config,OLD.acquisitions_enabled) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.user_id,NEW.role,NEW.access_status,NEW.access_expires_at,NEW.deletion_prepared_at,NEW.deletion_operation_id,NEW.hugo_config,NEW.acquisitions_enabled);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','membership_access','key',jsonb_build_array(OLD.user_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','membership_access','key',jsonb_build_array(NEW.user_id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_message_threads() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','conversation_identity','key',jsonb_build_array(OLD.conversation_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','conversation_identity','key',jsonb_build_array(NEW.conversation_id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_properties() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.deleted_at,OLD.homeowner_contact_id,OLD.agent_contact_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.deleted_at,NEW.homeowner_contact_id,NEW.agent_contact_id);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_identity','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_identity','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.status,OLD.is_dnc_locked,OLD.is_training) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.status,NEW.is_dnc_locked,NEW.is_training);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_policy','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_policy','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.outreach_dispo) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.outreach_dispo);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_outcome','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_outcome','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.assigned_user_id,OLD.follow_up_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.assigned_user_id,NEW.follow_up_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_assignment','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_assignment','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.address,OLD.city,OLD.state,OLD.zip) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.address,NEW.city,NEW.state,NEW.zip);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','property_reply_content','key',jsonb_build_array(OLD.id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','property_reply_content','key',jsonb_build_array(NEW.id)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_sms_phone_suppressions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.channel,OLD.phone_e164,OLD.suppressed_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.channel,NEW.phone_e164,NEW.suppressed_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','route_policy','key',jsonb_build_array(OLD.channel,OLD.phone_e164)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','route_policy','key',jsonb_build_array(NEW.channel,NEW.phone_e164)));END IF;
 END IF;
 PERFORM inbox_policy.bump(events);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_reply_context.capture_organization() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_id uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.name) IS NOT DISTINCT FROM (NEW.id,NEW.name) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('organization_name',old_id,old_id,new_id,new_id);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_reply_context.capture_property() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_org uuid;old_id uuid;new_org uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.market) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.market) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_org:=OLD.org_id;old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_org:=NEW.org_id;new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('property_market',old_org,old_id,new_org,new_id);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_reply_context.capture_sender() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_org uuid;old_id uuid;new_org uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.provider,OLD.phone_e164,OLD.status,OLD.messaging_status,OLD.provider_number_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.provider,NEW.phone_e164,NEW.status,NEW.messaging_status,NEW.provider_number_id) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_org:=OLD.org_id;old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_org:=NEW.org_id;new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('sender_inventory',old_org,old_id,new_org,new_id);RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_safety.consent_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.contact_id,OLD.channel,OLD.event_type,OLD.occurred_at) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.contact_id,NEW.channel,NEW.event_type,NEW.occurred_at) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.contact_id,'channel',NEW.channel,'event',NEW.event_type)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.contact_id,'channel',OLD.channel,'event',OLD.event_type)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.contact_id,'channel',OLD.channel,'event',OLD.event_type),jsonb_build_object('o',NEW.org_id,'c',NEW.contact_id,'channel',NEW.channel,'event',NEW.event_type)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) WHERE value->>'channel'='sms' AND value->>'event' IN ('opt_in_marketing_written','opt_in_informational','opt_in_confirmed','opt_out','provider_auto_opt_out') ORDER BY 1,2 LOOP
  INSERT INTO inbox_parent.work(org_id,kind,entity_id,generation) VALUES(k.o,'contact',k.c,1) ON CONFLICT(org_id,kind,entity_id) DO UPDATE SET generation=inbox_parent.work.generation+1;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_safety.suppression_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.org_id,OLD.channel,OLD.phone_e164) IS NOT DISTINCT FROM (NEW.org_id,NEW.channel,NEW.phone_e164) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'p',NEW.phone_e164,'channel',NEW.channel)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'p',OLD.phone_e164,'channel',OLD.channel)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'p',OLD.phone_e164,'channel',OLD.channel),jsonb_build_object('o',NEW.org_id,'p',NEW.phone_e164,'channel',NEW.channel)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,value->>'p' p FROM jsonb_array_elements(sides) WHERE value->>'channel'='sms' ORDER BY 1,2 LOOP
  INSERT INTO inbox_safety.routes(org_id,phone_e164,generation) VALUES(k.o,k.p,1) ON CONFLICT(org_id,phone_e164) DO UPDATE SET generation=inbox_safety.routes.generation+1;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION inbox_safety.thread_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb;k record;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.org_id,OLD.conversation_id,OLD.ai_responder_status) IS NOT DISTINCT FROM (NEW.org_id,NEW.conversation_id,NEW.ai_responder_status) THEN RETURN NULL;END IF;
 sides:=CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) WHEN 'DELETE' THEN jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id)) ELSE jsonb_build_array(jsonb_build_object('o',OLD.org_id,'c',OLD.conversation_id),jsonb_build_object('o',NEW.org_id,'c',NEW.conversation_id)) END;
 FOR k IN SELECT DISTINCT (value->>'o')::uuid o,(value->>'c')::uuid c FROM jsonb_array_elements(sides) ORDER BY 1,2 LOOP
  INSERT INTO inbox_message_capture.dirty VALUES(k.o,'known_conversation',k.c,1) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.inbox_capture_inbound_head()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE next_revision bigint;
BEGIN
  IF NEW.channel IS DISTINCT FROM 'sms' OR NEW.direction IS DISTINCT FROM 'inbound'
     OR NEW.org_id IS NULL OR NEW.conversation_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.conversation_id, NEW.channel, NEW.direction)
       IS NOT DISTINCT FROM (OLD.org_id, OLD.conversation_id, OLD.channel, OLD.direction) THEN
      RETURN NULL;
    END IF;
  END IF;
  INSERT INTO public.inbox_inbound_heads(org_id, conversation_id, revision)
    VALUES (NEW.org_id, NEW.conversation_id, 1)
  ON CONFLICT (org_id, conversation_id) DO UPDATE
    SET revision = public.inbox_inbound_heads.revision + 1
  RETURNING revision INTO next_revision;
  -- The original source write already holds its tuple lock. The head lock and
  -- this stamp remain in that same transaction through commit or rollback.
  UPDATE public.messages SET inbox_inbound_revision = next_revision
    WHERE id = NEW.id AND org_id = NEW.org_id AND conversation_id = NEW.conversation_id;
  RETURN NULL;
END $$;

DO $$
DECLARE bad text;
BEGIN
  WITH expected(name, expected_md5) AS (VALUES
      ('inbox_backfill.capture_collision()', '58b44491162a135f0d2e46d73bb6b79c'),
      ('inbox_bridge.capture_access()', '8583671b0e8b10f83edff9c7ba961eb2'),
      ('inbox_message_capture.capture()', 'c65d454fcef9e87512af5e97e17e599d'),
      ('inbox_operation_domain.capture_sms_scope()', '3344af15a68206052158425e4283179e'),
      ('inbox_operation_domain.capture_target()', '380bbd13de051c04e6acd3ee90c269db'),
      ('inbox_parent.capture_parent()', '94f86879c7985e63cd0ca7b3e4572b56'),
      ('inbox_parent.capture_review()', '16c2de2584351a782e356f01db2bbf41'),
      ('inbox_policy.capture_ai_disposition_reviews()', '065afb4f2ecf83ca93211c1a89d3f1b0'),
      ('inbox_policy.capture_consent_events()', '1b9f5ebd06f62a86e0c2101ef9acbeb9'),
      ('inbox_policy.capture_contacts()', '4d99f53f06cb667721c65cb50ea40b10'),
      ('inbox_policy.capture_memberships()', '8d83deb6ed81fb0a3023898f225c6d38'),
      ('inbox_policy.capture_message_threads()', '07da9ee2e294444a5f86ce4b44bbe3a6'),
      ('inbox_policy.capture_properties()', 'bfba50ac7077a0b4c7b56855aca9c6e8'),
      ('inbox_policy.capture_sms_phone_suppressions()', 'b16569b969660fa433e8b90550c483f0'),
      ('inbox_reply_context.capture_organization()', '752e3e58dfec918fe6cd5496faef5ac3'),
      ('inbox_reply_context.capture_property()', 'ebe4c89c956aaf51468f09fe067b82ef'),
      ('inbox_reply_context.capture_sender()', '5c7330d97d21c39e0cfe49aa3535f2a9'),
      ('inbox_safety.consent_capture()', '80f52a0718eedb03f177516b20ab3c4d'),
      ('inbox_safety.suppression_capture()', 'c70a2d52b000a4dad46ccfa137e44680'),
      ('inbox_safety.thread_capture()', '0e284768a7315bbbb1adb8730bd42cc2'),
      ('public.inbox_capture_inbound_head()', '06d8dd4070ff5b45032f44033dea0053')
  )
  SELECT e.name INTO bad FROM expected e JOIN pg_proc p ON p.oid=to_regprocedure(e.name) WHERE md5(p.prosrc)<>e.expected_md5 LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'INBOX_CAPTURE_RESTORE_POSTCONDITION_FAILED: %', bad; END IF;
END $$;
DO $$ BEGIN
  IF to_regclass('inbox_emergency.capture_off_receipts') IS NOT NULL THEN
    INSERT INTO inbox_emergency.capture_off_receipts(action, approved_migration_commit, trigger_count, function_bodies_md5, trigger_inventory)
    VALUES ('capture_restore', '4ee23fcb25d05bad77e2cf74189c24bb1f9ea4c2', 25, '{"inbox_backfill.capture_collision":"58b44491162a135f0d2e46d73bb6b79c","inbox_bridge.capture_access":"8583671b0e8b10f83edff9c7ba961eb2","inbox_message_capture.capture":"c65d454fcef9e87512af5e97e17e599d","inbox_operation_domain.capture_sms_scope":"3344af15a68206052158425e4283179e","inbox_operation_domain.capture_target":"380bbd13de051c04e6acd3ee90c269db","inbox_parent.capture_parent":"94f86879c7985e63cd0ca7b3e4572b56","inbox_parent.capture_review":"16c2de2584351a782e356f01db2bbf41","inbox_policy.capture_ai_disposition_reviews":"065afb4f2ecf83ca93211c1a89d3f1b0","inbox_policy.capture_consent_events":"1b9f5ebd06f62a86e0c2101ef9acbeb9","inbox_policy.capture_contacts":"4d99f53f06cb667721c65cb50ea40b10","inbox_policy.capture_memberships":"8d83deb6ed81fb0a3023898f225c6d38","inbox_policy.capture_message_threads":"07da9ee2e294444a5f86ce4b44bbe3a6","inbox_policy.capture_properties":"bfba50ac7077a0b4c7b56855aca9c6e8","inbox_policy.capture_sms_phone_suppressions":"b16569b969660fa433e8b90550c483f0","inbox_reply_context.capture_organization":"752e3e58dfec918fe6cd5496faef5ac3","inbox_reply_context.capture_property":"ebe4c89c956aaf51468f09fe067b82ef","inbox_reply_context.capture_sender":"5c7330d97d21c39e0cfe49aa3535f2a9","inbox_safety.consent_capture":"80f52a0718eedb03f177516b20ab3c4d","inbox_safety.suppression_capture":"c70a2d52b000a4dad46ccfa137e44680","inbox_safety.thread_capture":"0e284768a7315bbbb1adb8730bd42cc2","public.inbox_capture_inbound_head":"06d8dd4070ff5b45032f44033dea0053"}'::jsonb, '[{"identity":"auth.sessions.zzzzzzz_inbox_access","function":"inbox_bridge.capture_access"},{"identity":"public.ai_disposition_reviews.zzzzz_inbox_parent_review","function":"inbox_parent.capture_review"},{"identity":"public.ai_disposition_reviews.zzzzzz_inbox_policy","function":"inbox_policy.capture_ai_disposition_reviews"},{"identity":"public.ai_disposition_reviews.zzzzzzzz_inbox_operation_target","function":"inbox_operation_domain.capture_target"},{"identity":"public.consent_events.zzzzz_inbox_safety_consent","function":"inbox_safety.consent_capture"},{"identity":"public.consent_events.zzzzzz_inbox_policy","function":"inbox_policy.capture_consent_events"},{"identity":"public.contacts.zzzzz_inbox_parent","function":"inbox_parent.capture_parent"},{"identity":"public.contacts.zzzzzz_inbox_policy","function":"inbox_policy.capture_contacts"},{"identity":"public.memberships.zzzzzz_inbox_policy","function":"inbox_policy.capture_memberships"},{"identity":"public.memberships.zzzzzzz_inbox_access","function":"inbox_bridge.capture_access"},{"identity":"public.message_threads.zzzzz_inbox_backfill_collision","function":"inbox_backfill.capture_collision"},{"identity":"public.message_threads.zzzzz_inbox_safety_thread","function":"inbox_safety.thread_capture"},{"identity":"public.message_threads.zzzzzz_inbox_policy","function":"inbox_policy.capture_message_threads"},{"identity":"public.messages.inbox_capture_inbound_head","function":"public.inbox_capture_inbound_head"},{"identity":"public.messages.zzzzz_inbox_message_direct","function":"inbox_message_capture.capture"},{"identity":"public.messages.zzzzzzzz_inbox_operation_target","function":"inbox_operation_domain.capture_target"},{"identity":"public.organizations.zzzzzzz_inbox_reply_context","function":"inbox_reply_context.capture_organization"},{"identity":"public.properties.zzzzz_inbox_parent","function":"inbox_parent.capture_parent"},{"identity":"public.properties.zzzzzz_inbox_policy","function":"inbox_policy.capture_properties"},{"identity":"public.properties.zzzzzzz_inbox_reply_context","function":"inbox_reply_context.capture_property"},{"identity":"public.properties.zzzzzzzzz_inbox_sms_scope","function":"inbox_operation_domain.capture_sms_scope"},{"identity":"public.provider_sender_numbers.zzzzzzz_inbox_reply_context","function":"inbox_reply_context.capture_sender"},{"identity":"public.sequence_enrollments.zzzzzzzzz_inbox_sms_scope","function":"inbox_operation_domain.capture_sms_scope"},{"identity":"public.sms_phone_suppressions.zzzzz_inbox_safety_suppression","function":"inbox_safety.suppression_capture"},{"identity":"public.sms_phone_suppressions.zzzzzz_inbox_policy","function":"inbox_policy.capture_sms_phone_suppressions"}]'::jsonb);
  END IF;
END $$;
COMMIT;
