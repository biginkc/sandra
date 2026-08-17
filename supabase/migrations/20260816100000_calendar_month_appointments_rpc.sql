-- fn_calendar_month_appointments — single-snapshot window read for both the
-- Calendar page's week view (one window) and month view (six windows).
--
-- Why an RPC: the month grid spans a fixed 6 weeks. One PostgREST SELECT over
-- the whole range can't distinguish "a busy month" from "a busy week"
-- under the response ceiling, and issuing one SELECT per week runs each
-- window in its OWN read-committed snapshot — an appointment rescheduled
-- mid-fetch between windows can be omitted by every window or returned by
-- two of them. The read below is ONE statement (RETURN QUERY), so every
-- window predicate and both volume checks evaluate against one snapshot.
--
-- Input hardening (round 4 — every authenticated user can call this):
--   * caps are SERVER-OWNED upper bounds: p_week_cap/p_total_cap are
--     clamped with LEAST(...) so a caller can only TIGHTEN them (lowering
--     is semantically "return an error sooner on my own query" — harmless,
--     and what the integration tests use); NULL falls back to the server
--     defaults; nothing a caller sends can lift the result above
--     PostgREST's 1000-row response ceiling.
--   * windows are validated BEFORE any tasks read: equal-length arrays,
--     1..6 windows, no NULL bounds, each window 0 < span <= 8 days (a
--     zone-local week is 7 days +/- DST), strictly ordered and
--     NON-OVERLAPPING (each start >= the previous end). Repeated or
--     overlapping windows would multiply matched rows and shared-database
--     work before the counts could raise; malformed arrays would
--     previously be NULL-padded by multi-array unnest and silently
--     dropped, letting a malformed caller read an incomplete month as
--     success. All violations RAISE P0001 before touching tasks.
--
-- Volume contract (mirrors queries.ts's APPOINTMENTS_CAP=900/week): any
-- single window over the (clamped) week cap, or a month total over the
-- (clamped) total cap, RAISEs — the caller renders the same explicit
-- fail-closed retry state week view uses, never a silently truncated
-- month.
--
-- SECURITY INVOKER on purpose: RLS scopes rows exactly like the direct
-- week SELECT; callers gain no visibility they don't already have. RLS's
-- legacy membership predicate is not a lifecycle authorization boundary,
-- though, so authenticated calls also require an active, unexpired,
-- not-deletion-prepared membership in the requested organization. The
-- service_role and raw-postgres migration/test paths retain their existing
-- access because the explicit gate applies only to current_user
-- `authenticated`.

begin;

-- Round-4 rework note: the round-3 shape of this function shipped only to
-- sandra-crm-test (hand-applied during development; the migration was
-- never merged) with this same 6-parameter signature. It is dropped and
-- recreated transactionally below because the final result-row shape adds
-- property_is_dnc_locked. The separate RAISE helper the LANGUAGE SQL body
-- needed is gone — plpgsql raises directly.
drop function if exists public.fn_calendar_month_volume_exceeded();
-- The development-only test deployment had the previous RETURNS TABLE
-- shape. PostgreSQL cannot add an OUT column through CREATE OR REPLACE, so
-- drop the same input signature before recreating it with DNC state.
drop function if exists public.fn_calendar_month_appointments(
  uuid, uuid, timestamptz[], timestamptz[], integer, integer
);

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
  property_is_dnc_locked boolean,
  contact_first_name text,
  contact_last_name text,
  contact_entity_name text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  -- Server-owned ceilings: LEAST() means caller input can only tighten.
  v_week_cap integer := least(coalesce(p_week_cap, 900), 900);
  v_total_cap integer := least(coalesce(p_total_cap, 999), 999);
  v_count integer;
  i integer;
begin
  if current_user = 'authenticated'
     and not exists (
       select 1
       from public.memberships m
       where m.user_id = auth.uid()
         and m.org_id = p_org
         and m.access_status = 'active'
         and m.deletion_prepared_at is null
         and (m.access_expires_at is null or m.access_expires_at > now())
     )
  then
    raise exception 'calendar month: caller has no active membership in org %', p_org
      using errcode = '42501';
  end if;

  if p_week_starts is null or p_week_ends is null then
    raise exception 'calendar month windows are required' using errcode = 'P0001';
  end if;
  v_count := coalesce(array_length(p_week_starts, 1), 0);
  if v_count <> coalesce(array_length(p_week_ends, 1), 0) then
    raise exception 'calendar month window arrays must be equal length'
      using errcode = 'P0001';
  end if;
  if v_count < 1 or v_count > 6 then
    raise exception 'calendar month requires 1..6 windows' using errcode = 'P0001';
  end if;
  for i in 1..v_count loop
    if p_week_starts[i] is null or p_week_ends[i] is null then
      raise exception 'calendar month window bounds must be non-null'
        using errcode = 'P0001';
    end if;
    if p_week_ends[i] <= p_week_starts[i]
       or p_week_ends[i] - p_week_starts[i] > interval '8 days' then
      raise exception 'calendar month window span must be within (0, 8] days'
        using errcode = 'P0001';
    end if;
    if i > 1 and p_week_starts[i] < p_week_ends[i - 1] then
      raise exception 'calendar month windows must be ordered and non-overlapping'
        using errcode = 'P0001';
    end if;
  end loop;

  -- Single statement = single snapshot for every window AND both counts.
  return query
  with windows as (
    select w.w_start, w.w_end
    from unnest(p_week_starts, p_week_ends) as w(w_start, w_end)
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
      -- Preserve completed/rescheduled task rows as lifecycle audit history,
      -- including permanently DNC-locked history, while suppressing stale
      -- predecessor cards once this organization+chain has been cancelled.
      -- The cancelled row itself is already excluded by the status predicate.
      and not (
        t.status = 'completed'
        and t.outcome = 'rescheduled'
        and exists (
          select 1
          from public.tasks cancelled
          where cancelled.org_id = t.org_id
            and cancelled.calendar_chain_id = t.calendar_chain_id
            and cancelled.type = 'appointment'
            and cancelled.status = 'cancelled'
        )
      )
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
    -- NULL means the appointment has no related property. Callers need only
    -- hide lifecycle controls when this value is explicitly true.
    p.is_dnc_locked,
    c.first_name, c.last_name, c.entity_name
  from guarded g
  left join public.properties p on p.id = g.related_property_id
  left join public.contacts c on c.id = g.contact_id
  where case
    when g.window_rows > v_week_cap or g.total_rows > v_total_cap
      then public.fn_raise_calendar_month_volume()
    else true
  end
  order by g.due_at asc, g.id asc;
end;
$$;

-- RAISE-from-inside-the-statement helper: the volume breach must abort the
-- single read statement itself (so a partial result can never be
-- returned), and a set-returning plpgsql RETURN QUERY cannot raise
-- mid-stream from its own WHERE — this VOLATILE helper does. VOLATILE
-- deliberately: an IMMUTABLE zero-arg raising function would be
-- constant-folded at plan time and abort every call unconditionally.
create or replace function public.fn_raise_calendar_month_volume()
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

revoke all on function public.fn_calendar_month_appointments(uuid, uuid, timestamptz[], timestamptz[], integer, integer) from public, anon;
grant execute on function public.fn_calendar_month_appointments(uuid, uuid, timestamptz[], timestamptz[], integer, integer) to authenticated, service_role;
revoke all on function public.fn_raise_calendar_month_volume() from public, anon;
grant execute on function public.fn_raise_calendar_month_volume() to authenticated, service_role;

commit;
