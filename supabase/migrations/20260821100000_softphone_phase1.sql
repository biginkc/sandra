-- Sandra softphone Phase 1: simulated click-to-call data seam.
-- No telephony provider or Jitter call is introduced here.

alter table public.call_activities
  alter column property_id drop not null,
  alter column contact_id drop not null,
  add column if not exists direction text not null default 'outbound',
  add column if not exists phone_e164 text,
  add column if not exists wrap_token uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_activities_direction_check'
      and conrelid = 'public.call_activities'::regclass
  ) then
    alter table public.call_activities
      add constraint call_activities_direction_check
      check (direction in ('outbound', 'inbound'));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_activities_wrap_token_key'
      and conrelid = 'public.call_activities'::regclass
  ) then
    alter table public.call_activities
      add constraint call_activities_wrap_token_key unique (wrap_token);
  end if;
end;
$$;

create index if not exists call_activities_operator_started_idx
  on public.call_activities (operator_user_id, started_at desc nulls last);

-- The urgency migration is already applied in existing environments. Keep
-- that migration byte-for-byte replayable and move the softphone's richer
-- homeowner projection into this forward migration. The JSON type and view
-- column order remain unchanged, so this is safe over both fresh and applied
-- databases.
create or replace view public.leads_board
with (security_invoker = true)
as
select
  p.id,
  p.address,
  p.city,
  p.state,
  p.zip,
  p.market,
  p.status,
  p.is_vacant,
  p.cass_status,
  p.absentee_flag,
  p.assigned_user_id,
  p.motivation_level,
  p.outreach_dispo,
  p.is_dnc_locked,
  p.deleted_at,
  p.created_at,
  case when hc.id is null then null else jsonb_build_object(
    'id', hc.id,
    'first_name', hc.first_name,
    'last_name', hc.last_name,
    'entity_name', hc.entity_name,
    'phone_1', hc.phone_1,
    'phone_2', hc.phone_2,
    'phone_3', hc.phone_3,
    'do_not_contact', hc.do_not_contact,
    'sms_opted_out', hc.sms_opted_out
  ) end as homeowner,
  lower(concat_ws(' ', p.address, p.city, p.state, p.zip, p.market,
    hc.first_name, hc.last_name, hc.entity_name)) as search_text,
  nt.id as next_task_id,
  nt.title as next_task_title,
  nt.due_at as next_task_due_at,
  lm.direction as last_message_direction,
  lm.body as last_message_body,
  lm.created_at as last_message_created_at,
  exists (
    select 1 from public.messages unread
    where unread.property_id = p.id
      and unread.direction = 'inbound'
      and unread.read_at is null
  ) as has_unread,
  exists (
    select 1 from public.sequence_enrollments active_enrollment
    where active_enrollment.property_id = p.id
      and active_enrollment.status = 'active'
  ) as has_active_sequence,
  (
    p.status not in ('under_contract', 'closed', 'dead', 'prospect')
    and exists (
      select 1 from public.messages old_inbound
      where old_inbound.property_id = p.id
        and old_inbound.direction = 'inbound'
        and old_inbound.created_at < now() - interval '7 days'
    )
    and not exists (
      select 1 from public.messages later_outbound
      where later_outbound.property_id = p.id
        and later_outbound.direction = 'outbound'
        and later_outbound.created_at > (
          select max(latest_inbound.created_at)
          from public.messages latest_inbound
          where latest_inbound.property_id = p.id
            and latest_inbound.direction = 'inbound'
        )
    )
  ) as is_stale,
  exists (
    select 1 from public.sequence_enrollments ended
    where ended.property_id = p.id
      and ended.status = 'completed'
      and ended.completed_at < now() - interval '24 hours'
      and not exists (
        select 1 from public.messages after_sequence
        where after_sequence.property_id = p.id
          and after_sequence.direction = 'outbound'
          and after_sequence.created_at > ended.completed_at
      )
  ) as sequence_ended_without_follow_up,
  exists (
    select 1 from public.skip_trace_cache st
    where st.org_id = p.org_id
      and st.address_normalized = array_to_string(
        array(
          select lower(trim(component))
          from unnest(array[p.address, p.city, p.state, p.zip]) as address_parts(component)
          where component is not null and component <> ''
        ),
        '|'
      )
  ) as is_skip_traced,
  hc.sms_opted_out as homeowner_sms_opted_out,
  hc.sms_opted_out_at as homeowner_sms_opted_out_at
from public.properties p
left join public.contacts hc
  on hc.id = p.homeowner_contact_id
  and hc.org_id = p.org_id
left join lateral (
  select t.id, t.title, t.due_at
  from public.tasks t
  where t.related_property_id = p.id
    and t.org_id = p.org_id
    and t.status = 'open'
  order by t.due_at asc, t.id asc
  limit 1
) nt on true
left join lateral (
  select m.direction, m.body, m.created_at
  from public.messages m
  where m.property_id = p.id
  order by m.created_at desc, m.id desc
  limit 1
) lm on true
where p.is_dnc_locked = false;

grant select on public.leads_board to authenticated, service_role;
