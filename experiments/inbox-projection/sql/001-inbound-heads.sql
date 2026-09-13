-- T2 candidate, intentionally outside supabase/migrations.
-- Apply only to the explicitly owned offline source-schema rehearsal.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF current_database() <> 'postgres' OR NOT EXISTS (SELECT 1 FROM inbox_t2_fixture.identity WHERE marker = 'sandra-inbox-projection-t2-owned-synthetic') THEN
    RAISE EXCEPTION 'Only marked owned offline T2 rehearsal is allowed';
  END IF;
END $$;
-- ACCESS EXCLUSIVE spans baseline installation and trigger publication. Existing
-- tuples read as revision zero; a concurrent insert cannot pass between them.
LOCK TABLE public.messages IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.messages ADD COLUMN inbox_inbound_revision bigint NOT NULL DEFAULT 0;
-- NOT VALID avoids a historical-row validation scan inside installation's lock.
-- New/updated rows are checked immediately; later validation is a separate gate.
ALTER TABLE public.messages ADD CONSTRAINT messages_inbox_inbound_revision_nonnegative
  CHECK (inbox_inbound_revision >= 0) NOT VALID;
CREATE TABLE public.inbox_inbound_heads (
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (org_id, conversation_id)
);
-- No FK: deleting/reinserting an identity must not reset its counter.
ALTER TABLE public.inbox_inbound_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_inbound_heads FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.inbox_capture_inbound_head()
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
REVOKE ALL ON FUNCTION public.inbox_capture_inbound_head() FROM PUBLIC, anon, authenticated, service_role;
-- Invoker context sees the real caller, except during the allocator's explicit
-- SECURITY DEFINER self-update. No pg_trigger_depth or caller-settable GUC trust.
CREATE FUNCTION public.inbox_guard_inbound_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE allocator_owner name;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Even the owner must not supply a fabricated arrival revision at insertion.
    IF NEW.inbox_inbound_revision IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'INBOX_REVISION_SERVER_OWNED' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.inbox_inbound_revision IS DISTINCT FROM OLD.inbox_inbound_revision THEN
    SELECT r.rolname INTO STRICT allocator_owner
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
      WHERE p.oid = 'public.inbox_capture_inbound_head()'::pg_catalog.regprocedure;
    IF CURRENT_USER IS DISTINCT FROM allocator_owner THEN
      RAISE EXCEPTION 'INBOX_REVISION_SERVER_OWNED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inbox_guard_inbound_revision() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zzz_inbox_guard_inbound_revision_insert
  BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_inbound_revision();
CREATE TRIGGER zzz_inbox_guard_inbound_revision_update
  BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_guard_inbound_revision();
CREATE TRIGGER inbox_capture_inbound_head
  AFTER INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.inbox_capture_inbound_head();
COMMENT ON TABLE public.inbox_inbound_heads IS
  'T2 transactional per-org/conversation inbound arrival head; retain counters across source deletion. No global commit ordering claim.';
COMMENT ON COLUMN public.messages.inbox_inbound_revision IS
  'Zero is atomic pre-capture baseline; positive revision allocated on inbound SMS membership entry, after canonical identity stamping.';
COMMIT;
