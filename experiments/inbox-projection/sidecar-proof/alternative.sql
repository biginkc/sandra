-- Rehearsal body only: caller must wrap in BEGIN ... ROLLBACK.
-- Existing candidate head storage is reused for a directly comparable allocator.
ALTER TABLE public.messages DISABLE TRIGGER inbox_capture_inbound_head;
CREATE SCHEMA inbox_t2_sidecar;
REVOKE ALL ON SCHEMA inbox_t2_sidecar FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE inbox_t2_sidecar.arrivals (
 message_id uuid PRIMARY KEY,
 org_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision > 0)
);
CREATE INDEX arrivals_boundary ON inbox_t2_sidecar.arrivals(org_id,conversation_id,revision,message_id);
ALTER TABLE inbox_t2_sidecar.arrivals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_t2_sidecar.arrivals FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION inbox_t2_sidecar.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r bigint;
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM inbox_t2_sidecar.arrivals WHERE message_id=OLD.id;
  RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.org_id,NEW.conversation_id,NEW.channel,NEW.direction)
    IS NOT DISTINCT FROM (OLD.id,OLD.org_id,OLD.conversation_id,OLD.channel,OLD.direction) THEN
   RETURN NULL;
  END IF;
  DELETE FROM inbox_t2_sidecar.arrivals WHERE message_id=OLD.id;
 END IF;
 IF NEW.channel IS DISTINCT FROM 'sms' OR NEW.direction IS DISTINCT FROM 'inbound'
   OR NEW.org_id IS NULL OR NEW.conversation_id IS NULL THEN RETURN NULL; END IF;
 INSERT INTO public.inbox_inbound_heads(org_id,conversation_id,revision)
 VALUES(NEW.org_id,NEW.conversation_id,1)
 ON CONFLICT(org_id,conversation_id) DO UPDATE
 SET revision=public.inbox_inbound_heads.revision+1 RETURNING revision INTO r;
 INSERT INTO inbox_t2_sidecar.arrivals VALUES(NEW.id,NEW.org_id,NEW.conversation_id,r);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION inbox_t2_sidecar.capture() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER inbox_t2_sidecar_capture AFTER INSERT OR UPDATE OR DELETE ON public.messages
 FOR EACH ROW EXECUTE FUNCTION inbox_t2_sidecar.capture();
