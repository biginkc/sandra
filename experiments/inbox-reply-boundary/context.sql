-- Additional dependencies required by reviewed reply personalization and route
-- inventory. Fixture-only; install through the reviewed production migration.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_reply_context AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_reply_context FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_reply_context.versions(
 org_id uuid NOT NULL, namespace text NOT NULL CHECK(namespace IN ('sender_inventory','organization_name','property_market')),
 target_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0), PRIMARY KEY(org_id,namespace,target_id)
);
-- No canonical FK: deletion and same-ID reinsertion must not reset authority.
CREATE FUNCTION inbox_reply_context.bump(ns text,old_org uuid,old_id uuid,new_org uuid,new_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target record;
BEGIN
 IF ns IS NULL OR ns NOT IN ('sender_inventory','organization_name','property_market') THEN RAISE EXCEPTION 'Invalid reply context namespace'; END IF;
 FOR target IN SELECT DISTINCT org,id FROM (VALUES(old_org,old_id),(new_org,new_id)) v(org,id) WHERE org IS NOT NULL AND id IS NOT NULL ORDER BY org,id LOOP
  INSERT INTO inbox_reply_context.versions VALUES(target.org,ns,target.id,1)
  ON CONFLICT(org_id,namespace,target_id) DO UPDATE SET revision=inbox_reply_context.versions.revision+1;
 END LOOP;
END $$;
CREATE FUNCTION inbox_reply_context.capture_sender() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_org uuid;old_id uuid;new_org uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.provider,OLD.phone_e164,OLD.status,OLD.messaging_status,OLD.provider_number_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.provider,NEW.phone_e164,NEW.status,NEW.messaging_status,NEW.provider_number_id) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_org:=OLD.org_id;old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_org:=NEW.org_id;new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('sender_inventory',old_org,old_id,new_org,new_id);RETURN NULL;
END $$;
CREATE FUNCTION inbox_reply_context.capture_organization() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_id uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.name) IS NOT DISTINCT FROM (NEW.id,NEW.name) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('organization_name',old_id,old_id,new_id,new_id);RETURN NULL;
END $$;
CREATE FUNCTION inbox_reply_context.capture_property() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_org uuid;old_id uuid;new_org uuid;new_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.market) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.market) THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN old_org:=OLD.org_id;old_id:=OLD.id;END IF;
 IF TG_OP<>'DELETE' THEN new_org:=NEW.org_id;new_id:=NEW.id;END IF;
 PERFORM inbox_reply_context.bump('property_market',old_org,old_id,new_org,new_id);RETURN NULL;
END $$;
CREATE TRIGGER zzzzzzz_inbox_reply_context AFTER INSERT OR UPDATE OR DELETE ON public.provider_sender_numbers FOR EACH ROW EXECUTE FUNCTION inbox_reply_context.capture_sender();
CREATE TRIGGER zzzzzzz_inbox_reply_context AFTER INSERT OR UPDATE OR DELETE ON public.organizations FOR EACH ROW EXECUTE FUNCTION inbox_reply_context.capture_organization();
CREATE TRIGGER zzzzzzz_inbox_reply_context AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION inbox_reply_context.capture_property();
CREATE FUNCTION inbox_reply_context.value(o uuid,ns text,t uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF ns='sender_inventory' THEN
  SELECT jsonb_build_object('id',id,'org_id',org_id,'provider',provider,'phone_e164',phone_e164,'status',status,'messaging_status',messaging_status,'provider_number_id',provider_number_id) INTO result FROM public.provider_sender_numbers WHERE id=t AND org_id=o;
 ELSIF ns='organization_name' THEN
  SELECT jsonb_build_object('id',id,'name',name) INTO result FROM public.organizations WHERE id=t AND id=o;
 ELSIF ns='property_market' THEN
  SELECT jsonb_build_object('id',id,'org_id',org_id,'market',market) INTO result FROM public.properties WHERE id=t AND org_id=o;
 ELSE RAISE EXCEPTION 'Invalid reply context namespace'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION inbox_reply_context.snapshot(o uuid,ns text,t uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE source jsonb;version bigint;
BEGIN
 -- A negative canonical read cannot allocate permanent counters for arbitrary
 -- UUIDs. Existing pre-trigger rows establish their baseline once only.
 source:=inbox_reply_context.value(o,ns,t);
 IF source IS NULL THEN RETURN NULL;END IF;
 INSERT INTO inbox_reply_context.versions VALUES(o,ns,t,1) ON CONFLICT(org_id,namespace,target_id) DO NOTHING;
 SELECT revision INTO STRICT version FROM inbox_reply_context.versions WHERE org_id=o AND namespace=ns AND target_id=t FOR UPDATE;
 -- Fresh statement after any wait. Never authorize with the preliminary read.
 source:=inbox_reply_context.value(o,ns,t);
 IF source IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('namespace',ns,'target_id',t,'revision',version::text,'value',source);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_context FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_reply_context FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
