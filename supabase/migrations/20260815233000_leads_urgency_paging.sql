-- Leads urgency read model and concurrency-safe inline next-action creation.
-- This migration is forward-only and intentionally leaves historical task rows intact.

alter table public.tasks
  add column if not exists lead_next_action_idempotency_key uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_lead_next_action_follow_up_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_lead_next_action_follow_up_check
      check (lead_next_action_idempotency_key is null or type = 'follow_up');
  end if;
end;
$$;

create unique index if not exists idx_tasks_org_lead_next_action_idempotency
  on public.tasks (org_id, lead_next_action_idempotency_key)
  where lead_next_action_idempotency_key is not null;

create index if not exists idx_tasks_property_open_due_id
  on public.tasks (related_property_id, due_at, id)
  where status = 'open';

create index if not exists idx_messages_property_direction_created
  on public.messages (property_id, direction, created_at desc)
  where property_id is not null;

create index if not exists idx_messages_property_created_id
  on public.messages (property_id, created_at desc, id desc)
  where property_id is not null;

-- The board views expose only the bounded card read model. The earliest open
-- task uses due_at then id so both paging and two equal-time tasks are stable.
drop view if exists public.leads_unskip_traced;
drop view if exists public.leads_board;

create view public.leads_board
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
  ) as is_skip_traced
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

create view public.leads_unskip_traced
with (security_invoker = true)
as
select b.*
from public.leads_board b
where b.is_dnc_locked = false
  and b.is_skip_traced = false;

grant select on public.leads_board, public.leads_unskip_traced
  to authenticated, service_role;

