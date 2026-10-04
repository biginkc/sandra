-- Additive Inbox opt-out scope retry (DLK2-8 Option B).
-- The original prepared scope remains the shared receipt's identity. A
-- transaction-local flag permits exactly one effective-scope rebase after one
-- of the three existing sms_scope_changed errors; no grants or triggers are
-- changed here.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_sms_opt_out(o uuid,p uuid,actor uuid,s uuid,operation_id uuid,expected_scope jsonb,expected_policy jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE homeowner uuid;scope_revision bigint;contact public.contacts;property_ids uuid[];enrollment_ids uuid[];
 shared inbox_operation_domain.shared_sms_receipts;original_scope jsonb:=expected_scope;original_policy jsonb:=expected_policy;effective_scope jsonb;result jsonb;requirements jsonb;actual jsonb;requirement jsonb;consent_id uuid;paused jsonb:='[]';item record;contact_changed boolean:=false;
 scope_rebase boolean:=current_setting('inbox.operation_scope_rebase',true)='on';rebased_from_revision text;rebased_to_revision text;rebased_property_count integer;rebased_enrollment_count integer;
BEGIN
 SELECT homeowner_contact_id INTO homeowner FROM public.properties WHERE org_id=o AND id=p FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Property missing';END IF;
 IF homeowner IS NULL THEN RETURN jsonb_build_object('contact_id',NULL,'paused',paused,'reused',false);END IF;
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
 IF NOT scope_rebase AND scope_revision::text IS DISTINCT FROM expected_scope->>'revision' THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
 SELECT * INTO contact FROM public.contacts WHERE org_id=o AND id=homeowner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SMS contact missing';END IF;
 SELECT array_agg(id ORDER BY id) INTO property_ids FROM (SELECT id FROM public.properties WHERE org_id=o AND homeowner_contact_id=homeowner ORDER BY id LIMIT 501 FOR UPDATE) q;
 IF cardinality(property_ids)>500 OR NOT(p=ANY(property_ids)) THEN RAISE EXCEPTION 'SMS property scope exceeds bound or changed';END IF;
 SELECT array_agg(id ORDER BY id) INTO enrollment_ids FROM (SELECT id FROM public.sequence_enrollments WHERE org_id=o AND property_id=ANY(property_ids) AND status='active' ORDER BY id LIMIT 501 FOR UPDATE) q;
 IF cardinality(enrollment_ids)>500 THEN RAISE EXCEPTION 'SMS enrollment scope exceeds bound';END IF;
 IF scope_rebase THEN
  rebased_from_revision:=expected_scope->>'revision';rebased_to_revision:=scope_revision::text;
  rebased_property_count:=coalesce(cardinality(property_ids),0);rebased_enrollment_count:=coalesce(cardinality(enrollment_ids),0);
  effective_scope:=jsonb_build_object('contact_id',homeowner,'revision',rebased_to_revision,'property_ids',to_jsonb(property_ids),'enrollment_ids',to_jsonb(coalesce(enrollment_ids,ARRAY[]::uuid[])));
  expected_scope:=effective_scope;
 END IF;
 -- Scope metadata is trusted preparation output, never client-supplied input.
 -- The bounded source set must match preparation, including currently active rows.
 IF to_jsonb(property_ids) IS DISTINCT FROM expected_scope->'property_ids' OR to_jsonb(coalesce(enrollment_ids,ARRAY[]::uuid[])) IS DISTINCT FROM expected_scope->'enrollment_ids' THEN RAISE EXCEPTION 'SMS scope membership changed';END IF;
 IF expected_policy->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected_policy->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'SMS policy vector missing';END IF;
 FOR requirement IN SELECT jsonb_build_object('namespace',n,'key',jsonb_build_array(homeowner)) FROM unnest(ARRAY['contact_identity','contact_policy']) n
 UNION ALL SELECT jsonb_build_object('namespace','contact_channel_consent','key',jsonb_build_array(homeowner,'sms')) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected_policy->'dependencies') d WHERE d->>'namespace'=requirement->>'namespace' AND d->'key'=requirement->'key') THEN RAISE EXCEPTION 'SMS policy dependency missing';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key')) INTO requirements FROM jsonb_array_elements(expected_policy->'dependencies') d;
 actual:=inbox_policy.snapshot(o,requirements);
 PERFORM 1 FROM inbox_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 IF inbox_policy.snapshot(o,requirements) IS DISTINCT FROM expected_policy THEN RAISE EXCEPTION 'SMS policy conflict';END IF;
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
  'scope_revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner),'policy',inbox_policy.snapshot(o,requirements),
  'reused',false,'source_step_id',s,'current_scope',jsonb_build_object('contact_id',homeowner,'revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner),'property_ids',to_jsonb(property_ids),'enrollment_ids',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.sequence_enrollments WHERE org_id=o AND property_id=ANY(property_ids) AND status='active'),'[]'::jsonb)));
 IF scope_rebase THEN
  result:=result||jsonb_build_object('scope_rebase_attempted',true,'rebased_from_revision',rebased_from_revision,'rebased_to_revision',rebased_to_revision,'rebased_property_count',rebased_property_count,'rebased_enrollment_count',rebased_enrollment_count);
 END IF;
 INSERT INTO inbox_operation_domain.shared_sms_receipts VALUES(o,operation_id,homeowner,s,original_scope,original_policy,result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_property_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE shared_sms inbox_operation_domain.shared_sms_receipts; sms_original_policy jsonb; sms jsonb; sms_expected jsonb; sms_contact uuid; step jsonb; payload jsonb; expected jsonb; actual jsonb; requirements jsonb; prior jsonb; history jsonb; historical jsonb;
 requester uuid; assignee uuid; property_id uuid; p public.properties; member public.memberships;
 requirement jsonb; revised jsonb; result jsonb; changed boolean; disposition text; entry record; targets jsonb; target jsonb; target_revision bigint; resolved jsonb; target_results jsonb:='[]'; actor_count integer;scope_rebase boolean:=current_setting('inbox.operation_scope_rebase',true)='on';
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
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id IN(requester,assignee) ORDER BY user_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM inbox_bridge.access_epochs WHERE user_id=requester) OR (assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_bridge.access_epochs WHERE user_id=assignee)) THEN RAISE EXCEPTION 'Access baseline missing';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 PERFORM 1 FROM public.memberships WHERE org_id=o AND user_id IN (requester,assignee) ORDER BY user_id FOR SHARE;
 SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=requester;
 IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Requester access revoked';END IF;
 IF assignee IS NOT NULL THEN
  SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=assignee;
  IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 END IF;
 -- Serialize same-operation/contact safety BEFORE locking individual properties
 -- or reading the committed shared receipt. A waiting sibling then sees the
 -- previous effect's post-state instead of validating stale shared revisions.
 IF (step->>'action'='outcome' AND payload->>'value'='opted_out') OR step->'predecessor_result'->'sms'->>'contact_id' IS NOT NULL THEN
  IF step->'original_dependencies'->'sms_scope'->>'contact_id' IS NOT NULL THEN
   PERFORM 1 FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=(step->'original_dependencies'->'sms_scope'->>'contact_id')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
  END IF;
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
   resolved:=inbox_summary_contract.compute(o,(target->>'conversation_id')::uuid,clock_timestamp());
   IF resolved->>'exists' IS DISTINCT FROM 'true' OR resolved->>'property_id' IS DISTINCT FROM property_id::text THEN RAISE EXCEPTION 'Canonical target property changed';END IF;
   target:=target||jsonb_build_object('valid_until',resolved->'next_window_expiry');
  END IF;
  target_results:=target_results||jsonb_build_array(target);
 END LOOP;
 targets:=target_results;

 -- Rebase every accepted predecessor in order. Each adapter receipt returns
 -- only the dependency namespaces it changed, so the final step must merge
 -- the whole chain rather than just the immediately preceding receipt.
 history:=step->'predecessor_results';
 IF jsonb_typeof(history) IS DISTINCT FROM 'array' THEN
  history:=CASE WHEN prior IS NULL OR prior='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(prior) END;
 END IF;
 FOR historical IN SELECT value FROM jsonb_array_elements(history) LOOP
  IF historical->>'property_id' IS DISTINCT FROM property_id::text OR jsonb_typeof(historical->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid predecessor receipt';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(historical->'revised_dependencies') LOOP
   IF NOT ((revised->>'namespace' IN ('property_identity','property_policy','property_outcome','property_assignment','property_reviews') AND revised->'key'=jsonb_build_array(property_id)) OR (sms_contact IS NOT NULL AND ((revised->>'namespace' IN ('contact_policy','contact_identity') AND revised->'key'=jsonb_build_array(sms_contact)) OR (revised->>'namespace'='contact_channel_consent' AND revised->'key'=jsonb_build_array(sms_contact,'sms'))))) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Invalid revised dependency';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END LOOP;
 -- Reuse only this accepted operation's committed contact safety transition.
 -- Exact original preparation equality is required before rebasing shared keys.
 SELECT jsonb_build_object('org_id',o,'dependencies',coalesce(jsonb_agg(d ORDER BY d->>'namespace',(d->'key')::text),'[]')) INTO sms_original_policy FROM jsonb_array_elements(step->'original_dependencies'->'policy'->'dependencies') d WHERE d->>'namespace' IN ('contact_identity','contact_policy','contact_channel_consent');
 IF (step->>'action'='outcome' AND payload->>'value'='opted_out') OR sms_contact IS NOT NULL THEN
 SELECT r.* INTO shared_sms FROM inbox_operation_domain.shared_sms_receipts r JOIN inbox_operations.receipts completed ON completed.org_id=r.org_id AND completed.operation_id=r.operation_id AND completed.step_id=r.source_step_id
  WHERE r.org_id=o AND r.operation_id=op AND r.contact_id=(step->'original_dependencies'->'sms_scope'->>'contact_id')::uuid;
 IF FOUND THEN
  IF shared_sms.original_scope IS DISTINCT FROM step->'original_dependencies'->'sms_scope' OR shared_sms.original_policy IS DISTINCT FROM sms_original_policy THEN RAISE EXCEPTION 'Shared SMS preparation mismatch';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(shared_sms.result->'policy'->'dependencies') LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Shared SMS dependency missing';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END IF;
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
 actual:=inbox_policy.snapshot(o,requirements);
 PERFORM 1 FROM inbox_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 actual:=inbox_policy.snapshot(o,requirements);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Dependency conflict';END IF;
 IF step->>'action'='outcome' THEN
  disposition:=payload->>'value';
  IF disposition='dnc' THEN RAISE EXCEPTION 'permanent_dnc_not_enabled';END IF;
  IF disposition IS NULL OR disposition NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture','opted_out') THEN RAISE EXCEPTION 'Unsupported outcome';END IF;
  IF disposition='opted_out' THEN
   SELECT jsonb_build_object('org_id',o,'dependencies',coalesce(jsonb_agg(d),'[]')) INTO sms_expected FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace' IN ('contact_identity','contact_policy','contact_channel_consent');
   sms:=inbox_operation_domain.apply_sms_opt_out(o,property_id,requester,s,op,step->'original_dependencies'->'sms_scope',sms_original_policy);
   sms_contact:=(sms->>'contact_id')::uuid;
  END IF;
  changed:=p.outreach_dispo IS DISTINCT FROM disposition;
  UPDATE public.properties SET outreach_dispo=disposition,follow_up_at=NULL,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
  -- Guard the shared-reuse return at line 54 against a stale scope.
  IF scope_rebase AND sms->>'contact_id' IS NOT NULL AND sms->>'scope_revision' IS DISTINCT FROM (SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=(sms->>'contact_id')::uuid) THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
  IF changed THEN INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'dispo_set',jsonb_build_object('from',p.outreach_dispo,'to',disposition),'inbox_operation_step',s);END IF;
 ELSE
  changed:=p.assigned_user_id IS DISTINCT FROM assignee;
  IF changed THEN
   UPDATE public.properties SET assigned_user_id=assignee,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
   INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'assigned',jsonb_build_object('from',p.assigned_user_id,'to',assignee),'inbox_operation_step',s);
  END IF;
 END IF;
 actual:=inbox_policy.snapshot(o,requirements);
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

