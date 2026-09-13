CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_property_step(o uuid, op uuid, s uuid, g bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE step jsonb; payload jsonb; expected jsonb; actual jsonb; requirements jsonb; prior jsonb;
 requester uuid; assignee uuid; property_id uuid; p public.properties; member public.memberships;
 requirement jsonb; revised jsonb; result jsonb; changed boolean; disposition text; entry record;
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
 PERFORM 1 FROM public.memberships WHERE org_id=o AND user_id IN (requester,assignee) ORDER BY user_id FOR SHARE;
 SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=requester;
 IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Requester access revoked';END IF;
 IF assignee IS NOT NULL THEN
  SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=assignee;
  IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 END IF;
 SELECT * INTO p FROM public.properties WHERE org_id=o AND id=property_id FOR UPDATE;
 IF NOT FOUND OR p.deleted_at IS NOT NULL OR p.is_training OR p.is_dnc_locked THEN RAISE EXCEPTION 'Property ineligible';END IF;
 IF EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i USING(org_id,operation_id) WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.id=m.item_id AND (i.exclusion_code IS NOT NULL OR (i.resolution->>'property_id')::uuid IS DISTINCT FROM property_id)) THEN RAISE EXCEPTION 'Invalid property mapping';END IF;
 expected:=step->'original_dependencies'->'policy';
 IF expected->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing policy vector';END IF;
 prior:=step->'predecessor_result';
 -- Only revisions expressly returned by this adapter may replace earlier values.
 IF prior IS NOT NULL AND prior<>'null'::jsonb THEN
  IF prior->>'property_id' IS DISTINCT FROM property_id::text OR jsonb_typeof(prior->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid predecessor receipt';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(prior->'revised_dependencies') LOOP
   IF revised->>'namespace' NOT IN ('property_outcome','property_assignment','property_reviews') OR revised->'key' IS DISTINCT FROM jsonb_build_array(property_id) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Invalid revised dependency';END IF;
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
  IF disposition IS NULL OR disposition NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture') THEN RAISE EXCEPTION 'Restrictive outcome adapter required';END IF;
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
 SELECT coalesce(jsonb_agg(d ORDER BY d->>'namespace',(d->'key')::text),'[]'::jsonb) INTO revised FROM jsonb_array_elements(actual->'dependencies') d WHERE d->>'namespace' IN ('property_outcome','property_assignment','property_reviews') AND d->'key'=jsonb_build_array(property_id);
 result:=jsonb_build_object('property_id',property_id,'action',step->>'action','changed',changed,'before',jsonb_build_object('outcome',p.outreach_dispo,'assignee',p.assigned_user_id,'follow_up_at',p.follow_up_at),'after',(SELECT jsonb_build_object('outcome',outreach_dispo,'assignee',assigned_user_id,'follow_up_at',follow_up_at) FROM public.properties WHERE id=property_id AND org_id=o),'revised_dependencies',revised);
 -- Recheck wall-clock authorization after source work; locks alone do not freeze time.
 IF EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id IN(requester,assignee) AND access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Access expired during effect';END IF;
 PERFORM inbox_operations.finish_step(o,op,s,g,result);
 RETURN result;
END $function$