-- Return one column page and its pre-cursor exact count from one statement.
-- The materialized filtered set is the snapshot contract: rows and count can
-- never describe two different committed states.
create or replace function public.get_leads_board_page(
  p_status text,
  p_assignee_id uuid,
  p_unassigned boolean,
  p_search_tokens text[],
  p_motivation text,
  p_urgency text,
  p_attention text,
  p_hot_only boolean,
  p_no_active_sequence boolean,
  p_skip_traced boolean,
  p_day_start timestamptz,
  p_day_end timestamptz,
  p_cursor_due_at timestamptz,
  p_cursor_id uuid,
  p_limit integer
)
returns table (rows jsonb, total_count bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with filtered as materialized (
    -- Keep this set narrow. In particular, do not materialize the view's
    -- latest-message body for every matching lead before paging.
    select b.id, b.next_task_due_at
    from public.leads_board b
    where b.status::text = p_status
      and b.deleted_at is null
      and (
        b.outreach_dispo is null
        or b.outreach_dispo::text not in ('wrong_number', 'bad_number', 'not_interested', 'dnc')
        or b.status::text not in ('new_lead', 'contacted')
      )
      and (p_assignee_id is null or b.assigned_user_id = p_assignee_id)
      and (not p_unassigned or b.assigned_user_id is null)
      and (not p_unassigned or b.status::text not in ('closed', 'dead'))
      and (
        p_motivation = 'all'
        or (p_motivation = 'unset' and b.motivation_level is null)
        or b.motivation_level::text = p_motivation
      )
      and not exists (
        select 1
        from unnest(coalesce(p_search_tokens, array[]::text[])) token
        where position(lower(token) in coalesce(b.search_text, '')) = 0
      )
      and (p_attention is distinct from 'stale' or b.is_stale)
      and (p_attention is distinct from 'sequence_ended' or b.sequence_ended_without_follow_up)
      and (not p_no_active_sequence or not b.has_active_sequence)
      and (p_skip_traced is null or b.is_skip_traced = p_skip_traced)
      and (not p_hot_only or b.status::text in ('interested', 'offer_sent'))
      and (
        p_urgency = 'all'
        or (p_urgency = 'overdue' and b.next_task_due_at < p_day_start)
        or (p_urgency = 'today' and b.next_task_due_at >= p_day_start and b.next_task_due_at < p_day_end)
        or (p_urgency = 'scheduled' and b.next_task_due_at >= p_day_end)
        or (p_urgency = 'none' and b.next_task_due_at is null)
      )
  ), page_keys as materialized (
    select f.*
    from filtered f
    where p_cursor_id is null
      or (
        p_cursor_due_at is not null
        and (
          f.next_task_due_at > p_cursor_due_at
          or (f.next_task_due_at = p_cursor_due_at and f.id > p_cursor_id)
          or f.next_task_due_at is null
        )
      )
      or (p_cursor_due_at is null and f.next_task_due_at is null and f.id > p_cursor_id)
    order by f.next_task_due_at asc nulls last, f.id asc
    limit least(greatest(coalesce(p_limit, 1), 1), 101)
  )
  select
    coalesce(
      (
        select jsonb_agg(to_jsonb(card) order by page_key.next_task_due_at asc nulls last, page_key.id asc)
        from page_keys page_key
        join public.leads_board card on card.id = page_key.id
      ),
      '[]'::jsonb
    ),
    (select count(*) from filtered);
$$;

-- Counts intentionally omit only the urgency dimension. Every other active
-- board filter is shared with the page query, so the strip remains truthful.
create or replace function public.get_leads_board_urgency_counts(
  p_assignee_id uuid,
  p_unassigned boolean,
  p_search_tokens text[],
  p_motivation text,
  p_attention text,
  p_hot_only boolean,
  p_no_active_sequence boolean,
  p_skip_traced boolean,
  p_day_start timestamptz,
  p_day_end timestamptz
)
returns table (
  all_count bigint,
  overdue_count bigint,
  today_count bigint,
  scheduled_count bigint,
  no_action_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    count(*),
    count(*) filter (where b.next_task_due_at < p_day_start),
    count(*) filter (where b.next_task_due_at >= p_day_start and b.next_task_due_at < p_day_end),
    count(*) filter (where b.next_task_due_at >= p_day_end),
    count(*) filter (where b.next_task_due_at is null)
  from public.leads_board b
  where b.status::text in ('new_lead', 'contacted', 'interested', 'offer_sent', 'offer_declined', 'under_contract', 'closed', 'dead')
    and b.deleted_at is null
    and (
      b.outreach_dispo is null
      or b.outreach_dispo::text not in ('wrong_number', 'bad_number', 'not_interested', 'dnc')
      or b.status::text not in ('new_lead', 'contacted')
    )
    and (p_assignee_id is null or b.assigned_user_id = p_assignee_id)
    and (not p_unassigned or b.assigned_user_id is null)
    and (not p_unassigned or b.status::text not in ('closed', 'dead'))
    and (
      p_motivation = 'all'
      or (p_motivation = 'unset' and b.motivation_level is null)
      or b.motivation_level::text = p_motivation
    )
    and not exists (
      select 1
      from unnest(coalesce(p_search_tokens, array[]::text[])) token
      where position(lower(token) in coalesce(b.search_text, '')) = 0
    )
    and (p_attention is distinct from 'stale' or b.is_stale)
    and (p_attention is distinct from 'sequence_ended' or b.sequence_ended_without_follow_up)
    and (not p_no_active_sequence or not b.has_active_sequence)
    and (p_skip_traced is null or b.is_skip_traced = p_skip_traced)
    and (not p_hot_only or b.status::text in ('interested', 'offer_sent'));
$$;

-- Unfiltered stage totals let each column distinguish the currently matching
-- queue from the full pipeline without loading the full pipeline.
create or replace function public.get_leads_board_stage_counts()
returns table (status text, total_count bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select b.status::text, count(*)
  from public.leads_board b
  where b.status::text in ('new_lead', 'contacted', 'interested', 'offer_sent', 'offer_declined', 'under_contract', 'closed', 'dead')
    and b.deleted_at is null
    and (
      b.outreach_dispo is null
      or b.outreach_dispo::text not in ('wrong_number', 'bad_number', 'not_interested', 'dnc')
      or b.status::text not in ('new_lead', 'contacted')
    )
  group by b.status;
$$;

revoke all on function public.get_leads_board_page(text, uuid, boolean, text[], text, text, text, boolean, boolean, boolean, timestamptz, timestamptz, timestamptz, uuid, integer) from public;
revoke all on function public.get_leads_board_urgency_counts(uuid, boolean, text[], text, text, boolean, boolean, boolean, timestamptz, timestamptz) from public;
revoke all on function public.get_leads_board_stage_counts() from public;
grant execute on function public.get_leads_board_page(text, uuid, boolean, text[], text, text, text, boolean, boolean, boolean, timestamptz, timestamptz, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.get_leads_board_urgency_counts(uuid, boolean, text[], text, text, boolean, boolean, boolean, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.get_leads_board_stage_counts() to authenticated, service_role;

create or replace function public.set_lead_next_action(
  p_property_id uuid,
  p_due_at timestamptz,
  p_idempotency_key uuid
)
returns table (
  id uuid,
  org_id uuid,
  assignee_id uuid,
  related_property_id uuid,
  type text,
  status text,
  title text,
  due_at timestamptz,
  created_by uuid,
  created_at timestamptz,
  was_created boolean
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  lead_row public.properties%rowtype;
  task_row public.tasks%rowtype;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED: Sign in to set a next action';
  end if;
  if p_due_at is null then
    raise exception using errcode = '22007', message = 'INVALID_DUE_AT: Choose a valid due date';
  end if;
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED: Retry token is required';
  end if;

  -- Tenant authorization is checked before replay, while mutable lead state
  -- is deliberately checked afterward. A committed request can therefore be
  -- faithfully replayed even if DNC/deletion changed after its response was
  -- lost.
  select p.* into lead_row
  from public.properties p
  where p.id = p_property_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND: Lead not found';
  end if;
  if not exists (
    select 1 from public.memberships membership
    where membership.org_id = lead_row.org_id
      and membership.user_id = actor_id
  ) then
    raise exception using errcode = '42501', message = 'LEAD_FORBIDDEN: You do not have access to this lead';
  end if;

  select t.* into task_row
  from public.tasks t
  where t.org_id = lead_row.org_id
    and t.lead_next_action_idempotency_key = p_idempotency_key;
  if found then
    if task_row.related_property_id is distinct from lead_row.id
      or task_row.created_by is distinct from actor_id
      or task_row.type <> 'follow_up'
      or task_row.due_at is distinct from p_due_at
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_CONFLICT: Retry token belongs to a different request';
    end if;
    return query select task_row.id, task_row.org_id, task_row.assignee_id,
      task_row.related_property_id, task_row.type, task_row.status,
      task_row.title, task_row.due_at, task_row.created_by,
      task_row.created_at, false;
    return;
  end if;

  -- Serialize new attempts for one lead. DNC ratcheting uses the same
  -- property row, so either the lock wins or the task creation wins.
  select p.* into lead_row
  from public.properties p
  where p.id = p_property_id
  for no key update;

  if not found or lead_row.deleted_at is not null then
    raise exception using errcode = 'P0002', message = 'LEAD_NOT_FOUND: Lead not found';
  end if;
  if lead_row.is_dnc_locked then
    raise exception using errcode = 'P0001', message = 'DNC_LOCKED: This lead is permanently read-only';
  end if;
  if lead_row.status = 'prospect' then
    raise exception using errcode = '22023', message = 'NOT_A_LEAD: Promote this prospect before setting a lead action';
  end if;

  select t.* into task_row
  from public.tasks t
  where t.org_id = lead_row.org_id
    and t.related_property_id = lead_row.id
    and t.status = 'open'
  order by t.due_at asc, t.id asc
  limit 1;
  if found then
    return query select task_row.id, task_row.org_id, task_row.assignee_id,
      task_row.related_property_id, task_row.type, task_row.status,
      task_row.title, task_row.due_at, task_row.created_by,
      task_row.created_at, false;
    return;
  end if;

  insert into public.tasks (
    org_id, assignee_id, related_property_id, type, status, title, due_at,
    created_by, lead_next_action_idempotency_key
  ) values (
    lead_row.org_id, actor_id, lead_row.id, 'follow_up', 'open',
    'Follow up on ' || lead_row.address, p_due_at, actor_id, p_idempotency_key
  ) returning * into task_row;

  return query select task_row.id, task_row.org_id, task_row.assignee_id,
    task_row.related_property_id, task_row.type, task_row.status,
    task_row.title, task_row.due_at, task_row.created_by,
    task_row.created_at, true;
end;
$$;

revoke all on function public.set_lead_next_action(uuid, timestamptz, uuid) from public;
grant execute on function public.set_lead_next_action(uuid, timestamptz, uuid)
  to authenticated, service_role;
