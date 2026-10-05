-- My Leads Phase 3a (TECH-PLAN-2026-10 §3.1): comps schema, cap ledger, RLS.
-- Additive only. No data step touches existing rows. Everything stays inert until the
-- `comp_queue` flag is on for an org AND `org_comp_settings.monthly_call_cap` is above 0
-- (the default row/cap is 0, so no vendor call can be reserved after this lands).
--
-- Creates:
--   public.org_comp_settings            per-org provider, auto-comp switch, monthly call cap (default 0)
--   public.comp_fetch_requests          queue + reservation ledger (one open row per property)
--   public.lead_comps                   append-only comp history, latest row wins, `raw` is service-only
--   public.lead_valuation_inputs        Jarrad's typed ARV and rehab (never from properties.arv)
--   public.fn_enqueue_comp_fetch        service_role; queued|in_flight|fresh|backoff|disabled|capped|unavailable
--   public.fn_claim_comp_fetches        service_role; manual first, Chicago-month cap under an advisory lock;
--                                       optional p_request_id claims only that row (inline "Comp this lead")
--   public.fn_finish_comp_fetch         service_role; trues up reserved_calls to billed
--   public.fn_reap_stuck_comp_fetches   service_role; running > 5 min -> error/TIMEOUT
--   public.fn_set_lead_valuation_inputs authenticated; my_leads_workflow_require_actor, upsert
-- Rollback twin: supabase/rollbacks/20261007100000_lead_comps_foundation.sql
begin;

create table public.org_comp_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'attom' check (provider in ('attom', 'fixture')),
  auto_comp_enabled boolean not null default false,
  monthly_call_cap integer not null default 0 check (monthly_call_cap between 0 and 100000),
  -- Minimum 2: the ATTOM path can bill up to 2 calls per comp, so a reservation below 2 would under-count.
  calls_per_comp integer not null default 3 check (calls_per_comp between 2 and 10),
  est_cents_per_call integer not null default 0 check (est_cents_per_call >= 0),
  ttl_days integer not null default 30 check (ttl_days between 1 and 365),
  manual_refresh_min_hours integer not null default 24 check (manual_refresh_min_hours between 0 and 720),
  -- ARV is Jarrad's own number (approved 2026-10-04); no derived ARV in v1.
  arv_method text not null default 'none' check (arv_method in ('none')),
  verify_min_comps integer not null default 3,
  verify_max_fsd_pct numeric(5, 2) not null default 15,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table public.comp_fetch_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  trigger text not null check (trigger in ('top_ten', 'manual', 'repair')),
  requested_by uuid references auth.users(id),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'ok', 'no_match', 'error', 'capped', 'cancelled')),
  reserved_calls integer not null default 0,
  billed_calls integer not null default 0,
  attempts integer not null default 0,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  lead_comp_id uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint comp_fetch_requests_property_org_fkey foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade
);
create unique index comp_fetch_requests_open_idx on public.comp_fetch_requests (org_id, property_id)
  where status in ('queued', 'running');
create index comp_fetch_requests_queue_idx on public.comp_fetch_requests (status, created_at);

create table public.lead_comps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  provider text not null check (provider in ('attom', 'fixture')),
  request_id uuid references public.comp_fetch_requests(id) on delete set null,
  fetched_at timestamptz not null default now(),
  as_is_value numeric(14, 2) check (as_is_value is null or as_is_value > 0),
  as_is_low numeric(14, 2),
  as_is_high numeric(14, 2),
  confidence text check (confidence in ('high', 'medium', 'low')),
  confidence_score integer,
  verify_first boolean not null default true,
  verify_reasons text[] not null default '{}',
  arv_estimate numeric(14, 2) check (arv_estimate is null or arv_estimate > 0),
  arv_method text,
  comps jsonb not null default '[]' check (jsonb_typeof(comps) = 'array'),
  owner_of_record text,
  legal_description text,
  legal_description_complete boolean not null default false,
  provider_property_id text,
  raw jsonb not null default '{}',
  constraint lead_comps_property_org_fkey foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint lead_comps_range_check check (as_is_low is null or as_is_high is null or as_is_low <= as_is_high)
);
create index lead_comps_property_fetched_idx on public.lead_comps (org_id, property_id, fetched_at desc);

create table public.lead_valuation_inputs (
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  arv numeric(14, 2) check (arv is null or (arv > 0 and arv <= 1e12)),
  rehab numeric(14, 2) check (rehab is null or (rehab >= 0 and rehab <= 1e12)),
  set_by uuid not null references auth.users(id),
  set_at timestamptz not null default now(),
  primary key (org_id, property_id),
  foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade
);

-- RLS: members read their org's rows; every write goes through the functions below.
alter table public.org_comp_settings enable row level security;
alter table public.comp_fetch_requests enable row level security;
alter table public.lead_comps enable row level security;
alter table public.lead_valuation_inputs enable row level security;

