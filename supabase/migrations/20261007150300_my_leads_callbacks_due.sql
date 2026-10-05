-- My Leads one-call close, P2 UI (2.8): callback-due alert read model.
--
-- Read-only, authenticated, personal: the caller's own open phone appointments due within the
-- lookahead (default 2 minutes) or late by at most the grace (default 60 minutes), on leads still
-- assigned to them with an open episode, not DNC-locked, not closed/dead. Past the grace the
-- appointment stays tier-1 "overdue" in the Call-next strip; the alert is only for "now". No
-- unattended dialing happens anywhere: the banner it feeds offers one Call button.
--
-- NO data step. Inert until callback_alert is on and schemaReady('callbacks_due') is true.
begin;

create or replace function public.fn_my_leads_callbacks_due(
  p_org_id uuid,
  p_lookahead interval default interval '2 minutes',
  p_grace interval default interval '60 minutes'
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_items jsonb;
begin
  if p_org_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform public.my_leads_require_read_scope(p_org_id, v_uid);
  select coalesce(jsonb_agg(jsonb_build_object(
           'taskId', t.id, 'propertyId', t.related_property_id, 'dueAt', t.due_at, 'title', t.title,
           'minutesLate', greatest(0, floor(extract(epoch from (v_now - t.due_at)) / 60))::int)
           order by t.due_at, t.id), '[]'::jsonb)
  into v_items
  from public.tasks t
  join public.properties p on p.id = t.related_property_id and p.org_id = t.org_id
  where t.org_id = p_org_id
    and t.assignee_id = v_uid
    and t.next_step_kind = 'appointment'
    and t.mode = 'phone'
    and t.status = 'open'
    and t.due_at between v_now - coalesce(p_grace, interval '60 minutes') and v_now + coalesce(p_lookahead, interval '2 minutes')
    and p.assigned_user_id = v_uid
    and p.deleted_at is null
    and not coalesce(p.is_dnc_locked, false)
    and p.status not in ('closed', 'dead', 'dnc')
    and exists (select 1 from public.acquisition_assignment_episodes e
                where e.org_id = p_org_id and e.property_id = p.id and e.ended_at is null and e.assignee_user_id = v_uid);
  return v_items;
end;
$$;
revoke all on function public.fn_my_leads_callbacks_due(uuid, interval, interval) from public, anon, service_role;
grant execute on function public.fn_my_leads_callbacks_due(uuid, interval, interval) to authenticated;

commit;
