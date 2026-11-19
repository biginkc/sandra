-- My Leads unified queue, Phase B1: read one rep-SMS ledger receipt by id for the actor (Broken-item recovery).
-- Same auth, scope and error codes as fn_get_rep_sms_delivery_draft, but selects the exact receipt with no
-- recovery_open/state filter. Read-only.
begin;

create or replace function public.fn_get_rep_sms_delivery_target(p_property_id uuid, p_ledger_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_org uuid;
  v_contact uuid;
  v_enrolled boolean:=false;
  v_ledger public.rep_sms_delivery_ledger%rowtype;
begin
  select p.org_id,p.homeowner_contact_id into v_org,v_contact
    from public.properties p
   where p.id=p_property_id and p.deleted_at is null;
  if v_org is null or auth.uid() is null then
    raise exception 'Lead unavailable' using errcode='42501';
  end if;
  perform public.my_leads_require_read_scope(v_org,auth.uid());
  if not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=auth.uid()
    and (m.acquisitions_enabled or m.role='owner')) then
    raise exception 'Acquisitions access required' using errcode='42501';
  end if;
  if not exists(select 1 from public.my_leads_queue_rows(v_org,auth.uid(),statement_timestamp()) q
    where q.property_id=p_property_id) then
    raise exception 'You can text only leads currently in your queue' using errcode='42501';
  end if;
  select coalesce(e.enabled,false) into v_enrolled
    from public.rep_sms_rollout_enrollments e
   where e.org_id=v_org and e.user_id=auth.uid();
  if not v_enrolled or v_contact is null then
    return jsonb_build_object('target',null);
  end if;
  select * into v_ledger
    from public.rep_sms_delivery_ledger l
   where l.org_id=v_org
     and l.actor_user_id=auth.uid()
     and l.property_id=p_property_id
     and l.id=p_ledger_id;
  if not found then
    return jsonb_build_object('target',null);
  end if;
  return jsonb_build_object('target',jsonb_build_object(
    'key',v_ledger.submission_key,
    'receiptId',v_ledger.id,
    'state',v_ledger.state,
    'assignmentId',v_ledger.sender_assignment_id,
    'from',v_ledger.from_number,
    'to',v_ledger.to_number,
    'body',v_ledger.body,
    'composition',v_ledger.composition,
    'providerError',v_ledger.provider_error,
    'lastPreDispatchFailure',v_ledger.last_pre_dispatch_failure
  ));
end;
$$;
revoke all on function public.fn_get_rep_sms_delivery_target(uuid,uuid) from public,anon,service_role;
grant execute on function public.fn_get_rep_sms_delivery_target(uuid,uuid) to authenticated;

commit;