create policy org_comp_settings_org_select on public.org_comp_settings
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
create policy comp_fetch_requests_org_select on public.comp_fetch_requests
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
create policy lead_comps_org_select on public.lead_comps
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
create policy lead_valuation_inputs_org_select on public.lead_valuation_inputs
  for select to authenticated using (public.hugo_has_active_org_access(org_id));

revoke all on public.org_comp_settings from public, anon, authenticated, service_role;
revoke all on public.comp_fetch_requests from public, anon, authenticated, service_role;
revoke all on public.lead_comps from public, anon, authenticated, service_role;
revoke all on public.lead_valuation_inputs from public, anon, authenticated, service_role;

grant select on public.org_comp_settings to authenticated;
grant select on public.comp_fetch_requests to authenticated;
grant select on public.lead_valuation_inputs to authenticated;
-- Column grant: `raw` (the vendor payload) is service-only, so `select('*')` fails by design.
grant select (
  id, org_id, property_id, provider, request_id, fetched_at,
  as_is_value, as_is_low, as_is_high, confidence, confidence_score,
  verify_first, verify_reasons, arv_estimate, arv_method, comps,
  owner_of_record, legal_description, legal_description_complete, provider_property_id
) on public.lead_comps to authenticated;

grant select, insert, update, delete on public.org_comp_settings to service_role;
grant select, insert, update, delete on public.comp_fetch_requests to service_role;
grant select, insert, update, delete on public.lead_comps to service_role;
grant select, insert, update, delete on public.lead_valuation_inputs to service_role;

