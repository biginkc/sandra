-- Keep the Leads urgency strip on the bounded card inputs it actually counts.
-- The original function scanned leads_board, forcing PostgreSQL to evaluate
-- latest-message, unread-message, sequence, and skip-trace projections for
-- every pipeline row even when those optional filters were inactive.

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
  with fast_path as materialized (
    select (
      select task.due_at
      from public.tasks task
      where task.related_property_id = property.id
        and task.org_id = property.org_id
        and task.status = 'open'
      order by task.due_at asc, task.id asc
      limit 1
    ) as next_task_due_at
    from public.properties property
    where coalesce(cardinality(p_search_tokens), 0) = 0
      and p_motivation = 'all'
      and p_attention is null
      and p_no_active_sequence is false
      and p_skip_traced is null
      and property.is_dnc_locked = false
      and property.status::text in (
        'new_lead', 'contacted', 'interested', 'offer_sent',
        'offer_declined', 'under_contract', 'closed', 'dead'
      )
      and property.deleted_at is null
      and (
        property.outreach_dispo is null
        or property.outreach_dispo::text not in ('wrong_number', 'bad_number', 'not_interested', 'dnc')
        or property.status::text not in ('new_lead', 'contacted')
      )
      and (p_assignee_id is null or property.assigned_user_id = p_assignee_id)
      and (not p_unassigned or property.assigned_user_id is null)
      and (not p_unassigned or property.status::text not in ('closed', 'dead'))
      and (not p_hot_only or property.status::text in ('interested', 'offer_sent'))
  ), filtered as materialized (
    select fast.next_task_due_at
    from fast_path fast
    union all
    select (
      select task.due_at
      from public.tasks task
      where task.related_property_id = property.id
        and task.org_id = property.org_id
        and task.status = 'open'
      order by task.due_at asc, task.id asc
      limit 1
    ) as next_task_due_at
    from public.properties property
    left join public.contacts homeowner
      on homeowner.id = property.homeowner_contact_id
      and homeowner.org_id = property.org_id
    where not (
        coalesce(cardinality(p_search_tokens), 0) = 0
        and p_motivation = 'all'
        and p_attention is null
        and p_no_active_sequence is false
        and p_skip_traced is null
      )
      and property.is_dnc_locked = false
      and property.status::text in (
        'new_lead', 'contacted', 'interested', 'offer_sent',
        'offer_declined', 'under_contract', 'closed', 'dead'
      )
      and property.deleted_at is null
      and (
        property.outreach_dispo is null
        or property.outreach_dispo::text not in ('wrong_number', 'bad_number', 'not_interested', 'dnc')
        or property.status::text not in ('new_lead', 'contacted')
      )
      and (p_assignee_id is null or property.assigned_user_id = p_assignee_id)
      and (not p_unassigned or property.assigned_user_id is null)
      and (not p_unassigned or property.status::text not in ('closed', 'dead'))
      and (
        p_motivation = 'all'
        or (p_motivation = 'unset' and property.motivation_level is null)
        or property.motivation_level::text = p_motivation
      )
      and not exists (
        select 1
        from unnest(coalesce(p_search_tokens, array[]::text[])) token
        where position(lower(token) in lower(concat_ws(
          ' ', property.address, property.city, property.state, property.zip,
          property.market, homeowner.first_name, homeowner.last_name,
          homeowner.entity_name
        ))) = 0
      )
      and (
        p_attention is distinct from 'stale'
        or (
          property.status::text not in ('under_contract', 'closed', 'dead', 'prospect')
          and exists (
            select 1
            from public.messages old_inbound
            where old_inbound.property_id = property.id
              and old_inbound.direction = 'inbound'
              and old_inbound.created_at < now() - interval '7 days'
          )
          and not exists (
            select 1
            from public.messages later_outbound
            where later_outbound.property_id = property.id
              and later_outbound.direction = 'outbound'
              and later_outbound.created_at > (
                select max(latest_inbound.created_at)
                from public.messages latest_inbound
                where latest_inbound.property_id = property.id
                  and latest_inbound.direction = 'inbound'
              )
          )
        )
      )
      and (
        p_attention is distinct from 'sequence_ended'
        or exists (
          select 1
          from public.sequence_enrollments ended
          where ended.property_id = property.id
            and ended.status = 'completed'
            and ended.completed_at < now() - interval '24 hours'
            and not exists (
              select 1
              from public.messages after_sequence
              where after_sequence.property_id = property.id
                and after_sequence.direction = 'outbound'
                and after_sequence.created_at > ended.completed_at
            )
        )
      )
      and (
        p_no_active_sequence is false
        or not exists (
          select 1
          from public.sequence_enrollments active_enrollment
          where active_enrollment.property_id = property.id
            and active_enrollment.status = 'active'
        )
      )
      and (
        p_skip_traced is null
        or exists (
          select 1
          from public.skip_trace_cache trace
          where trace.org_id = property.org_id
            and trace.address_normalized = array_to_string(
              array(
                select lower(trim(component))
                from unnest(array[
                  property.address, property.city, property.state, property.zip
                ]) as address_parts(component)
                where component is not null and component <> ''
              ),
              '|'
            )
        ) = p_skip_traced
      )
      and (not p_hot_only or property.status::text in ('interested', 'offer_sent'))
  )
  select
    count(*),
    count(*) filter (where next_task_due_at < p_day_start),
    count(*) filter (
      where next_task_due_at >= p_day_start and next_task_due_at < p_day_end
    ),
    count(*) filter (where next_task_due_at >= p_day_end),
    count(*) filter (where next_task_due_at is null)
  from filtered;
$$;

revoke all on function public.get_leads_board_urgency_counts(
  uuid, boolean, text[], text, text, boolean, boolean, boolean,
  timestamptz, timestamptz
) from public, anon;
grant execute on function public.get_leads_board_urgency_counts(
  uuid, boolean, text[], text, text, boolean, boolean, boolean,
  timestamptz, timestamptz
) to authenticated, service_role;
