-- Private fixture candidate; installed only by the explicit guarded harness.
-- Per-contact revision of the canonical property/enrollment set used by manual
-- SMS opt-out. Historical absence must fail closed; no baseline guessed here.
BEGIN;
CREATE TABLE inbox_operation_domain.sms_scopes(
 org_id uuid NOT NULL,contact_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 PRIMARY KEY(org_id,contact_id)
);
ALTER TABLE inbox_operation_domain.sms_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_operation_domain.sms_scopes FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_operation_domain.shared_sms_receipts(
 org_id uuid NOT NULL,operation_id uuid NOT NULL,contact_id uuid NOT NULL,source_step_id uuid NOT NULL,
 original_scope jsonb NOT NULL,original_policy jsonb NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(org_id,operation_id,contact_id),
 FOREIGN KEY(org_id,operation_id,source_step_id) REFERENCES inbox_operations.steps(org_id,operation_id,id)
);
ALTER TABLE inbox_operation_domain.shared_sms_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_operation_domain.shared_sms_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_shared_sms_receipt BEFORE UPDATE OR DELETE ON inbox_operation_domain.shared_sms_receipts
 FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE FUNCTION inbox_operation_domain.capture_sms_scope() RETURNS trigger
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
CREATE TRIGGER zzzzzzzzz_inbox_sms_scope AFTER INSERT OR UPDATE OR DELETE ON public.properties
 FOR EACH ROW EXECUTE FUNCTION inbox_operation_domain.capture_sms_scope();
CREATE TRIGGER zzzzzzzzz_inbox_sms_scope AFTER INSERT OR UPDATE OR DELETE ON public.sequence_enrollments
 FOR EACH ROW EXECUTE FUNCTION inbox_operation_domain.capture_sms_scope();
REVOKE ALL ON FUNCTION inbox_operation_domain.capture_sms_scope() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
