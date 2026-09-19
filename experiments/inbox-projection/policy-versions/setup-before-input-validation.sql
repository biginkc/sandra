-- Worker-private action dependency counters; not a production migration or send authorization.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE SCHEMA inbox_t2_policy AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_policy FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_policy.versions(
 org_id uuid NOT NULL,namespace text NOT NULL CHECK(namespace IN ('property_identity','property_policy','property_outcome','property_assignment','property_reply_content','contact_identity','contact_policy','contact_reply_content','contact_channel_consent','route_policy','conversation_identity','review_action','property_reviews','membership_access')),entity_key text NOT NULL CHECK(length(entity_key)<=256),
 revision bigint NOT NULL CHECK(revision>0),PRIMARY KEY(org_id,namespace,entity_key)
);
-- Persistent counters have no canonical FK and are never removed on entity deletion.
CREATE FUNCTION inbox_t2_policy.bump(events jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k record;
BEGIN
 IF jsonb_typeof(events) IS DISTINCT FROM 'array' OR jsonb_array_length(events)>32 THEN RAISE EXCEPTION 'Invalid bounded dependency events';END IF;
 FOR k IN SELECT DISTINCT (value->>'org')::uuid org,value->>'namespace' namespace,(value->'key')::text entity_key FROM jsonb_array_elements(events) ORDER BY 1,2,3 LOOP
  INSERT INTO inbox_t2_policy.versions VALUES(k.org,k.namespace,k.entity_key,1) ON CONFLICT(org_id,namespace,entity_key) DO UPDATE SET revision=inbox_t2_policy.versions.revision+1;
 END LOOP;
END $$;
CREATE FUNCTION inbox_t2_policy.capture_properties() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
 PERFORM inbox_t2_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_t2_policy AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION inbox_t2_policy.capture_properties();
CREATE FUNCTION inbox_t2_policy.capture_contacts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
 PERFORM inbox_t2_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_t2_policy AFTER INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION inbox_t2_policy.capture_contacts();
CREATE FUNCTION inbox_t2_policy.capture_consent_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.contact_id,OLD.channel,OLD.event_type,OLD.occurred_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.contact_id,NEW.channel,NEW.event_type,NEW.occurred_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','contact_channel_consent','key',jsonb_build_array(OLD.contact_id,OLD.channel)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','contact_channel_consent','key',jsonb_build_array(NEW.contact_id,NEW.channel)));END IF;
 END IF;
 PERFORM inbox_t2_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_t2_policy AFTER INSERT OR UPDATE OR DELETE ON public.consent_events FOR EACH ROW EXECUTE FUNCTION inbox_t2_policy.capture_consent_events();
CREATE FUNCTION inbox_t2_policy.capture_sms_phone_suppressions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.channel,OLD.phone_e164,OLD.suppressed_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.channel,NEW.phone_e164,NEW.suppressed_at);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','route_policy','key',jsonb_build_array(OLD.channel,OLD.phone_e164)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','route_policy','key',jsonb_build_array(NEW.channel,NEW.phone_e164)));END IF;
 END IF;
 PERFORM inbox_t2_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_t2_policy AFTER INSERT OR UPDATE OR DELETE ON public.sms_phone_suppressions FOR EACH ROW EXECUTE FUNCTION inbox_t2_policy.capture_sms_phone_suppressions();
CREATE FUNCTION inbox_t2_policy.capture_message_threads() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','conversation_identity','key',jsonb_build_array(OLD.conversation_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','conversation_identity','key',jsonb_build_array(NEW.conversation_id)));END IF;
 END IF;
 PERFORM inbox_t2_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_t2_policy AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION inbox_t2_policy.capture_message_threads();
CREATE FUNCTION inbox_t2_policy.capture_ai_disposition_reviews() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
 PERFORM inbox_t2_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_t2_policy AFTER INSERT OR UPDATE OR DELETE ON public.ai_disposition_reviews FOR EACH ROW EXECUTE FUNCTION inbox_t2_policy.capture_ai_disposition_reviews();
CREATE FUNCTION inbox_t2_policy.capture_memberships() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE events jsonb:='[]';changed boolean;
BEGIN
 changed:=true;
 IF TG_OP='UPDATE' THEN changed:=(OLD.id,OLD.org_id,OLD.user_id,OLD.role,OLD.access_status,OLD.access_expires_at,OLD.deletion_prepared_at,OLD.deletion_operation_id,OLD.hugo_config,OLD.acquisitions_enabled) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.user_id,NEW.role,NEW.access_status,NEW.access_expires_at,NEW.deletion_prepared_at,NEW.deletion_operation_id,NEW.hugo_config,NEW.acquisitions_enabled);END IF;
 IF changed THEN
  IF TG_OP<>'INSERT' THEN events:=events||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'namespace','membership_access','key',jsonb_build_array(OLD.user_id)));END IF;
  IF TG_OP<>'DELETE' THEN events:=events||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'namespace','membership_access','key',jsonb_build_array(NEW.user_id)));END IF;
 END IF;
 PERFORM inbox_t2_policy.bump(events);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzz_inbox_t2_policy AFTER INSERT OR UPDATE OR DELETE ON public.memberships FOR EACH ROW EXECUTE FUNCTION inbox_t2_policy.capture_memberships();
CREATE FUNCTION inbox_t2_policy.snapshot(o uuid,requirements jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;count_required integer;
BEGIN
 IF o IS NULL OR jsonb_typeof(requirements) IS DISTINCT FROM 'array' OR jsonb_array_length(requirements)<1 OR jsonb_array_length(requirements)>50 THEN RAISE EXCEPTION 'Invalid bounded dependency requirements';END IF;
 SELECT count(*) INTO count_required FROM(SELECT DISTINCT value->>'namespace' namespace,(value->'key')::text entity_key FROM jsonb_array_elements(requirements)) s;
 IF count_required<>jsonb_array_length(requirements) THEN RAISE EXCEPTION 'Duplicate dependency';END IF;
 SELECT jsonb_agg(jsonb_build_object('namespace',v.namespace,'key',v.entity_key::jsonb,'revision',v.revision::text) ORDER BY v.namespace,v.entity_key) INTO result
 FROM jsonb_array_elements(requirements) r JOIN inbox_t2_policy.versions v ON v.org_id=o AND v.namespace=r.value->>'namespace' AND v.entity_key=(r.value->'key')::text;
 IF coalesce(jsonb_array_length(result),0)<>count_required THEN RAISE EXCEPTION 'Unseeded dependency: authoritative baseline required';END IF;
 RETURN jsonb_build_object('org_id',o,'dependencies',result);
END $$;
ALTER TABLE inbox_t2_policy.versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_policy FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_policy FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
