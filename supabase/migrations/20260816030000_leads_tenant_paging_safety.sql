-- Final Leads safety corrections: database-time assignee membership and a
-- whole-filter fingerprint that detects equal-count changes between pages.

create or replace function public.enforce_active_property_assignee_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.assigned_user_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.memberships membership
    where membership.org_id = new.org_id
      and membership.user_id = new.assigned_user_id
      and membership.access_status = 'active'
      and (
        membership.access_expires_at is null
        or membership.access_expires_at > statement_timestamp()
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'INVALID_ASSIGNEE: Assignee must have active access to the property organization';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_active_property_assignee_membership() from public;

drop trigger if exists trg_properties_active_assignee on public.properties;
create trigger trg_properties_active_assignee
before insert or update of assigned_user_id on public.properties
for each row execute function public.enforce_active_property_assignee_membership();

drop function if exists public.get_leads_board_page(
  text, uuid, boolean, text[], text, text, text, boolean, boolean, boolean,
  timestamptz, timestamptz, timestamptz, uuid, integer
);

create function public.get_leads_board_page(
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
returns table (rows jsonb, total_count bigint, snapshot_generation text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with filtered as materialized (
    select b.id, b.next_task_due_at
    from public.leads_board b
    where b.status::text = p_status
      and b.deleted_at is null
      and (
        b.outreach_dispo is null
        or b.outreach_dispo::text not in ('wrong_number', 'bad_number', 'not_interested', 'opted_out', 'dnc')
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
    (select count(*) from filtered),
    (
      select md5(coalesce(string_agg(
        f.id::text || ':' || coalesce(f.next_task_due_at::text, ''),
        ',' order by f.next_task_due_at asc nulls last, f.id asc
      ), ''))
      from filtered f
    );
$$;

revoke all on function public.get_leads_board_page(
  text, uuid, boolean, text[], text, text, text, boolean, boolean, boolean,
  timestamptz, timestamptz, timestamptz, uuid, integer
) from public;
grant execute on function public.get_leads_board_page(
  text, uuid, boolean, text[], text, text, text, boolean, boolean, boolean,
  timestamptz, timestamptz, timestamptz, uuid, integer
) to authenticated, service_role;
