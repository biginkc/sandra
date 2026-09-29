begin;

-- Use the same property/episode/status boundary as my_leads_queue_rows. This
-- returns identifiers only; the application reads drip details through RLS.
create or replace function public.fn_list_my_leads_drip_scope(p_org_id uuid, p_member_id uuid)
returns table(property_id uuid, stage text, in_drip boolean, replied_at timestamptz, search_text text, row_data jsonb)
language plpgsql security definer set search_path = ''
set statement_timeout = '5s' as $$
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  return query
  with owned as (
    select r.property_id as id, r.stage as queue_stage, r.search_text as search_value, r.row_data
    from public.my_leads_queue_rows(p_org_id, p_member_id, statement_timestamp()) r
  ), newest as (
    select distinct on (e.property_id) e.property_id, e.id, e.status, e.pause_reason
    from public.sequence_enrollments e join owned o on o.id = e.property_id
    where e.org_id = p_org_id
    order by e.property_id,
      case when e.status in ('active', 'paused') then 0 else 1 end,
      e.enrolled_at desc, e.id desc
  ), facts as (
    select o.id, o.queue_stage, o.search_value, o.row_data, (n.status = 'active') as active_drip,
      case when n.status = 'paused' and n.pause_reason = 'inbound_reply'
        then (select max(m.created_at) from public.messages m
          where m.org_id = p_org_id and m.property_id = o.id and m.direction = 'inbound')
      end as latest_reply
    from owned o join newest n on n.property_id = o.id
  )
  select f.id, f.queue_stage, f.active_drip,
    case when f.latest_reply is not null and not exists (
      select 1 from public.messages m where m.org_id = p_org_id and m.property_id = f.id
        and m.direction = 'outbound' and m.campaign_id is null
        and not (m.metadata ? 'generated_by') and m.created_at > f.latest_reply
        and not exists (select 1 from public.sequence_step_runs r where r.message_id = m.id)
    ) and not exists (
      select 1 from public.acquisition_attempts a where a.org_id = p_org_id and a.property_id = f.id
        and a.recorded_at > f.latest_reply
    ) and not exists (
      select 1 from public.lead_events l where l.org_id = p_org_id and l.property_id = f.id
        and l.actor_type = 'user' and l.created_at > f.latest_reply
        and (l.event_type = 'dispo_set' or (l.event_type = 'my_leads_workflow'
          and l.payload->>'operation' in ('ready_acquisition_offer', 'log_acquisition_offer',
            'record_acquisition_contract', 'decline_acquisition_offer', 'handoff_acquisition_lead',
            'log_acquisition_attempt')))
    ) then f.latest_reply end,
    f.search_value, f.row_data
  from facts f where f.active_drip or f.latest_reply is not null;
end;
$$;
revoke all on function public.fn_list_my_leads_drip_scope(uuid, uuid) from public, anon;
grant execute on function public.fn_list_my_leads_drip_scope(uuid, uuid) to authenticated;
commit;