CREATE OR REPLACE FUNCTION inbox_action_api.execute_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE result jsonb;message text;terminal_state text;code text;kind text;action text;value text;scope_rebase_attempted boolean:=false;v bigint;child inbox_operations.steps;
BEGIN
 -- Keep the claim lock outside the rollback scope. A caught business failure
 -- rolls back every canonical write, then commits a durable failure receipt.
 PERFORM inbox_operations.lock_step_for_effect(o,op,s,g);
 PERFORM set_config('inbox.operation_scope_rebase','off',true);
 SELECT st.action,st.payload->>'value',CASE
   WHEN st.action='promote' THEN 'promote'
   WHEN st.action IN ('dismiss_unknown','restore_unknown') THEN 'unknown'
   ELSE 'property'
  END INTO action,value,kind
  FROM inbox_operations.steps st WHERE st.org_id=o AND st.operation_id=op AND st.id=s;
 BEGIN
  -- Dispatch by the immutable prepared action. Each adapter owns its own
  -- canonical locks and receipt semantics; unknown actions receive the exact
  -- message-id workset captured during preparation and never raw-sender
  -- expansion.
  IF kind='promote' THEN result:=inbox_operation_domain.apply_promotion_step(o,op,s,g);
  ELSIF kind='unknown' THEN result:=inbox_operation_domain.apply_unknown_step(o,op,s,g);
  ELSE result:=inbox_operation_domain.apply_property_step(o,op,s,g);
  END IF;
  RETURN result;
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF action='outcome' AND value='opted_out' AND message IN ('SMS scope changed or unseeded','SMS scope membership changed','SMS property scope exceeds bound or changed') THEN
   scope_rebase_attempted:=true;
   PERFORM set_config('inbox.operation_scope_rebase','on',true);
   BEGIN
    result:=inbox_operation_domain.apply_property_step(o,op,s,g);
    RETURN result;
   EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    IF message NOT IN (
     'Requester membership ambiguous or missing','Requester access revoked','Access expired during effect',
     'Assignee unavailable','Property ineligible','Target resolution changed','Target resolution expired',
     'Canonical target property changed','Dependency conflict','SMS policy conflict',
     'SMS scope changed or unseeded','SMS scope contact changed','SMS scope membership changed',
     'SMS contact missing','SMS property scope exceeds bound or changed','SMS enrollment scope exceeds bound',
     'permanent_dnc_not_enabled','Unknown action snapshot changed','Unknown sender identity changed',
     'message_unavailable','Access baseline missing'
    ) THEN RAISE;
    END IF;
   END;
  END IF;
  CASE message
   WHEN 'Requester membership ambiguous or missing' THEN terminal_state:='blocked';code:='requester_access_unavailable';
   WHEN 'Requester access revoked' THEN terminal_state:='blocked';code:='requester_access_revoked';
   WHEN 'Access expired during effect' THEN terminal_state:='blocked';code:='access_expired';
   WHEN 'Assignee unavailable' THEN terminal_state:='conflicted';code:='assignee_unavailable';
   WHEN 'Property ineligible' THEN terminal_state:='conflicted';code:='property_ineligible';
   WHEN 'Target resolution changed' THEN terminal_state:='conflicted';code:='target_changed';
   WHEN 'Target resolution expired' THEN terminal_state:='conflicted';code:='target_expired';
   WHEN 'Canonical target property changed' THEN terminal_state:='conflicted';code:='target_changed';
   WHEN 'Dependency conflict' THEN terminal_state:='conflicted';code:='record_changed';
   WHEN 'SMS policy conflict' THEN terminal_state:='conflicted';code:='sms_policy_changed';
   WHEN 'SMS scope changed or unseeded' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS scope contact changed' THEN terminal_state:='conflicted';code:='sms_contact_changed';
   WHEN 'SMS scope membership changed' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS contact missing' THEN terminal_state:='conflicted';code:='sms_contact_unavailable';
   WHEN 'SMS property scope exceeds bound or changed' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS enrollment scope exceeds bound' THEN terminal_state:='blocked';code:='sms_scope_too_large';
   WHEN 'permanent_dnc_not_enabled' THEN terminal_state:='blocked';code:='permanent_dnc_not_enabled';
   WHEN 'Unknown action snapshot changed' THEN terminal_state:='conflicted';code:='unknown_action_changed';
   WHEN 'Unknown sender identity changed' THEN terminal_state:='conflicted';code:='unknown_identity_changed';
   WHEN 'message_unavailable' THEN terminal_state:='conflicted';code:='message_unavailable';
   WHEN 'Access baseline missing' THEN terminal_state:='blocked';code:='requester_access_unavailable';
   ELSE RAISE; -- Invariant/software faults are not disguised as business denials.
  END CASE;
 END;
 IF scope_rebase_attempted THEN
  PERFORM inbox_operations.lock_step_for_effect(o,op,s,g);
  result:=jsonb_build_object('status',terminal_state,'code',code,'changed',false,'scope_rebase_attempted',true);
  UPDATE inbox_operations.steps SET state=terminal_state,lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND operation_id=op AND id=s RETURNING receipt_version INTO v;
  INSERT INTO inbox_operations.receipts VALUES(o,op,s,v,g,result,clock_timestamp());
  -- Keep the existing prerequisite-blocking semantics of fail_step.
  FOR child IN SELECT st.* FROM inbox_operations.steps st JOIN inbox_operations.steps failed ON failed.org_id=st.org_id AND failed.operation_id=st.operation_id AND failed.effect_key=st.effect_key WHERE failed.org_id=o AND failed.operation_id=op AND failed.id=s AND st.ordinal>failed.ordinal ORDER BY st.ordinal FOR UPDATE OF st LOOP
   IF child.state<>'pending' THEN RAISE EXCEPTION 'Invalid successor state';END IF;
   UPDATE inbox_operations.steps SET state='blocked',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND operation_id=op AND id=child.id RETURNING receipt_version INTO v;
   INSERT INTO inbox_operations.receipts VALUES(o,op,child.id,v,child.generation,jsonb_build_object('status','blocked','code','predecessor_failed','predecessor_id',s,'changed',false),clock_timestamp());
  END LOOP;
  RETURN result;
 END IF;
 RETURN inbox_action_api.fail_step(o,op,s,g,terminal_state,code);
 -- 40P01/40001 and other infrastructure failures escape the whole RPC. The
 -- durable runner retries/reconciles the same claim; no ambiguous failure receipt.
END $$;

COMMIT;
