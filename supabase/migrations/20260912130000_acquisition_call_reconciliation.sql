-- Reconcile either arrival order without creating attempts from wrap-up evidence.
begin;
create or replace function public.my_leads_reconcile_call(p_org uuid,p_jitter_id text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_jitter_id is null or p_jitter_id='' then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text||':acquisition-finalize:'||p_jitter_id,0));
  update public.acquisition_attempts a set
    call_activity_id=c.id,
    outcome=coalesce(a.outcome,case c.outcome when 'connected_human' then 'reached' when 'no_answer' then 'no_answer' when 'voicemail' then 'no_answer' when 'busy' then 'no_answer' end),
    note=coalesce(a.note,nullif(btrim(c.notes),''))
  from public.acquisition_commands r,public.call_activities c
  where r.org_id=p_org and r.operation='record_call_start' and r.result->>'jitterCallId'=p_jitter_id
    and a.command_id=r.id and a.org_id=p_org and a.source='sandra'
    and c.org_id=p_org and c.property_id=a.property_id and c.provider='sandra_softphone'
    and c.jitter_attempt_id='sandra-'||p_jitter_id
    and c.operator_user_id=a.actor_user_id
    and c.provider_call_id=r.result->>'sellerProviderCallId'
    and (a.call_activity_id is null or a.call_activity_id=c.id);
end;
$$;
revoke all on function public.my_leads_reconcile_call(uuid,text) from public,anon,authenticated,service_role;
create or replace function public.my_leads_reconcile_activity_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.provider='sandra_softphone' and new.jitter_attempt_id like 'sandra-%' then
    perform public.my_leads_reconcile_call(new.org_id,substr(new.jitter_attempt_id,8));
  end if;
  return new;
end;
$$;
create or replace function public.my_leads_reconcile_receipt_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.operation='record_call_start' and new.result->>'jitterCallId' is not null then
    perform public.my_leads_reconcile_call(new.org_id,new.result->>'jitterCallId');
  end if;
  return new;
end;
$$;
revoke all on function public.my_leads_reconcile_activity_trigger() from public,anon,authenticated,service_role;
revoke all on function public.my_leads_reconcile_receipt_trigger() from public,anon,authenticated,service_role;
create or replace function public.my_leads_guard_linked_call_identity()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.acquisition_attempts a join public.acquisition_commands r on r.id=a.command_id
    where a.call_activity_id=old.id and a.source='sandra' and
      (new.org_id is distinct from a.org_id or new.property_id is distinct from a.property_id
       or new.operator_user_id is distinct from a.actor_user_id or new.provider is distinct from 'sandra_softphone'
       or new.jitter_attempt_id is distinct from 'sandra-'||(r.result->>'jitterCallId')
       or new.provider_call_id is distinct from r.result->>'sellerProviderCallId')) then
    raise exception 'ACQUISITION_CALL_IDENTITY_CONFLICT' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.my_leads_guard_linked_call_identity() from public,anon,authenticated,service_role;
create trigger acquisition_linked_call_identity before update on public.call_activities
  for each row execute function public.my_leads_guard_linked_call_identity();
create trigger acquisition_activity_reconcile after insert or update on public.call_activities
  for each row execute function public.my_leads_reconcile_activity_trigger();
create trigger acquisition_receipt_reconcile after insert or update of result on public.acquisition_commands
  for each row execute function public.my_leads_reconcile_receipt_trigger();
-- Only the original caller may supply an explicit outcome for an evidenced call.
create or replace function public.fn_finalize_acquisition_attempt(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_org uuid:=(p_input->>'orgId')::uuid;
  v_actor uuid:=auth.uid();
  v_key uuid:=(p_input->>'idempotencyKey')::uuid;
  v_activity uuid:=(p_input->>'callActivityId')::uuid;
  v_attempt public.acquisition_attempts%rowtype;
  v_receipt public.acquisition_commands%rowtype;
  v_hash text;
  v_result jsonb;
begin
  if v_actor is null or not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=v_actor
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if v_key is null or v_activity is null or (p_input->>'outcome') is null or (p_input->>'outcome') not in ('reached','no_answer','wrong_number') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if nullif(btrim(p_input->>'recordingUrl'),'') is not null and
    (length(p_input->>'recordingUrl')>4096 or (p_input->>'recordingUrl') !~* '^https?://[^[:space:]]+$') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  v_hash:=public.my_leads_command_hash('finalize_acquisition_attempt',v_org,v_actor,p_input);
  perform pg_advisory_xact_lock(hashtextextended(v_org::text||':finalize-command:'||v_key::text,0));
  select * into v_receipt from public.acquisition_commands where org_id=v_org and operation='finalize_acquisition_attempt' and idempotency_key=v_key;
  if found then
    if v_receipt.request_hash is distinct from v_hash then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='40001'; end if;
    return jsonb_set(v_receipt.result,'{duplicate}','true');
  end if;
  select * into v_attempt from public.acquisition_attempts where org_id=v_org and call_activity_id=v_activity
    and property_id=(p_input->>'propertyId')::uuid and source='sandra' and actor_user_id=v_actor for update;
  if not found then raise exception 'PROVIDER_EVIDENCE_PENDING' using errcode='42501'; end if;
  if v_attempt.outcome is not null and v_attempt.outcome is distinct from p_input->>'outcome' then raise exception 'STALE_STATE' using errcode='40001'; end if;
  update public.acquisition_attempts set outcome=p_input->>'outcome',note=coalesce(nullif(btrim(p_input->>'note'),''),note),
    recording_url=coalesce(nullif(btrim(p_input->>'recordingUrl'),''),recording_url) where id=v_attempt.id;
  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_attempt.property_id,'attemptId',v_attempt.id);
  insert into public.acquisition_commands(org_id,actor_kind,actor_user_id,operation,idempotency_key,request_hash,result)
    values(v_org,'user',v_actor,'finalize_acquisition_attempt',v_key,v_hash,v_result);
  return v_result;
end;
$$;
revoke all on function public.fn_finalize_acquisition_attempt(jsonb) from public,anon,service_role;
grant execute on function public.fn_finalize_acquisition_attempt(jsonb) to authenticated;
create or replace function public.fn_get_acquisition_call_references(p_org_id uuid,p_property_id uuid,p_member_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=auth.uid()
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if not exists(select 1 from public.properties p where p.id=p_property_id and p.org_id=p_org_id
    and p.assigned_user_id=p_member_id and p.deleted_at is null) then
    raise exception 'STALE_ASSIGNMENT' using errcode='42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',a.call_activity_id,'occurredAt',a.occurred_at) order by a.occurred_at desc),'[]')
    from (select call_activity_id,occurred_at from public.acquisition_attempts where org_id=p_org_id and property_id=p_property_id
      and actor_user_id=auth.uid() and source='sandra' and outcome is null and call_activity_id is not null order by occurred_at desc limit 20) a);
end;
$$;
revoke all on function public.fn_get_acquisition_call_references(uuid,uuid,uuid) from public,anon,service_role;
grant execute on function public.fn_get_acquisition_call_references(uuid,uuid,uuid) to authenticated;
commit;
