-- Private fixture candidate; called only by the guarded restrictive adapter.
-- Caller must hold/verify the accepted durable step and current requester access,
-- property policy/identity, and exact typed target mappings in the SAME transaction.
BEGIN;
CREATE FUNCTION inbox_operation_domain.apply_sms_opt_out(o uuid,p uuid,actor uuid,s uuid,operation_id uuid,expected_scope jsonb,expected_policy jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE homeowner uuid;scope_revision bigint;contact public.contacts;property_ids uuid[];enrollment_ids uuid[];
 shared inbox_operation_domain.shared_sms_receipts;original_scope jsonb:=expected_scope;original_policy jsonb:=expected_policy;result jsonb;requirements jsonb;actual jsonb;requirement jsonb;consent_id uuid;paused jsonb:='[]';item record;contact_changed boolean:=false;
BEGIN
 SELECT homeowner_contact_id INTO homeowner FROM public.properties WHERE org_id=o AND id=p FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Property missing';END IF;
 IF homeowner IS NULL THEN result:=jsonb_build_object('contact_id',NULL,'paused',paused);END IF;
 IF expected_scope->>'contact_id' IS DISTINCT FROM homeowner::text THEN RAISE EXCEPTION 'SMS scope contact changed';END IF;
 SELECT revision INTO scope_revision FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
 SELECT r.* INTO shared FROM inbox_operation_domain.shared_sms_receipts r JOIN inbox_operations.receipts completed
  ON completed.org_id=r.org_id AND completed.operation_id=r.operation_id AND completed.step_id=r.source_step_id
  WHERE r.org_id=o AND r.operation_id=apply_sms_opt_out.operation_id AND r.contact_id=homeowner;
 IF FOUND THEN
  IF shared.original_scope IS DISTINCT FROM expected_scope OR shared.original_policy IS DISTINCT FROM expected_policy THEN RAISE EXCEPTION 'Shared SMS preparation mismatch';END IF;
  expected_scope:=shared.result->'current_scope';expected_policy:=shared.result->'policy';
 END IF;
 IF scope_revision::text IS DISTINCT FROM expected_scope->>'revision' THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
 SELECT * INTO contact FROM public.contacts WHERE org_id=o AND id=homeowner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SMS contact missing';END IF;
 SELECT array_agg(id ORDER BY id) INTO property_ids FROM (SELECT id FROM public.properties WHERE org_id=o AND homeowner_contact_id=homeowner ORDER BY id LIMIT 501 FOR UPDATE) q;
 IF cardinality(property_ids)>500 OR NOT(p=ANY(property_ids)) THEN RAISE EXCEPTION 'SMS property scope exceeds bound or changed';END IF;
 SELECT array_agg(id ORDER BY id) INTO enrollment_ids FROM (SELECT id FROM public.sequence_enrollments WHERE org_id=o AND property_id=ANY(property_ids) AND status='active' ORDER BY id LIMIT 501 FOR UPDATE) q;
 IF cardinality(enrollment_ids)>500 THEN RAISE EXCEPTION 'SMS enrollment scope exceeds bound';END IF;
 -- Scope metadata is trusted preparation output, never client-supplied input.
 -- The bounded source set must match preparation, including currently active rows.
 IF to_jsonb(property_ids) IS DISTINCT FROM expected_scope->'property_ids' OR to_jsonb(coalesce(enrollment_ids,ARRAY[]::uuid[])) IS DISTINCT FROM expected_scope->'enrollment_ids' THEN RAISE EXCEPTION 'SMS scope membership changed';END IF;
 IF expected_policy->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected_policy->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'SMS policy vector missing';END IF;
 FOR requirement IN SELECT jsonb_build_object('namespace',n,'key',jsonb_build_array(homeowner)) FROM unnest(ARRAY['contact_identity','contact_policy']) n
 UNION ALL SELECT jsonb_build_object('namespace','contact_channel_consent','key',jsonb_build_array(homeowner,'sms')) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected_policy->'dependencies') d WHERE d->>'namespace'=requirement->>'namespace' AND d->'key'=requirement->'key') THEN RAISE EXCEPTION 'SMS policy dependency missing';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key')) INTO requirements FROM jsonb_array_elements(expected_policy->'dependencies') d;
 actual:=inbox_t2_policy.snapshot(o,requirements);
 PERFORM 1 FROM inbox_t2_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 IF inbox_t2_policy.snapshot(o,requirements) IS DISTINCT FROM expected_policy THEN RAISE EXCEPTION 'SMS policy conflict';END IF;
 IF shared.source_step_id IS NOT NULL THEN RETURN shared.result||jsonb_build_object('reused',true);END IF;
 -- A permanent DNC row stays immutable. Consent is append-only and compliance
 -- enrollment stops use the canonical permitted transition, never a guard bypass.
 IF NOT contact.sms_opted_out THEN
  INSERT INTO public.consent_events(org_id,contact_id,channel,event_type,source,source_detail,occurred_at)
   VALUES(o,homeowner,'sms','opt_out','manual_dispo',jsonb_build_object('propertyId',p,'operationStepId',s),clock_timestamp()) RETURNING id INTO consent_id;
  IF NOT contact.do_not_contact AND NOT EXISTS(SELECT 1 FROM public.properties WHERE org_id=o AND id=ANY(property_ids) AND is_dnc_locked) THEN
   UPDATE public.contacts SET sms_opted_out=true,sms_opted_out_at=clock_timestamp() WHERE org_id=o AND id=homeowner;
   contact_changed:=true;
  END IF;
  INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id)
   VALUES(o,p,'user',actor,'opted_out','{"channel":"sms","trigger":"manual_disposition"}','consent_events.opt_out',consent_id);
 END IF;
 WITH changed AS(UPDATE public.sequence_enrollments SET status='opted_out',pause_reason='consent_revoked',next_run_at=NULL,updated_at=clock_timestamp()
  WHERE org_id=o AND id=ANY(coalesce(enrollment_ids,ARRAY[]::uuid[])) AND status='active' RETURNING id,property_id,sequence_id)
 SELECT coalesce(jsonb_agg(to_jsonb(changed) ORDER BY id),'[]') INTO paused FROM changed;
 FOR item IN SELECT (value->>'property_id')::uuid property_id,count(*) count,jsonb_agg(DISTINCT value->>'sequence_id') sequence_ids FROM jsonb_array_elements(paused) GROUP BY 1 ORDER BY 1 LOOP
  INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id)
   VALUES(o,item.property_id,'user',actor,'sequence_paused',jsonb_build_object('count',item.count,'sequence_ids',item.sequence_ids,'reason','consent_revoked','permanent',true),'inbox_operation_step.sequence_paused',md5(s::text||':'||item.property_id::text)::uuid);
 END LOOP;
 result:=jsonb_build_object('contact_id',homeowner,'contact_changed',contact_changed,'consent_id',consent_id,'paused',paused,
  'scope_revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner),'policy',inbox_t2_policy.snapshot(o,requirements),
  'reused',false,'source_step_id',s,'current_scope',jsonb_build_object('contact_id',homeowner,'revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner),'property_ids',to_jsonb(property_ids),'enrollment_ids',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.sequence_enrollments WHERE org_id=o AND property_id=ANY(property_ids) AND status='active'),'[]'::jsonb)));
 INSERT INTO inbox_operation_domain.shared_sms_receipts VALUES(o,operation_id,homeowner,s,original_scope,original_policy,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION inbox_operation_domain.apply_sms_opt_out(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
