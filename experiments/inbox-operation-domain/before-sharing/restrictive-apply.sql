-- Source-only candidate. Replace the private adapter only after reviewed scope/helper installation.
CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_property_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE sms jsonb; sms_expected jsonb; sms_contact uuid; step jsonb; payload jsonb; expected jsonb; actual jsonb; requirements jsonb; prior jsonb;
 requester uuid; assignee uuid; property_id uuid; p public.properties; member public.memberships;
 requirement jsonb; revised jsonb; result jsonb; changed boolean; disposition text; entry record; targets jsonb; target jsonb; target_revision bigint; resolved jsonb; target_results jsonb:='[]'; actor_count integer;
BEGIN
 -- Completed replay never re-applies the effect; callers read the retained receipt.
 -- The fence lock is held through canonical writes and the final receipt.
 step:=inbox_operations.lock_step_for_effect(o,op,s,g);
 SELECT requester_id INTO STRICT requester FROM inbox_operations.operations WHERE org_id=o AND id=op;
 payload:=step->'payload'; property_id:=(payload->>'property_id')::uuid;
 IF property_id IS NULL OR step->>'action' NOT IN ('outcome','assign') THEN RAISE EXCEPTION 'Unsupported property effect';END IF;
 IF step->>'action'='assign' THEN assignee:=(payload->>'user_id')::uuid;END IF;
 -- Source locks precede version locks. Legacy transactions can still deadlock;
 -- whole-transaction retries, never an effect-only retry, are required externally.
 -- Global access epochs serialize membership insertion/removal across all orgs.
 -- The epoch is locked but not compared to the initial browser session: accepted
 -- jobs survive session closure, while current membership must remain unambiguous.
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id IN(requester,assignee) ORDER BY user_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=requester) OR (assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=assignee)) THEN RAISE EXCEPTION 'Access baseline missing';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 PERFORM 1 FROM public.memberships WHERE org_id=o AND user_id IN (requester,assignee) ORDER BY user_id FOR SHARE;
 SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=requester;
 IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Requester access revoked';END IF;
 IF assignee IS NOT NULL THEN
  SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=assignee;
  IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 END IF;
 SELECT * INTO p FROM public.properties WHERE org_id=o AND id=property_id FOR UPDATE;
 IF NOT FOUND OR p.deleted_at IS NOT NULL OR p.is_training OR p.is_dnc_locked THEN RAISE EXCEPTION 'Property ineligible';END IF;
 IF NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps WHERE org_id=o AND operation_id=op AND step_id=s) THEN RAISE EXCEPTION 'Property effect has no mappings';END IF;
 IF EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i USING(org_id,operation_id) WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.id=m.item_id AND (i.exclusion_code IS NOT NULL OR (i.resolution->>'property_id')::uuid IS DISTINCT FROM property_id)) THEN RAISE EXCEPTION 'Invalid property mapping';END IF;
 expected:=step->'original_dependencies'->'policy';
 IF expected->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing policy vector';END IF;
 prior:=step->'predecessor_result';
 sms:=prior->'sms';sms_contact:=(sms->>'contact_id')::uuid;
 IF sms_contact IS NOT NULL AND step->'original_dependencies'->'sms_scope'->>'contact_id' IS DISTINCT FROM sms_contact::text THEN RAISE EXCEPTION 'SMS predecessor contact mismatch';END IF;
 targets:=CASE WHEN prior IS NOT NULL AND prior<>'null'::jsonb THEN prior->'target_revisions' ELSE step->'original_dependencies'->'targets' END;
 IF jsonb_typeof(targets) IS DISTINCT FROM 'array' OR jsonb_array_length(targets) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Missing bounded target vector';END IF;
 IF jsonb_array_length(targets)<>(SELECT count(*) FROM inbox_operations.item_steps WHERE org_id=o AND operation_id=op AND step_id=s) THEN RAISE EXCEPTION 'Incomplete target vector';END IF;
 IF (SELECT count(DISTINCT value->>'conversation_id') FROM jsonb_array_elements(targets))<>jsonb_array_length(targets) THEN RAISE EXCEPTION 'Duplicate target vector';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(targets) ORDER BY value->>'conversation_id' LOOP
  IF NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i ON i.org_id=m.org_id AND i.operation_id=m.operation_id AND i.id=m.item_id WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.target_kind='conversation' AND i.target_id=(target->>'conversation_id')::uuid AND i.exclusion_code IS NULL) THEN RAISE EXCEPTION 'Target mapping mismatch';END IF;
  SELECT revision INTO target_revision FROM inbox_operation_domain.target_versions WHERE org_id=o AND conversation_id=(target->>'conversation_id')::uuid FOR UPDATE;
  IF NOT FOUND OR target_revision::text IS DISTINCT FROM target->>'revision' THEN RAISE EXCEPTION 'Target resolution changed';END IF;
  IF prior IS NOT NULL AND prior<>'null'::jsonb THEN
   IF NOT(target ? 'valid_until') THEN RAISE EXCEPTION 'Target validity missing';END IF;
   IF target->>'valid_until' IS NOT NULL AND (target->>'valid_until')::timestamptz<clock_timestamp() THEN RAISE EXCEPTION 'Target resolution expired';END IF;
  END IF;
  IF prior IS NULL OR prior='null'::jsonb THEN
   resolved:=inbox_t2_summary_contract.compute(o,(target->>'conversation_id')::uuid,clock_timestamp());
   IF resolved->>'exists' IS DISTINCT FROM 'true' OR resolved->>'property_id' IS DISTINCT FROM property_id::text THEN RAISE EXCEPTION 'Canonical target property changed';END IF;
   target:=target||jsonb_build_object('valid_until',resolved->'next_window_expiry');
  END IF;
  target_results:=target_results||jsonb_build_array(target);
 END LOOP;
 targets:=target_results;

 -- Only revisions expressly returned by this adapter may replace earlier values.
 IF prior IS NOT NULL AND prior<>'null'::jsonb THEN
  IF prior->>'property_id' IS DISTINCT FROM property_id::text OR jsonb_typeof(prior->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid predecessor receipt';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(prior->'revised_dependencies') LOOP
   IF NOT ((revised->>'namespace' IN ('property_outcome','property_assignment','property_reviews') AND revised->'key'=jsonb_build_array(property_id)) OR (sms_contact IS NOT NULL AND ((revised->>'namespace' IN ('contact_policy','contact_identity') AND revised->'key'=jsonb_build_array(sms_contact)) OR (revised->>'namespace'='contact_channel_consent' AND revised->'key'=jsonb_build_array(sms_contact,'sms'))))) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Invalid revised dependency';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END IF;
 -- These mandatory dependencies cover property eligibility, own outcome/followup
 -- mutations, review supersession, requester and selected-assignee access.
 FOR requirement IN SELECT jsonb_build_object('namespace',n,'key',jsonb_build_array(property_id)) FROM unnest(ARRAY['property_identity','property_policy','property_outcome','property_assignment','property_reviews']) n
 UNION ALL SELECT jsonb_build_object('namespace','membership_access','key',jsonb_build_array(requester))
 UNION SELECT jsonb_build_object('namespace','membership_access','key',jsonb_build_array(assignee)) WHERE assignee IS NOT NULL LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=requirement->>'namespace' AND d->'key'=requirement->'key') THEN RAISE EXCEPTION 'Incomplete policy vector';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key') ORDER BY d->>'namespace',(d->'key')::text) INTO requirements FROM jsonb_array_elements(expected->'dependencies') d;
 -- Validate key shapes/counts and seeded baselines before taking private locks.
 actual:=inbox_t2_policy.snapshot(o,requirements);
 PERFORM 1 FROM inbox_t2_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 actual:=inbox_t2_policy.snapshot(o,requirements);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Dependency conflict';END IF;
 IF step->>'action'='outcome' THEN
  disposition:=payload->>'value';
  IF disposition='dnc' THEN RAISE EXCEPTION 'permanent_dnc_not_enabled';END IF;
  IF disposition IS NULL OR disposition NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture','opted_out') THEN RAISE EXCEPTION 'Unsupported outcome';END IF;
  IF disposition='opted_out' THEN
   SELECT jsonb_build_object('org_id',o,'dependencies',coalesce(jsonb_agg(d),'[]')) INTO sms_expected FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace' IN ('contact_identity','contact_policy','contact_channel_consent');
   sms:=inbox_operation_domain.apply_sms_opt_out(o,property_id,requester,s,step->'original_dependencies'->'sms_scope',sms_expected);
   sms_contact:=(sms->>'contact_id')::uuid;
  END IF;
  changed:=p.outreach_dispo IS DISTINCT FROM disposition;
  UPDATE public.properties SET outreach_dispo=disposition,follow_up_at=NULL,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
  IF changed THEN INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'dispo_set',jsonb_build_object('from',p.outreach_dispo,'to',disposition),'inbox_operation_step',s);END IF;
 ELSE
  changed:=p.assigned_user_id IS DISTINCT FROM assignee;
  IF changed THEN
   UPDATE public.properties SET assigned_user_id=assignee,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
   INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'assigned',jsonb_build_object('from',p.assigned_user_id,'to',assignee),'inbox_operation_step',s);
  END IF;
 END IF;
 actual:=inbox_t2_policy.snapshot(o,requirements);
 SELECT coalesce(jsonb_agg(d ORDER BY d->>'namespace',(d->'key')::text),'[]'::jsonb) INTO revised FROM jsonb_array_elements(actual->'dependencies') d WHERE (d->>'namespace' IN ('property_outcome','property_assignment','property_reviews') AND d->'key'=jsonb_build_array(property_id)) OR (sms_contact IS NOT NULL AND ((d->>'namespace' IN ('contact_identity','contact_policy') AND d->'key'=jsonb_build_array(sms_contact)) OR (d->>'namespace'='contact_channel_consent' AND d->'key'=jsonb_build_array(sms_contact,'sms'))));
 SELECT jsonb_agg(jsonb_build_object('conversation_id',v.conversation_id,'revision',v.revision::text,'valid_until',t->'valid_until') ORDER BY v.conversation_id) INTO target_results FROM inbox_operation_domain.target_versions v JOIN jsonb_array_elements(targets) t ON v.conversation_id=(t->>'conversation_id')::uuid WHERE v.org_id=o;
 result:=jsonb_build_object('property_id',property_id,'action',step->>'action','changed',changed,'before',jsonb_build_object('outcome',p.outreach_dispo,'assignee',p.assigned_user_id,'follow_up_at',p.follow_up_at),'after',(SELECT jsonb_build_object('outcome',outreach_dispo,'assignee',assigned_user_id,'follow_up_at',follow_up_at) FROM public.properties WHERE id=property_id AND org_id=o),'revised_dependencies',revised,'target_revisions',target_results,'sms',sms);
 -- Recheck wall-clock authorization after source work; locks alone do not freeze time.
 IF EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id IN(requester,assignee) AND access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Access expired during effect';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(target_results) t WHERE t->>'valid_until' IS NOT NULL AND (t->>'valid_until')::timestamptz<clock_timestamp()) THEN RAISE EXCEPTION 'Target resolution expired';END IF;
 PERFORM inbox_operations.finish_step(o,op,s,g,result);
 RETURN result;
END $$;
