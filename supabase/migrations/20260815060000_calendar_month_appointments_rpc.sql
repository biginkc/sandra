-- fn_calendar_month_appointments — single-snapshot month read for the
-- Calendar page's month view (Codex month-view round 3).
--
-- Why an RPC: the month grid spans 5-6 weeks. One PostgREST SELECT over
-- the whole range can't distinguish "a busy month" from "a busy week"
-- under the response ceiling, and issuing one SELECT per week runs each
-- window in its OWN read-committed snapshot — an appointment rescheduled
-- mid-fetch between windows can be omitted by every window or returned by
-- two of them. This function is LANGUAGE SQL with a single top-level
-- statement, so every window predicate is evaluated against ONE snapshot,
-- and the per-week volume checks happen inside that same snapshot.
--
-- Volume contract (mirrors queries.ts's APPOINTMENTS_CAP=900/week):
--   * any single week window holding more than p_week_cap rows, or
--   * the whole month holding more than p_total_cap rows (kept under
--     PostgREST's 1000-row response ceiling so the result is never
--     silently truncated in transit),
-- makes the function RAISE (SQLSTATE P0001, message below) — the caller
-- renders the same explicit fail-closed retry state week view uses,
-- never a silently truncated month.
--
-- SECURITY INVOKER on purpose: RLS scopes rows exactly like the direct
-- week SELECT; callers gain no visibility they don't already have.

begin;

-- RAISE helper (defined FIRST — the SQL reader body below references it
-- at creation time under check_function_bodies): LANGUAGE SQL bodies
-- can't RAISE directly, so the volume breach routes through this.
-- VOLATILE on purpose — an IMMUTABLE zero-arg raising function would be
-- constant-folded at plan time and abort every call unconditionally.

create or replace function public.fn_calendar_month_volume_exceeded()
returns boolean
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  raise exception 'calendar month volume exceeds cap'
    using errcode = 'P0001';
end;
$$;

create or replace function public.fn_calendar_month_appointments(
  p_org uuid,
  p_assignee uuid default null,
  p_week_starts timestamptz[] default '{}',
  p_week_ends timestamptz[] default '{}',
  p_week_cap integer default 900,
  p_total_cap integer default 999
)
returns table (
  id uuid,
  title text,
  description text,
  due_at timestamptz,
  end_at timestamptz,
  status text,
  outcome text,
  assignee_id uuid,
  related_property_id uuid,
  contact_id uuid,
  property_address text,
  property_city text,
  property_state text,
  property_deleted_at timestamptz,
  contact_first_name text,
  contact_last_name text,
  contact_entity_name text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with windows as (
    select w_start, w_end
    from unnest(p_week_starts, p_week_ends) as w(w_start, w_end)
    where w_start is not null and w_end is not null
  ),
  matched as (
    select
      t.id, t.title, t.description, t.due_at, t.end_at, t.status, t.outcome,
      t.assignee_id, t.related_property_id, t.contact_id,
      w.w_start
    from public.tasks t
    join windows w on t.due_at >= w.w_start and t.due_at < w.w_end
    where t.org_id = p_org
      and t.type = 'appointment'
      and t.status in ('open', 'completed')
      and (p_assignee is null or t.assignee_id = p_assignee)
  ),
  guarded as (
    select
      m.*,
      count(*) over (partition by m.w_start) as window_rows,
      count(*) over () as total_rows
    from matched m
  )
  select
    g.id, g.title, g.description, g.due_at, g.end_at, g.status, g.outcome,
    g.assignee_id, g.related_property_id, g.contact_id,
    p.address, p.city, p.state, p.deleted_at,
    c.first_name, c.last_name, c.entity_name
  from guarded g
  left join public.properties p on p.id = g.related_property_id
  left join public.contacts c on c.id = g.contact_id
  where case
    when g.window_rows > p_week_cap or g.total_rows > p_total_cap
      then public.fn_calendar_month_volume_exceeded()
    else true
  end
  order by g.due_at asc, g.id asc
$$;

revoke all on function public.fn_calendar_month_appointments(uuid, uuid, timestamptz[], timestamptz[], integer, integer) from public, anon;
grant execute on function public.fn_calendar_month_appointments(uuid, uuid, timestamptz[], timestamptz[], integer, integer) to authenticated, service_role;
revoke all on function public.fn_calendar_month_volume_exceeded() from public, anon;
grant execute on function public.fn_calendar_month_volume_exceeded() to authenticated, service_role;

commit;