-- ----------------------------------------------------------------------------
-- fn_enqueue_comp_fetch (service_role)
-- ----------------------------------------------------------------------------
create or replace function public.fn_enqueue_comp_fetch(
  p_org_id uuid,
  p_property_id uuid,
  p_trigger text,
  p_requested_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prop record;
  v_settings public.org_comp_settings%rowtype;
  v_latest timestamptz;
  v_freshness interval;
  v_last record;
  v_backoff interval;
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_org_id is null or p_property_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_trigger is null or p_trigger not in ('top_ten', 'manual', 'repair') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select p.is_training, p.deleted_at into v_prop
  from public.properties p
  where p.id = p_property_id and p.org_id = p_org_id;
  if not found or v_prop.is_training or v_prop.deleted_at is not null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select * into v_settings from public.org_comp_settings s where s.org_id = p_org_id;
  if not found then
    -- Absent row reads as the defaults: cap 0, auto off.
    return jsonb_build_object('status', 'disabled');
  end if;
  if v_settings.monthly_call_cap = 0 then
    return jsonb_build_object('status', 'disabled');
  end if;
  if p_trigger = 'top_ten' and not v_settings.auto_comp_enabled then
    return jsonb_build_object('status', 'disabled');
  end if;

  select max(c.fetched_at) into v_latest
  from public.lead_comps c
  where c.org_id = p_org_id and c.property_id = p_property_id;
  v_freshness := case
    when p_trigger = 'manual' then make_interval(hours => v_settings.manual_refresh_min_hours)
    else make_interval(days => v_settings.ttl_days)
  end;
  if v_latest is not null and v_latest > now() - v_freshness then
    return jsonb_build_object('status', 'fresh');
  end if;

  -- A finished no_match inside the freshness window, or an error inside its backoff window, must not
  -- re-queue: one unmatchable lead or a bad key would otherwise burn the monthly cap on every refresh.
  select r.status, r.error_code, r.finished_at into v_last
  from public.comp_fetch_requests r
  where r.org_id = p_org_id and r.property_id = p_property_id
    and r.status in ('no_match', 'error') and r.finished_at is not null
  order by r.finished_at desc
  limit 1;
  if found then
    if v_last.status = 'no_match' and v_last.finished_at > now() - v_freshness then
      return jsonb_build_object('status', 'fresh', 'noMatch', true);
    end if;
    if v_last.status = 'error' then
      -- Honour a RATE_LIMIT_RETRY_<seconds> hint; otherwise 6 hours.
      v_backoff := case
        when v_last.error_code ~ '^RATE_LIMIT_RETRY_[0-9]{1,6}$'
          then make_interval(secs => greatest(substring(v_last.error_code from 18)::integer, 60))
        else interval '6 hours'
      end;
      if v_last.finished_at > now() - v_backoff then
        return jsonb_build_object('status', 'backoff');
      end if;
    end if;
  end if;

  insert into public.comp_fetch_requests (org_id, property_id, trigger, requested_by)
  values (p_org_id, p_property_id, p_trigger, p_requested_by)
  on conflict (org_id, property_id) where status in ('queued', 'running') do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('status', 'in_flight');
  end if;
  return jsonb_build_object('status', 'queued', 'requestId', v_id);
end;
$$;
revoke all on function public.fn_enqueue_comp_fetch(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_enqueue_comp_fetch(uuid, uuid, text, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- fn_claim_comp_fetches (service_role)
-- ----------------------------------------------------------------------------
create or replace function public.fn_claim_comp_fetches(p_limit integer, p_request_id uuid default null)
returns setof public.comp_fetch_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.comp_fetch_requests%rowtype;
  v_settings public.org_comp_settings%rowtype;
  v_used integer;
  v_month_start timestamptz :=
    (date_trunc('month', now() at time zone 'America/Chicago') at time zone 'America/Chicago');
  v_claimed integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  for v_req in
    select r.* from public.comp_fetch_requests r
    where r.status = 'queued'
      and (p_request_id is null or r.id = p_request_id)
    order by (r.trigger = 'manual') desc, r.created_at asc
    for update skip locked
  loop
    exit when v_claimed >= p_limit;

    perform pg_advisory_xact_lock(hashtextextended('comp-cap:' || v_req.org_id::text, 0));

    select * into v_settings from public.org_comp_settings s where s.org_id = v_req.org_id;
    if not found or v_settings.monthly_call_cap = 0 then
      update public.comp_fetch_requests
      set status = 'capped', finished_at = now()
      where id = v_req.id;
      continue;
    end if;

    select coalesce(sum(x.reserved_calls), 0) into v_used
    from public.comp_fetch_requests x
    where x.org_id = v_req.org_id
      and x.started_at is not null
      and x.started_at >= v_month_start;

    if v_used + v_settings.calls_per_comp > v_settings.monthly_call_cap then
      update public.comp_fetch_requests
      set status = 'capped', finished_at = now()
      where id = v_req.id;
      continue;
    end if;

    update public.comp_fetch_requests
    set status = 'running',
        started_at = now(),
        attempts = attempts + 1,
        reserved_calls = v_settings.calls_per_comp
    where id = v_req.id
    returning * into v_req;
    v_claimed := v_claimed + 1;
    return next v_req;
  end loop;
  return;
end;
$$;
revoke all on function public.fn_claim_comp_fetches(integer, uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_claim_comp_fetches(integer, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- fn_finish_comp_fetch (service_role)
-- ----------------------------------------------------------------------------
create or replace function public.fn_finish_comp_fetch(
  p_request_id uuid,
  p_status text,
  p_billed_calls integer,
  p_error_code text,
  p_lead_comp_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('ok', 'no_match', 'error', 'capped', 'cancelled') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.comp_fetch_requests
  set status = p_status,
      billed_calls = greatest(coalesce(p_billed_calls, 0), 0),
      -- True-up: the reservation becomes what was actually billed.
      reserved_calls = greatest(coalesce(p_billed_calls, 0), 0),
      error_code = p_error_code,
      lead_comp_id = p_lead_comp_id,
      finished_at = now()
  where id = p_request_id and status = 'running';
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.fn_finish_comp_fetch(uuid, text, integer, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_finish_comp_fetch(uuid, text, integer, text, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- fn_reap_stuck_comp_fetches (service_role): a timed-out request keeps its reservation.
-- ----------------------------------------------------------------------------
create or replace function public.fn_reap_stuck_comp_fetches()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  with reaped as (
    update public.comp_fetch_requests
    set status = 'error', error_code = 'TIMEOUT', finished_at = now()
    where status = 'running' and started_at < now() - interval '5 minutes'
    returning 1
  )
  select count(*) into v_count from reaped;
  return v_count;
end;
$$;
revoke all on function public.fn_reap_stuck_comp_fetches() from public, anon, authenticated, service_role;
grant execute on function public.fn_reap_stuck_comp_fetches() to service_role;

-- ----------------------------------------------------------------------------
-- fn_set_lead_valuation_inputs (authenticated): Jarrad's typed ARV and rehab.
-- ----------------------------------------------------------------------------
create or replace function public.fn_set_lead_valuation_inputs(
  p_org_id uuid,
  p_property_id uuid,
  p_arv numeric,
  p_rehab numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
begin
  if p_property_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_arv is not null and (p_arv <= 0 or p_arv > 1e12) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_rehab is not null and (p_rehab < 0 or p_rehab > 1e12) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.properties p
    where p.id = p_property_id and p.org_id = p_org_id and p.deleted_at is null
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.lead_valuation_inputs (org_id, property_id, arv, rehab, set_by, set_at)
  values (p_org_id, p_property_id, p_arv, p_rehab, v_actor, now())
  on conflict (org_id, property_id) do update
    set arv = excluded.arv, rehab = excluded.rehab, set_by = excluded.set_by, set_at = excluded.set_at;
  return jsonb_build_object('arv', p_arv, 'rehab', p_rehab, 'setBy', v_actor);
end;
$$;
revoke all on function public.fn_set_lead_valuation_inputs(uuid, uuid, numeric, numeric) from public, anon;
grant execute on function public.fn_set_lead_valuation_inputs(uuid, uuid, numeric, numeric) to authenticated;

commit;
