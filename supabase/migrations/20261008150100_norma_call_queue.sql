-- ============================================================================
-- Migration 2 of 2: Norma call queue (plan v8 + rounds C..H; docs/norma/queue-sql-contract.md).
-- Tables, RLS/grants, clock seam, zone table, scheduler, eligibility consent check, queue functions,
-- hooks into completion / escalation / review / bind, merge extension, triggers.
-- Lock order everywhere: request -> enrollment -> contact -> property -> queue_entry. Entry-first paths
-- (claim, pause, resume, cancel, inbound trigger) lock only the entry.
-- Depends on migration 1 (_norma_legacy_claim_disable) and on 20261008090100.
-- TEMPORARY VERSION PREFIX: Root retimestamps this file.
-- ============================================================================
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';
lock table public.norma_call_requests in access exclusive mode;

-- norma_private already exists (20261008135000) with USAGE granted to authenticated for the inbound-call RLS helpers.
-- Its schema privileges are deliberately NOT touched here; the new queue functions are locked down per object below.
create schema if not exists norma_private;

-- ---------------------------------------------------------------------------
-- Clock seam: the ONLY place SQL reads the real clock.
-- ---------------------------------------------------------------------------
create or replace function norma_private.fn_norma_wallclock()
returns timestamptz
language sql
volatile
as $$ select clock_timestamp() $$;
revoke all on function norma_private.fn_norma_wallclock() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.norma_state_timezones (
  state text primary key,
  timezone text not null
);
alter table public.norma_state_timezones enable row level security;
revoke all on public.norma_state_timezones from public, anon, authenticated, service_role;
grant select on public.norma_state_timezones to service_role;
insert into public.norma_state_timezones (state, timezone) values
  ('MO', 'America/Chicago'),
  ('OH', 'America/New_York'),
  ('AL', 'America/Chicago'),
  ('AK', 'America/Anchorage'),
  ('AZ', 'America/Phoenix'),
  ('AR', 'America/Chicago'),
  ('CA', 'America/Los_Angeles'),
  ('CO', 'America/Denver'),
  ('CT', 'America/New_York'),
  ('DE', 'America/New_York'),
  ('DC', 'America/New_York'),
  ('FL', 'America/New_York'),
  ('GA', 'America/New_York'),
  ('HI', 'Pacific/Honolulu'),
  ('ID', 'America/Boise'),
  ('IL', 'America/Chicago'),
  ('IN', 'America/Indianapolis'),
  ('IA', 'America/Chicago'),
  ('KS', 'America/Chicago'),
  ('KY', 'America/New_York'),
  ('LA', 'America/Chicago'),
  ('ME', 'America/New_York'),
  ('MD', 'America/New_York'),
  ('MA', 'America/New_York'),
  ('MI', 'America/Detroit'),
  ('MN', 'America/Chicago'),
  ('MS', 'America/Chicago'),
  ('MT', 'America/Denver'),
  ('NE', 'America/Chicago'),
  ('NV', 'America/Los_Angeles'),
  ('NH', 'America/New_York'),
  ('NJ', 'America/New_York'),
  ('NM', 'America/Denver'),
  ('NY', 'America/New_York'),
  ('NC', 'America/New_York'),
  ('ND', 'America/Chicago'),
  ('OK', 'America/Chicago'),
  ('OR', 'America/Los_Angeles'),
  ('PA', 'America/New_York'),
  ('RI', 'America/New_York'),
  ('SC', 'America/New_York'),
  ('SD', 'America/Chicago'),
  ('TN', 'America/Chicago'),
  ('TX', 'America/Chicago'),
  ('UT', 'America/Denver'),
  ('VT', 'America/New_York'),
  ('VA', 'America/New_York'),
  ('WA', 'America/Los_Angeles'),
  ('WV', 'America/New_York'),
  ('WI', 'America/Chicago'),
  ('WY', 'America/Denver'),
  ('AS', 'Pacific/Pago_Pago'),
  ('GU', 'Pacific/Guam'),
  ('MP', 'Pacific/Saipan'),
  ('PR', 'America/Puerto_Rico'),
  ('VI', 'America/St_Thomas')
on conflict (state) do update set timezone = excluded.timezone;

create table public.norma_queue_control (
  singleton boolean primary key check (singleton),
  enabled boolean not null default false
);
alter table public.norma_queue_control enable row level security;
revoke all on public.norma_queue_control from public, anon, authenticated, service_role;
-- Default OFF: the operator inserts/updates this row (missing row = OFF).
insert into public.norma_queue_control (singleton, enabled) values (true, false) on conflict (singleton) do nothing;

create table public.norma_queue_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  contact_id uuid not null,
  requested_by uuid not null,
  rep_context text,
  status text not null default 'queued'
    check (status in ('queued', 'calling', 'paused', 'done', 'cancelled', 'exhausted')),
  pause_reason text
    check (pause_reason is null or pause_reason in
      ('inbound_reply', 'needs_review', 'reviewed', 'rep_paused', 'unknown_state', 'provider_refused')),
  end_reason text,
  blocked_reason text,
  phase text not null default 'A' check (phase in ('A', 'B', 'C')),
  phase_dates_used smallint not null default 0,
  phase_c_count smallint not null default 0,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  dispatch_token uuid not null default gen_random_uuid(),
  last_request_id uuid,
  last_sent_at timestamptz,
  reply_ack_at timestamptz,
  display_tz text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint norma_queue_entries_property_org_fkey
    foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade
);
create unique index norma_queue_entries_one_live_per_property_idx
  on public.norma_queue_entries (property_id) where status in ('queued', 'calling', 'paused');
create index norma_queue_entries_due_idx on public.norma_queue_entries (status, next_attempt_at);
create index norma_queue_entries_org_idx on public.norma_queue_entries (org_id, status);
create index norma_queue_entries_contact_idx on public.norma_queue_entries (contact_id);

create table public.norma_queue_attempts (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.norma_queue_entries(id) on delete cascade,
  -- Non-FK snapshot of the request id: the ledger must survive a merge deleting the loser's requests [N4].
  request_id uuid not null unique,
  local_date date not null,
  slot text not null check (slot in ('A_am', 'A_pm', 'B', 'C')),
  sent_at timestamptz not null,
  sent_at_inferred boolean not null default false,
  resolution text not null check (resolution in ('pending', 'final')),
  outcome text,
  final_source text check (final_source is null or final_source in ('webhook', 'reconcile', 'reviewed')),
  updated_at timestamptz not null default now()
);
create index norma_queue_attempts_entry_idx on public.norma_queue_attempts (entry_id, sent_at);

create table public.norma_queue_digests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  local_date date not null,
  edition text not null check (edition in ('morning', 'evening')),
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  locked_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint norma_queue_digests_key unique (org_id, local_date, edition)
);

create table public.norma_followup_reassignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- No FK to the request (snapshot): survives a merge deleting the loser's requests.
  request_id uuid not null unique,
  property_id uuid not null,
  intended_assignee uuid,
  kind text not null check (kind in ('callback_task', 'review_task')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_by uuid,
  resolved_at timestamptz,
  constraint norma_followup_reassignments_property_org_fkey
    foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade
);
create index norma_followup_reassignments_org_idx on public.norma_followup_reassignments (org_id, status);

alter table public.norma_queue_entries enable row level security;
alter table public.norma_queue_attempts enable row level security;
alter table public.norma_queue_digests enable row level security;
alter table public.norma_followup_reassignments enable row level security;

create policy norma_queue_entries_org_select on public.norma_queue_entries
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
-- Tenancy through the entry, evaluated under that table's own policy.
create policy norma_queue_attempts_org_select on public.norma_queue_attempts
  for select to authenticated
  using (exists (select 1 from public.norma_queue_entries e where e.id = norma_queue_attempts.entry_id));
create policy norma_followup_reassignments_org_select on public.norma_followup_reassignments
  for select to authenticated using (public.hugo_has_active_org_access(org_id));

revoke all on public.norma_queue_entries from public, anon, authenticated, service_role;
revoke all on public.norma_queue_attempts from public, anon, authenticated, service_role;
revoke all on public.norma_queue_digests from public, anon, authenticated, service_role;
revoke all on public.norma_followup_reassignments from public, anon, authenticated, service_role;
grant select on public.norma_queue_entries to authenticated, service_role;
grant select on public.norma_queue_attempts to authenticated, service_role;
grant select on public.norma_followup_reassignments to authenticated;
grant select, insert, update, delete on public.norma_followup_reassignments to service_role;
grant select, insert, update, delete on public.norma_queue_digests to service_role;

-- Guard: nothing leaves an absorbing state.
create or replace function public.norma_queue_entries_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('done', 'cancelled', 'exhausted') and new.status is distinct from old.status then
    raise exception 'NORMA_QUEUE_TRANSITION: % is absorbing', old.status using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id then
    raise exception 'NORMA_QUEUE_IMMUTABLE: entry identity cannot change' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger norma_queue_entries_guard before update on public.norma_queue_entries
  for each row execute function public.norma_queue_entries_guard();
revoke all on function public.norma_queue_entries_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- norma_call_requests: queue link and send marker
-- ---------------------------------------------------------------------------
alter table public.norma_call_requests
  add column if not exists queue_entry_id uuid references public.norma_queue_entries(id),
  add column if not exists queue_lease_token uuid,
  add column if not exists queue_dispatch_token uuid,
  add column if not exists send_attempted_at timestamptz;
create index if not exists norma_call_requests_queue_entry_idx
  on public.norma_call_requests (queue_entry_id) where queue_entry_id is not null;

-- ---------------------------------------------------------------------------
-- Small helpers (norma_private; owner-only)
-- ---------------------------------------------------------------------------
create or replace function norma_private.fn_norma_zone_of_state(p_state text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select z.timezone from public.norma_state_timezones z where z.state = upper(btrim(p_state)) $$;

create or replace function norma_private.fn_norma_active_member(p_user uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.memberships m
     where m.user_id = p_user and m.org_id = p_org
       and m.access_status = 'active' and m.deletion_prepared_at is null
       and (m.access_expires_at is null or m.access_expires_at > now())
  )
$$;

-- Half-open window [09:00, 19:30) seller-local, Monday to Saturday.
create or replace function norma_private.fn_norma_window_open(p_zone text, p_at timestamptz)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare l timestamp;
begin
  if p_zone is null or p_at is null then return false; end if;
  l := p_at at time zone p_zone;
  return extract(dow from l) <> 0 and l::time >= time '09:00' and l::time < time '19:30';
end;
$$;

-- Earliest open dialing instant at or after p_at.
create or replace function norma_private.fn_norma_snap_open(p_zone text, p_at timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare l timestamp := p_at at time zone p_zone;
begin
  if extract(dow from l) = 0 then
    l := (l::date + 1) + time '09:00';
  elsif l::time < time '09:00' then
    l := l::date + time '09:00';
  elsif l::time >= time '19:30' then
    l := (l::date + 1) + time '09:00';
  else
    return p_at;
  end if;
  if extract(dow from l) = 0 then l := (l::date + 1) + time '09:00'; end if;
  return l at time zone p_zone;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduler (pure apart from the zone table). Oracle: src/lib/norma/queue/scheduler.fixtures.ts
-- ---------------------------------------------------------------------------
create or replace function norma_private.fn_norma_next_slot_core(p_state text, p_sends timestamptz[], p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_zone text := norma_private.fn_norma_zone_of_state(p_state);
  v_sends timestamptz[];
  v_dates date[];
  n integer;
  v_last timestamptz;
  v_lower timestamptz;
  v_today date;
  v_d date;
  v_t timestamptz;
  v_c integer := 0;
  v_target timestamptz;
  v_am boolean;
  v_pm boolean;
  i integer;
begin
  if v_zone is null then return jsonb_build_object('kind', 'unknown_state'); end if;
  select coalesce(array_agg(s order by s), '{}'::timestamptz[]) into v_sends
    from unnest(p_sends) s where s is not null;
  select coalesce(array_agg(d order by d), '{}'::date[]) into v_dates
    from (select distinct (s at time zone v_zone)::date as d from unnest(v_sends) s) x;
  n := coalesce(array_length(v_dates, 1), 0);
  v_today := (p_now at time zone v_zone)::date;
  if n > 0 then v_last := v_sends[array_length(v_sends, 1)]; end if;
  v_lower := case when v_last is null then p_now else greatest(p_now, v_last + interval '3 hours') end;

  -- ---- phase A: first three dialing dates with a send ----
  if n <= 3 then
    if n = 3 then
      v_d := v_dates[3];
    elsif n > 0 and v_dates[n] > v_today then
      v_d := v_dates[n];
    else
      v_d := v_today;
    end if;
    if not (n = 3 and v_today > v_dates[3]) then
      for i in 1..16 loop
        if extract(dow from v_d) <> 0 then
          v_am := exists (select 1 from unnest(v_sends) s
                           where (s at time zone v_zone)::date = v_d and (s at time zone v_zone)::time < time '14:00');
          v_pm := exists (select 1 from unnest(v_sends) s
                           where (s at time zone v_zone)::date = v_d and (s at time zone v_zone)::time >= time '14:00');
          if not v_am then
            v_t := greatest(v_lower, (v_d + time '09:00') at time zone v_zone);
            if v_t < (v_d + time '14:00') at time zone v_zone then
              return jsonb_build_object('kind', 'slot', 'phase', 'A', 'slot', 'A_am',
                'at', to_char(v_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
            end if;
          end if;
          if not v_pm then
            v_t := greatest(v_lower, (v_d + time '14:00') at time zone v_zone);
            if v_t < (v_d + time '19:30') at time zone v_zone then
              return jsonb_build_object('kind', 'slot', 'phase', 'A', 'slot', 'A_pm',
                'at', to_char(v_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
            end if;
          end if;
        end if;
        exit when n = 3;
        v_d := v_d + 1;
      end loop;
    end if;
  end if;

  -- ---- phase C: monthly, six sends ----
  if n >= 15 then
    select count(*) into v_c from unnest(v_sends) s where (s at time zone v_zone)::date > v_dates[15];
    if v_c >= 6 then return jsonb_build_object('kind', 'exhausted'); end if;
    v_target := greatest(p_now,
      ((((v_last at time zone v_zone)::date + interval '1 month')::date + time '09:00') at time zone v_zone));
    v_t := norma_private.fn_norma_snap_open(v_zone, v_target);
    return jsonb_build_object('kind', 'slot', 'phase', 'C', 'slot', 'C',
      'at', to_char(v_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  end if;

  -- ---- phase B: one send per dialing date, twelve dates ----
  v_target := greatest(p_now, ((((v_last at time zone v_zone)::date + 1) + time '09:00') at time zone v_zone));
  v_t := norma_private.fn_norma_snap_open(v_zone, v_target);
  return jsonb_build_object('kind', 'slot', 'phase', 'B', 'slot', 'B',
    'at', to_char(v_t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Consent, phones, block reasons
-- ---------------------------------------------------------------------------
-- Effective opt-out by the latest-event rule of src/lib/messaging/consent.ts:79-84.
create or replace function norma_private.fn_norma_consent_opted_out(p_contact_id uuid, p_channel text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select ce.event_type in ('opt_out', 'provider_auto_opt_out')
      from public.consent_events ce
     where ce.contact_id = p_contact_id and ce.channel = p_channel
       and ce.event_type in ('opt_out', 'provider_auto_opt_out', 'opt_in_marketing_written',
                             'opt_in_confirmed', 'opt_in_informational')
     order by ce.occurred_at desc, ce.created_at desc, ce.id desc
     limit 1), false)
$$;

-- A contact's dialable numbers, normalised exactly like fn_norma_eligibility's slot match.
create or replace function norma_private.fn_norma_callable_phones(p_contact_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.p from (
    select t.ord, case
             when btrim(coalesce(t.ph, '')) like '+%' and not (length(x.d) = 11 and x.d like '1%') then null
             when length(x.d) = 10 then '+1' || x.d
             when length(x.d) = 11 and x.d like '1%' then '+' || x.d
             else null
           end as p
      from public.contacts c,
           lateral unnest(array[c.phone_1, c.phone_2, c.phone_3]) with ordinality as t(ph, ord),
           lateral (select regexp_replace(coalesce(t.ph, ''), '\D', '', 'g') as d) x
     where c.id = p_contact_id
  ) n
  where n.p ~ '^\+1[2-9][0-9]{9}$'
  order by n.ord
$$;

-- NULL when callable. Reuses fn_norma_eligibility's own reason strings where it refuses.
create or replace function norma_private.fn_norma_queue_block_reason_core(p_property_id uuid, p_contact_id uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prop record;
  v_contact uuid;
  v_phone text;
  v_first text;
  v_ok boolean := false;
  el record;
begin
  select p.homeowner_contact_id, p.status, p.outreach_dispo, p.deleted_at
    into v_prop from public.properties p where p.id = p_property_id;
  if not found or v_prop.deleted_at is not null then return 'property_not_found'; end if;
  v_contact := coalesce(p_contact_id, v_prop.homeowner_contact_id);
  if v_contact is null then return 'contact_not_on_property'; end if;
  for v_phone in select ph from norma_private.fn_norma_callable_phones(v_contact) ph loop
    select * into el from norma_private.fn_norma_eligibility_core(p_property_id, v_contact, v_phone);
    if el.eligible then v_ok := true; exit; end if;
    v_first := coalesce(v_first, el.block_reason);
  end loop;
  if not v_ok then return coalesce(v_first, 'phone_not_on_contact'); end if;
  if v_prop.status in ('dead', 'closed') then return 'property_' || v_prop.status; end if;
  if v_prop.outreach_dispo in ('wrong_number', 'bad_number', 'not_interested', 'dnc', 'opted_out') then
    return v_prop.outreach_dispo;
  end if;
  return null;
end;
$$;

-- First callable number that passes shared eligibility.
create or replace function norma_private.fn_norma_queue_pick_phone(p_property_id uuid, p_contact_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_phone text;
begin
  for v_phone in select ph from norma_private.fn_norma_callable_phones(p_contact_id) ph loop
    if (select el.eligible from norma_private.fn_norma_eligibility_core(p_property_id, p_contact_id, v_phone) el) then
      return v_phone;
    end if;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rescheduling and attempts ledger
-- ---------------------------------------------------------------------------
-- Caller holds the entry lock. Writes the next slot (status queued), or exhausted / paused unknown_state.
create or replace function norma_private.fn_norma_queue_reschedule(p_entry_id uuid, p_now timestamptz)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.norma_queue_entries%rowtype;
  v_state text;
  v_zone text;
  v_sends timestamptz[];
  v_slot jsonb;
  v_n integer := 0;
  v_c integer := 0;
  v_used integer;
begin
  select * into e from public.norma_queue_entries where id = p_entry_id;
  if e.id is null then return 'no_entry'; end if;
  select p.state into v_state from public.properties p where p.id = e.property_id;
  select coalesce(array_agg(a.sent_at order by a.sent_at), '{}'::timestamptz[]) into v_sends
    from public.norma_queue_attempts a where a.entry_id = e.id;
  v_slot := norma_private.fn_norma_next_slot_core(v_state, v_sends, p_now);
  if v_slot ->> 'kind' = 'unknown_state' then
    update public.norma_queue_entries
       set status = 'paused', pause_reason = 'unknown_state', dispatch_token = gen_random_uuid()
     where id = e.id;
    return 'unknown_state';
  elsif v_slot ->> 'kind' = 'exhausted' then
    update public.norma_queue_entries
       set status = 'exhausted', end_reason = 'exhausted', pause_reason = null, next_attempt_at = null
     where id = e.id;
    return 'exhausted';
  end if;
  v_zone := norma_private.fn_norma_zone_of_state(v_state);
  select count(distinct (s at time zone v_zone)::date) into v_n from unnest(v_sends) s;
  if v_n > 15 then
    select count(*) into v_c from unnest(v_sends) s
     where (s at time zone v_zone)::date >
       (select d from (select distinct (s2 at time zone v_zone)::date as d from unnest(v_sends) s2 order by 1 offset 14 limit 1) q);
  end if;
  v_used := case v_slot ->> 'phase' when 'A' then least(v_n, 3) when 'B' then greatest(least(v_n - 3, 12), 0) else 12 end;
  update public.norma_queue_entries
     set status = 'queued', pause_reason = null,
         next_attempt_at = (v_slot ->> 'at')::timestamptz,
         phase = v_slot ->> 'phase', phase_dates_used = v_used, phase_c_count = v_c
   where id = e.id;
  return 'slot';
end;
$$;

-- Upsert the attempts row for a queue request, only when a send was attempted [C22]/[F6].
-- Returns none | inserted | updated | unchanged | was_final.
create or replace function norma_private.fn_norma_queue_attempt_upsert(p_request_id uuid, p_outcome text, p_source text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  a public.norma_queue_attempts%rowtype;
  v_state text;
  v_zone text;
  v_date date;
  v_idx integer;
  v_slot text;
  v_final boolean := p_outcome is not null and p_outcome <> 'unknown';
begin
  select * into r from public.norma_call_requests where id = p_request_id;
  if r.id is null or r.queue_entry_id is null or r.send_attempted_at is null then return 'none'; end if;
  select * into a from public.norma_queue_attempts where request_id = r.id;
  if a.id is not null then
    if a.resolution = 'final' then return 'was_final'; end if;
    if v_final then
      update public.norma_queue_attempts
         set resolution = 'final', outcome = p_outcome, final_source = p_source, updated_at = now()
       where id = a.id;
      return 'updated';
    end if;
    if p_outcome = 'unknown' and a.outcome is null then
      update public.norma_queue_attempts set outcome = 'unknown', updated_at = now() where id = a.id;
      return 'updated';
    end if;
    return 'unchanged';
  end if;
  select p.state into v_state from public.properties p where p.id = r.property_id;
  v_zone := coalesce(norma_private.fn_norma_zone_of_state(v_state),
                     (select e.display_tz from public.norma_queue_entries e where e.id = r.queue_entry_id), 'UTC');
  v_date := (r.send_attempted_at at time zone v_zone)::date;
  select count(distinct t.local_date) + 1 into v_idx
    from public.norma_queue_attempts t where t.entry_id = r.queue_entry_id and t.local_date < v_date;
  v_slot := case when v_idx <= 3 then
              case when (r.send_attempted_at at time zone v_zone)::time < time '14:00' then 'A_am' else 'A_pm' end
            when v_idx <= 15 then 'B' else 'C' end;
  insert into public.norma_queue_attempts
    (entry_id, request_id, local_date, slot, sent_at, resolution, outcome, final_source)
  values (r.queue_entry_id, r.id, v_date, v_slot, r.send_attempted_at,
          case when v_final then 'final' else 'pending' end,
          p_outcome, case when v_final then p_source end)
  on conflict (request_id) do nothing;
  update public.norma_queue_entries set last_sent_at = greatest(coalesce(last_sent_at, r.send_attempted_at), r.send_attempted_at)
   where id = r.queue_entry_id;
  return 'inserted';
end;
$$;

-- ---------------------------------------------------------------------------
-- Settlement (called from completion, escalation, review, and the public wrapper)
-- ---------------------------------------------------------------------------
create or replace function norma_private.fn_norma_queue_settle_core(p_request_id uuid, p_outcome text, p_source text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  e public.norma_queue_entries%rowtype;
  v_outcome text := case when p_outcome = 'needs_review' then 'unknown' else p_outcome end;
  v_terminal boolean;
  v_att text;
  v_changed boolean;
begin
  if v_outcome is null or v_outcome not in
     ('no_answer', 'callback_requested', 'reached_no_callback', 'not_interested', 'wrong_number', 'unknown', 'reviewed') then
    raise exception 'invalid settlement outcome' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('webhook', 'reconcile', 'reviewed') then
    raise exception 'invalid settlement source' using errcode = '22023';
  end if;
  v_terminal := v_outcome in ('callback_requested', 'reached_no_callback', 'not_interested', 'wrong_number');
  select * into r from public.norma_call_requests where id = p_request_id;
  if r.id is null then return 'no_entry'; end if;

  -- Button request: terminal outcomes end any live entry on the property; nothing else changes. No ledger.
  if r.queue_entry_id is null then
    select * into e from public.norma_queue_entries
     where property_id = r.property_id and status in ('queued', 'calling', 'paused') for update;
    if e.id is null then return 'no_entry'; end if;
    if v_terminal then
      update public.norma_queue_entries
         set status = 'done', end_reason = 'outcome:' || v_outcome, pause_reason = null,
             dispatch_token = gen_random_uuid()
       where id = e.id;
      return 'applied';
    end if;
    return 'noop';
  end if;

  select * into e from public.norma_queue_entries where id = r.queue_entry_id for update;
  if e.id is null then return 'no_entry'; end if;

  v_att := norma_private.fn_norma_queue_attempt_upsert(r.id, v_outcome, p_source);
  if v_att = 'was_final' then return 'noop'; end if;
  v_changed := v_att in ('inserted', 'updated');

  if e.status in ('done', 'cancelled', 'exhausted') then
    return case when v_changed then 'applied' else 'noop' end;
  end if;

  if e.blocked_reason is not null then
    update public.norma_queue_entries
       set status = 'done', end_reason = 'blocked:' || e.blocked_reason, pause_reason = null
     where id = e.id;
    return 'applied';
  end if;
  if v_terminal then
    update public.norma_queue_entries
       set status = 'done', end_reason = 'outcome:' || v_outcome, pause_reason = null,
           dispatch_token = gen_random_uuid()
     where id = e.id;
    return 'applied';
  end if;
  -- A late result for an older request must not move an entry that is now running a newer call.
  if e.status = 'calling' and e.last_request_id is not null and e.last_request_id <> r.id then
    return case when v_changed then 'applied' else 'noop' end;
  end if;
  if e.status = 'paused' then
    if v_outcome = 'reviewed' and e.pause_reason is distinct from 'reviewed' then
      update public.norma_queue_entries set pause_reason = 'reviewed' where id = e.id;
      return 'applied';
    end if;
    return case when v_changed then 'applied' else 'noop' end;
  end if;
  if v_outcome = 'no_answer' then
    perform norma_private.fn_norma_queue_reschedule(e.id, norma_private.fn_norma_wallclock());
  elsif v_outcome = 'unknown' then
    update public.norma_queue_entries set status = 'paused', pause_reason = 'needs_review' where id = e.id;
  else
    update public.norma_queue_entries set status = 'paused', pause_reason = 'reviewed' where id = e.id;
  end if;
  return 'applied';
end;
$$;

-- ---------------------------------------------------------------------------
-- Follow-up reassignment: the single writer [C23]
-- ---------------------------------------------------------------------------
create or replace function norma_private.fn_norma_followup_reassignment_upsert(
  p_org_id uuid, p_request_id uuid, p_property_id uuid, p_intended_assignee uuid, p_kind text, p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.norma_followup_reassignments (org_id, request_id, property_id, intended_assignee, kind, payload)
  values (p_org_id, p_request_id, p_property_id, p_intended_assignee, p_kind, coalesce(p_payload, '{}'::jsonb))
  on conflict (request_id) do update
     set kind = excluded.kind, payload = excluded.payload, intended_assignee = excluded.intended_assignee,
         status = 'open', resolved_by = null, resolved_at = null
   where public.norma_followup_reassignments.kind = 'review_task' and excluded.kind = 'callback_task';
end;
$$;

-- ---------------------------------------------------------------------------
-- Inbound reply parking seam [B19] and block application
-- ---------------------------------------------------------------------------
create or replace function norma_private.fn_norma_queue_park_for_reply(p_property_id uuid, p_message_created_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.norma_queue_entries e
     set status = 'paused', pause_reason = 'inbound_reply', dispatch_token = gen_random_uuid()
   where e.property_id = p_property_id and e.status in ('queued', 'calling')
     and p_message_created_at > coalesce(e.reply_ack_at, e.created_at);
end;
$$;

-- Apply blocks to live entries of a property and/or contact. Reason strings are fn_norma_eligibility's.
create or replace function norma_private.fn_norma_queue_apply_blocks(p_property_id uuid, p_contact_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.norma_queue_entries%rowtype;
  v_reason text;
  v_n integer := 0;
begin
  for e in
    select * from public.norma_queue_entries x
     where x.status in ('queued', 'calling', 'paused') and x.blocked_reason is null
       and ((p_property_id is not null and x.property_id = p_property_id)
         or (p_contact_id is not null and x.contact_id = p_contact_id))
     order by x.id for update
  loop
    v_reason := norma_private.fn_norma_queue_block_reason_core(e.property_id, e.contact_id);
    if v_reason is null then continue; end if;
    if e.status = 'calling' then
      update public.norma_queue_entries set blocked_reason = v_reason, dispatch_token = gen_random_uuid() where id = e.id;
    else
      update public.norma_queue_entries
         set status = 'done', blocked_reason = v_reason, end_reason = 'blocked:' || v_reason,
             pause_reason = null, dispatch_token = gen_random_uuid()
       where id = e.id;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function norma_private.fn_norma_queue_trg_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform norma_private.fn_norma_queue_park_for_reply(new.property_id, new.created_at);
  return null;
end;
$$;
create trigger zz_norma_queue_park_reply after insert on public.messages
  for each row when (new.direction = 'inbound' and new.property_id is not null)
  execute function norma_private.fn_norma_queue_trg_message();

create or replace function norma_private.fn_norma_queue_trg_property()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform norma_private.fn_norma_queue_apply_blocks(new.id, null);
  return null;
end;
$$;
create trigger zz_norma_queue_block_property
  after update of status, outreach_dispo, is_dnc_locked, deleted_at, homeowner_contact_id on public.properties
  for each row execute function norma_private.fn_norma_queue_trg_property();

create or replace function norma_private.fn_norma_queue_trg_contact()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform norma_private.fn_norma_queue_apply_blocks(null, new.id);
  return null;
end;
$$;
create trigger zz_norma_queue_block_contact
  after update of do_not_contact, sms_opted_out, phone_1, phone_2, phone_3 on public.contacts
  for each row execute function norma_private.fn_norma_queue_trg_contact();

create or replace function norma_private.fn_norma_queue_trg_consent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform norma_private.fn_norma_queue_apply_blocks(null, new.contact_id);
  return null;
end;
$$;
create trigger zz_norma_queue_block_consent after insert on public.consent_events
  for each row execute function norma_private.fn_norma_queue_trg_consent();

-- Dial accounting shared by the claim pre-check and claim_dispatch_v2 (all orgs; [E1], [C8], [F3]).
create or replace function norma_private.fn_norma_dial_counts(p_now timestamptz, p_tz text, p_exclude uuid)
returns table (concurrent integer, daily integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (select count(*)::integer from public.norma_call_requests q
      where q.id is distinct from p_exclude
        and q.status in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')),
    (select count(*)::integer from public.norma_call_requests q
      where q.id is distinct from p_exclude
        and q.status not in ('requested', 'dispatch_rejected')
        and ((coalesce(q.send_attempted_at, q.dispatched_at, q.dispatch_started_at) at time zone p_tz)::date
               = (p_now at time zone p_tz)::date
             or (q.status = 'dispatching' and q.send_attempted_at is null)
             or (q.status in ('dispatch_unknown', 'needs_review') and q.send_attempted_at is null)))
$$;

-- ===========================================================================
-- Public service-only functions
-- ===========================================================================
create or replace function public.fn_norma_eligibility(p_property_id uuid, p_contact_id uuid, p_phone_e164 text)
returns table (eligible boolean, block_reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return query select c.eligible, c.block_reason
    from norma_private.fn_norma_eligibility_core(p_property_id, p_contact_id, p_phone_e164) c;
end;
$$;

create or replace function public.fn_norma_queue_block_reason(p_property_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return norma_private.fn_norma_queue_block_reason_core(p_property_id, null);
end;
$$;

create or replace function public.fn_norma_queue_next_slot_for(p_state text, p_sends timestamptz[], p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return norma_private.fn_norma_next_slot_core(p_state, p_sends, p_now);
end;
$$;

create or replace function public.fn_norma_queue_next_slot(p_entry_id uuid, p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state text;
  v_sends timestamptz[];
  v_prop uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select e.property_id into v_prop from public.norma_queue_entries e where e.id = p_entry_id;
  if v_prop is null then return null; end if;
  select p.state into v_state from public.properties p where p.id = v_prop;
  select coalesce(array_agg(a.sent_at order by a.sent_at), '{}'::timestamptz[]) into v_sends
    from public.norma_queue_attempts a where a.entry_id = p_entry_id;
  return norma_private.fn_norma_next_slot_core(v_state, v_sends, p_now);
end;
$$;

-- ---------------------------------------------------------------------------
-- Enqueue
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_queue_enqueue(
  p_org_id uuid, p_requested_by uuid, p_property_ids uuid[], p_rep_context text
)
returns table (property_id uuid, result text, entry_id uuid, reason text, next_attempt_at timestamptz, display_tz text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_pid uuid;
  v_prop record;
  v_e public.norma_queue_entries%rowtype;
  v_reason text;
  v_zone text;
  v_slot jsonb;
  v_new uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not norma_private.fn_norma_active_member(p_requested_by, p_org_id) then
    raise exception 'requester_not_member' using errcode = '42501';
  end if;
  foreach v_pid in array coalesce(p_property_ids, '{}'::uuid[]) loop
    perform pg_advisory_xact_lock(hashtextextended('norma_create_request:' || v_pid::text, 0));
    select p.org_id, p.state, p.homeowner_contact_id into v_prop
      from public.properties p where p.id = v_pid and p.org_id = p_org_id and p.deleted_at is null;
    if not found then
      return query select v_pid, 'blocked'::text, null::uuid, 'property_not_found'::text, null::timestamptz, null::text;
      continue;
    end if;
    select * into v_e from public.norma_queue_entries x
     where x.property_id = v_pid and x.status in ('queued', 'calling', 'paused');
    if v_e.id is not null then
      return query select v_pid, 'already_queued'::text, v_e.id, null::text, v_e.next_attempt_at, v_e.display_tz;
      continue;
    end if;
    if exists (select 1 from public.norma_call_requests q where q.property_id = v_pid
                and q.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')) then
      return query select v_pid, 'open_request'::text, null::uuid, null::text, null::timestamptz, null::text;
      continue;
    end if;
    v_reason := norma_private.fn_norma_queue_block_reason_core(v_pid, null);
    if v_reason is not null then
      return query select v_pid, 'blocked'::text, null::uuid, v_reason, null::timestamptz, null::text;
      continue;
    end if;
    v_zone := norma_private.fn_norma_zone_of_state(v_prop.state);
    if v_zone is null then
      return query select v_pid, 'unknown_state'::text, null::uuid, null::text, null::timestamptz, null::text;
      continue;
    end if;
    v_slot := norma_private.fn_norma_next_slot_core(v_prop.state, '{}'::timestamptz[], norma_private.fn_norma_wallclock());
    insert into public.norma_queue_entries
      (org_id, property_id, contact_id, requested_by, rep_context, status, phase, next_attempt_at, display_tz)
    values (p_org_id, v_pid, v_prop.homeowner_contact_id, p_requested_by,
            left(nullif(btrim(p_rep_context), ''), 2000), 'queued', 'A', (v_slot ->> 'at')::timestamptz, v_zone)
    returning id into v_new;
    return query select v_pid, 'queued'::text, v_new, null::text, (v_slot ->> 'at')::timestamptz, v_zone;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim Tx1
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_queue_claim(
  p_entry_id uuid, p_now timestamptz, p_queue_enabled boolean,
  p_max_concurrent integer default null, p_daily_cap integer default null,
  p_cap_tz text default 'America/Chicago'
)
returns table (result text, entry_id uuid, property_id uuid, contact_id uuid, phone_e164 text,
               requested_by uuid, rep_context text, lease_token uuid, dispatch_token uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  e public.norma_queue_entries%rowtype;
  v_state text;
  v_zone text;
  v_reason text;
  v_phone text;
  v_cnt record;
  v_lease uuid := gen_random_uuid();
  v_dispatch uuid := gen_random_uuid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into e from public.norma_queue_entries x where x.id = p_entry_id for update skip locked;
  if e.id is null or e.status <> 'queued' then
    return query select 'not_claimable'::text, p_entry_id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;
  if not coalesce(p_queue_enabled, false) then
    return query select 'disabled'::text, e.id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;
  if e.next_attempt_at is null or e.next_attempt_at > p_now then
    return query select 'not_due'::text, e.id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;
  v_reason := case
    when e.blocked_reason is not null then e.blocked_reason
    when not norma_private.fn_norma_active_member(e.requested_by, e.org_id) then 'requester_not_member'
    else norma_private.fn_norma_queue_block_reason_core(e.property_id, e.contact_id)
  end;
  if v_reason is not null then
    update public.norma_queue_entries
       set status = 'done', blocked_reason = v_reason, end_reason = 'blocked:' || v_reason,
           pause_reason = null, dispatch_token = gen_random_uuid()
     where id = e.id;
    return query select ('blocked:' || v_reason)::text, e.id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;
  select p.state into v_state from public.properties p where p.id = e.property_id;
  v_zone := norma_private.fn_norma_zone_of_state(v_state);
  if v_zone is null then
    update public.norma_queue_entries
       set status = 'paused', pause_reason = 'unknown_state', dispatch_token = gen_random_uuid()
     where id = e.id;
    return query select 'unknown_state'::text, e.id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;
  if not norma_private.fn_norma_window_open(v_zone, p_now) then
    perform norma_private.fn_norma_queue_reschedule(e.id, p_now);
    return query select 'window_closed'::text, e.id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from public.norma_call_requests q where q.property_id = e.property_id
              and q.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')) then
    perform norma_private.fn_norma_queue_reschedule(e.id, p_now);
    return query select 'already_open'::text, e.id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;
  if p_max_concurrent is not null or p_daily_cap is not null then
    select * into v_cnt from norma_private.fn_norma_dial_counts(p_now, coalesce(p_cap_tz, 'America/Chicago'), null);
    if (p_max_concurrent is not null and v_cnt.concurrent >= p_max_concurrent)
       or (p_daily_cap is not null and v_cnt.daily >= p_daily_cap) then
      perform norma_private.fn_norma_queue_reschedule(e.id, p_now);
      return query select 'capacity_precheck'::text, e.id, null::uuid, null::uuid, null::text, null::uuid, null::text, null::uuid, null::uuid;
      return;
    end if;
  end if;
  v_phone := norma_private.fn_norma_queue_pick_phone(e.property_id, e.contact_id);
  update public.norma_queue_entries
     set status = 'calling', lease_token = v_lease, dispatch_token = v_dispatch,
         lease_expires_at = p_now + interval '15 minutes', pause_reason = null
   where id = e.id;
  return query select 'claimed'::text, e.id, e.property_id, e.contact_id, v_phone, e.requested_by, e.rep_context, v_lease, v_dispatch;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_request_v2 (Tx2)
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_create_request_v2(
  p_property_id uuid, p_contact_id uuid, p_phone_e164 text, p_requested_by uuid, p_rep_context text,
  p_callback_assignee_id uuid, p_queue_entry_id uuid default null, p_queue_lease_token uuid default null
)
returns table (outcome text, request_id uuid, idempotency_key uuid, block_reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_ok boolean;
  v_reason text;
  v_id uuid;
  v_key uuid;
  e public.norma_queue_entries%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('norma_create_request:' || p_property_id::text, 0));
  perform 1 from public.norma_call_requests r
   where r.property_id = p_property_id
     and r.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')
     for update;
  perform 1 from public.sequence_enrollments en
   where en.property_id = p_property_id and en.status in ('active', 'paused')
   order by en.id for update;
  select p.org_id into v_org from public.properties p
   where p.id = p_property_id and p.deleted_at is null for share;
  if v_org is null then
    return query select 'blocked'::text, null::uuid, null::uuid, 'property_not_found'::text;
    return;
  end if;
  if not norma_private.fn_norma_active_member(p_requested_by, v_org) then
    return query select 'blocked'::text, null::uuid, null::uuid, 'requester_not_member'::text;
    return;
  end if;
  if not norma_private.fn_norma_active_member(p_callback_assignee_id, v_org) then
    return query select 'blocked'::text, null::uuid, null::uuid, 'assignee_not_member'::text;
    return;
  end if;
  select el.eligible, el.block_reason into v_ok, v_reason
    from norma_private.fn_norma_eligibility_core(p_property_id, p_contact_id, p_phone_e164) el;
  if not coalesce(v_ok, false) then
    return query select 'blocked'::text, null::uuid, null::uuid, coalesce(v_reason, 'eligibility_check_failed');
    return;
  end if;

  -- Entry LAST in the lock order.
  if p_queue_entry_id is not null then
    select * into e from public.norma_queue_entries x where x.id = p_queue_entry_id for update;
    if e.id is null or e.org_id <> v_org or e.property_id <> p_property_id
       or e.contact_id is distinct from p_contact_id then
      raise exception 'NORMA_QUEUE_LINK: entry does not match this property, contact and org' using errcode = '23514';
    end if;
    if e.status <> 'calling' or e.lease_token is null or e.lease_token is distinct from p_queue_lease_token then
      raise exception 'NORMA_QUEUE_LEASE: lease is not current' using errcode = '55000';
    end if;
  end if;

  begin
    insert into public.norma_call_requests
      (org_id, property_id, contact_id, phone_e164, requested_by, rep_context, callback_assignee_id,
       queue_entry_id, queue_lease_token, queue_dispatch_token)
    values
      (v_org, p_property_id, p_contact_id, p_phone_e164, p_requested_by,
       left(nullif(btrim(p_rep_context), ''), 2000), p_callback_assignee_id,
       p_queue_entry_id, case when p_queue_entry_id is not null then e.lease_token end,
       case when p_queue_entry_id is not null then e.dispatch_token end)
    returning id, norma_call_requests.idempotency_key into v_id, v_key;
  exception when unique_violation then
    select r.id into v_id from public.norma_call_requests r
     where r.property_id = p_property_id
       and r.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review');
    return query select 'already_open'::text, v_id, null::uuid, null::text;
    return;
  end;

  perform public.fn_norma_pause_for_request(v_id);
  if p_queue_entry_id is not null then
    update public.norma_queue_entries set last_request_id = v_id where id = e.id;
  end if;
  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
  values (v_org, p_property_id, 'user', p_requested_by, 'norma_call_requested',
          jsonb_build_object('request_id', v_id, 'phone_e164', p_phone_e164,
                             'has_context', nullif(btrim(p_rep_context), '') is not null),
          'norma_call_requests.requested', v_id)
  on conflict (source_type, source_id) where source_id is not null do nothing;
  return query select 'created'::text, v_id, v_key, null::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_dispatch_v2: the single capacity gate. Every time check uses p_now.
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_claim_dispatch_v2(
  p_request_id uuid, p_expected_attempt integer, p_now timestamptz, p_queue_enabled boolean,
  p_max_concurrent integer, p_daily_cap integer, p_cap_tz text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  e public.norma_queue_entries%rowtype;
  v_state text;
  v_zone text;
  v_cnt record;
  v_elig record;
  v_tz text := coalesce(p_cap_tz, 'America/Chicago');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('norma_dial_capacity', 0));
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null or r.status <> 'requested'
     or not ((p_expected_attempt is null and r.attempt = 1) or r.attempt = p_expected_attempt) then
    return 'not_claimed';
  end if;

  if r.queue_entry_id is not null then
    select * into e from public.norma_queue_entries where id = r.queue_entry_id for update;
    if not coalesce(p_queue_enabled, false) then return 'queue_refused:queue_disabled'; end if;
    if e.id is null or e.status <> 'calling' then return 'queue_refused:entry_not_calling'; end if;
    if e.last_request_id is distinct from r.id then return 'queue_refused:request_mismatch'; end if;
    if e.lease_expires_at is null or e.lease_expires_at < p_now then return 'queue_refused:lease_expired'; end if;
    if e.dispatch_token is distinct from r.queue_dispatch_token then return 'queue_refused:token_rotated'; end if;
    if e.blocked_reason is not null then return 'queue_refused:blocked'; end if;
    select p.state into v_state from public.properties p where p.id = r.property_id;
    v_zone := norma_private.fn_norma_zone_of_state(v_state);
    if v_zone is null then return 'queue_refused:unknown_state'; end if;
    if not norma_private.fn_norma_window_open(v_zone, p_now) then return 'queue_refused:window_closed'; end if;
  end if;

  select * into v_elig from norma_private.fn_norma_eligibility_core(r.property_id, r.contact_id, r.phone_e164);
  if not coalesce(v_elig.eligible, false) then
    return 'ineligible:' || coalesce(v_elig.block_reason, 'eligibility_check_failed');
  end if;

  select * into v_cnt from norma_private.fn_norma_dial_counts(p_now, v_tz, r.id);
  if p_max_concurrent is not null and v_cnt.concurrent >= p_max_concurrent then return 'capacity_concurrency'; end if;
  if p_daily_cap is not null and v_cnt.daily >= p_daily_cap then return 'capacity_daily'; end if;
  if exists (
    select 1 from public.norma_call_requests q
     where q.id <> r.id and q.phone_e164 = r.phone_e164
       and (q.status in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')
            or (q.status not in ('requested', 'dispatch_rejected')
                and abs(extract(epoch from (p_now - coalesce(q.send_attempted_at, q.dispatched_at, q.dispatch_started_at)))) < 10))
  ) then
    return 'number_busy';
  end if;

  update public.norma_call_requests set status = 'dispatching', dispatch_started_at = p_now where id = r.id;
  return 'claimed';
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_sending: final admission. Locks first, ONE wall-clock reading after them [E2].
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_mark_sending(
  p_request_id uuid, p_dispatch_token uuid default null, p_expected_attempt integer default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  e public.norma_queue_entries%rowtype;
  v_ctl boolean;
  v_ctl_found boolean := false;
  v_now timestamptz;
  v_state text;
  v_zone text;
  v_reason text;
  v_elig record;
  v_is_queue boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null or r.status <> 'dispatching'
     or not ((p_expected_attempt is null and r.attempt = 1) or r.attempt = p_expected_attempt) then
    return 'refused:not_dispatching';
  end if;
  v_is_queue := r.queue_entry_id is not null;
  -- Admission locks: enrollments, contact, property, then entry, then the control row (SHARE).
  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
  if v_is_queue then
    select * into e from public.norma_queue_entries where id = r.queue_entry_id for share;
    select c.enabled into v_ctl from public.norma_queue_control c where c.singleton for share;
    v_ctl_found := found;
  end if;

  -- The ONLY clock reading, after every lock is held.
  v_now := norma_private.fn_norma_wallclock();

  if r.dispatch_started_at is null or r.dispatch_started_at <= v_now - interval '90 seconds' then
    v_reason := 'stale_claim';
  elsif v_is_queue then
    if e.id is null or e.status <> 'calling' or e.lease_token is distinct from r.queue_lease_token then
      v_reason := 'lease_mismatch';
    elsif e.dispatch_token is distinct from r.queue_dispatch_token
          or (p_dispatch_token is not null and p_dispatch_token is distinct from e.dispatch_token) then
      v_reason := 'token_rotated';
    elsif e.blocked_reason is not null then
      v_reason := 'blocked';
    elsif e.lease_expires_at is null or e.lease_expires_at < v_now then
      v_reason := 'lease_expired';
    elsif not v_ctl_found then
      v_reason := 'queue_disabled';
    elsif not v_ctl then
      v_reason := 'control_off';
    else
      select p.state into v_state from public.properties p where p.id = r.property_id;
      v_zone := norma_private.fn_norma_zone_of_state(v_state);
      if v_zone is null then
        v_reason := 'unknown_state';
      elsif not norma_private.fn_norma_window_open(v_zone, v_now) then
        v_reason := 'window_closed';
      end if;
    end if;
  end if;

  if v_reason is null then
    select * into v_elig from norma_private.fn_norma_eligibility_core(r.property_id, r.contact_id, r.phone_e164);
    if not coalesce(v_elig.eligible, false) then
      v_reason := 'ineligible:' || coalesce(v_elig.block_reason, 'eligibility_check_failed');
    end if;
  end if;

  if v_reason is not null then
    -- Queue rows: every refusal closes the request. Button rows: only an eligibility refusal does;
    -- fence-type refusals leave the row for reconcile.
    if v_is_queue or v_reason like 'ineligible:%' then
      perform public.fn_norma_mark_dispatch_rejected(r.id, v_reason, 'dispatching', r.attempt);
    end if;
    return 'refused:' || v_reason;
  end if;

  update public.norma_call_requests set send_attempted_at = v_now, updated_at = v_now where id = r.id;
  return 'sending';
end;
$$;

-- ---------------------------------------------------------------------------
-- Settlement wrapper
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_queue_settle(p_request_id uuid, p_outcome text, p_source text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform 1 from public.norma_call_requests where id = p_request_id for update;
  return norma_private.fn_norma_queue_settle_core(p_request_id, p_outcome, p_source);
end;
$$;

-- ---------------------------------------------------------------------------
-- Pause / resume / cancel / unknown-state
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_queue_pause(p_entry_id uuid, p_actor uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare e public.norma_queue_entries%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into e from public.norma_queue_entries where id = p_entry_id for update;
  if e.id is null then return 'refused:not_found'; end if;
  if not norma_private.fn_norma_active_member(p_actor, e.org_id) then return 'refused:not_authorized'; end if;
  if e.status in ('queued', 'calling') then
    update public.norma_queue_entries
       set status = 'paused', pause_reason = 'rep_paused', dispatch_token = gen_random_uuid()
     where id = e.id;
    return 'paused';
  end if;
  return 'noop';
end;
$$;

create or replace function public.fn_norma_queue_resume(p_entry_id uuid, p_actor uuid, p_now timestamptz default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.norma_queue_entries%rowtype;
  v_now timestamptz;
  v_state text;
  v_reason text;
  v_res text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into e from public.norma_queue_entries where id = p_entry_id for update;
  if e.id is null then return 'refused:not_found'; end if;
  if not norma_private.fn_norma_active_member(p_actor, e.org_id) then return 'refused:not_authorized'; end if;
  if e.status <> 'paused' then return 'refused:not_paused'; end if;
  if e.blocked_reason is not null then return 'refused:blocked'; end if;
  if exists (select 1 from public.norma_call_requests q where q.property_id = e.property_id
              and q.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')) then
    return 'refused:open_request';
  end if;
  select p.state into v_state from public.properties p where p.id = e.property_id;
  if norma_private.fn_norma_zone_of_state(v_state) is null then return 'refused:unknown_state'; end if;
  v_reason := norma_private.fn_norma_queue_block_reason_core(e.property_id, e.contact_id);
  if v_reason is not null then
    update public.norma_queue_entries
       set status = 'done', blocked_reason = v_reason, end_reason = 'blocked:' || v_reason,
           pause_reason = null, dispatch_token = gen_random_uuid()
     where id = e.id;
    return 'refused:blocked';
  end if;
  v_now := coalesce(p_now, norma_private.fn_norma_wallclock());
  update public.norma_queue_entries set reply_ack_at = coalesce(p_now, now()) where id = e.id;
  v_res := norma_private.fn_norma_queue_reschedule(e.id, v_now);
  if v_res = 'exhausted' then return 'refused:exhausted'; end if;
  return 'resumed';
end;
$$;

create or replace function public.fn_norma_queue_cancel(p_entry_id uuid, p_actor uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare e public.norma_queue_entries%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into e from public.norma_queue_entries where id = p_entry_id for update;
  if e.id is null then return 'refused:not_found'; end if;
  if not norma_private.fn_norma_active_member(p_actor, e.org_id) then return 'refused:not_authorized'; end if;
  if e.status in ('queued', 'calling', 'paused') then
    update public.norma_queue_entries
       set status = 'cancelled', end_reason = 'cancelled', pause_reason = null, dispatch_token = gen_random_uuid()
     where id = e.id;
    return 'cancelled';
  end if;
  return 'noop';
end;
$$;

create or replace function public.fn_norma_queue_pause_unknown_state(p_entry_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.norma_queue_entries%rowtype;
  v_state text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into e from public.norma_queue_entries where id = p_entry_id for update;
  if e.id is null or e.status not in ('queued', 'calling') then return 'noop'; end if;
  select p.state into v_state from public.properties p where p.id = e.property_id;
  if norma_private.fn_norma_zone_of_state(v_state) is not null then return 'noop'; end if;
  update public.norma_queue_entries
     set status = 'paused', pause_reason = 'unknown_state', dispatch_token = gen_random_uuid()
   where id = e.id;
  return 'paused';
end;
$$;

-- ---------------------------------------------------------------------------
-- apply_presend: SQL owns every entry transition after an attempted dispatch.
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_queue_apply_presend(p_request_id uuid, p_result text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  e public.norma_queue_entries%rowtype;
  v_changed boolean := false;
  v_kind text;
  v_status text;
  v_reason text;
  v_att text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then return 'noop'; end if;
  if r.queue_entry_id is null then return 'no_entry'; end if;
  v_kind := case
    when p_result like 'queue_refused:%' or p_result in ('capacity_concurrency', 'capacity_daily', 'number_busy',
         'bland_not_configured', 'stranded_requested_expired') or p_result like 'gate:%' then 'requeue'
    when p_result = 'pre_send_error' then 'retry_now'
    when p_result like 'ineligible:%' then 'ineligible'
    when p_result like 'bland_rejected:%' then 'rejected'
    when p_result = 'bland_unknown' then 'unknown'
    else null end;
  if v_kind is null then return 'noop'; end if;
  select * into e from public.norma_queue_entries where id = r.queue_entry_id for update;

  if v_kind = 'unknown' then
    if r.status = 'dispatching' then
      perform public.fn_norma_mark_dispatch_unknown(r.id, 'bland_unknown', r.attempt);
      v_changed := true;
    elsif r.status <> 'dispatch_unknown' then
      return 'noop';
    end if;
    v_att := norma_private.fn_norma_queue_attempt_upsert(r.id, 'unknown', 'webhook');
    return case when v_changed or v_att in ('inserted', 'updated') then 'applied' else 'noop' end;
  end if;

  if r.status in ('requested', 'dispatching') then
    v_status := public.fn_norma_mark_dispatch_rejected(r.id, p_result, null, r.attempt);
    v_changed := v_status = 'dispatch_rejected';
  elsif r.status <> 'dispatch_rejected' then
    return 'noop';
  end if;

  if e.id is not null and e.last_request_id = r.id and e.status in ('queued', 'calling', 'paused') then
    if e.blocked_reason is not null then
      update public.norma_queue_entries
         set status = 'done', end_reason = 'blocked:' || e.blocked_reason, pause_reason = null
       where id = e.id and status <> 'done';
      v_changed := true;
    elsif v_kind = 'ineligible' and e.status in ('calling', 'paused') then
      v_reason := substr(p_result, length('ineligible:') + 1);
      update public.norma_queue_entries
         set status = 'done', blocked_reason = v_reason, end_reason = 'blocked:' || v_reason,
             pause_reason = null, dispatch_token = gen_random_uuid()
       where id = e.id;
      v_changed := true;
    elsif e.status = 'calling' and v_kind = 'requeue' then
      perform norma_private.fn_norma_queue_reschedule(e.id, norma_private.fn_norma_wallclock());
      v_changed := true;
    elsif e.status = 'calling' and v_kind = 'retry_now' then
      update public.norma_queue_entries
         set status = 'queued', pause_reason = null, next_attempt_at = norma_private.fn_norma_wallclock()
       where id = e.id;
      v_changed := true;
    elsif e.status = 'calling' and v_kind = 'rejected' then
      update public.norma_queue_entries
         set status = 'paused', pause_reason = 'provider_refused', dispatch_token = gen_random_uuid()
       where id = e.id;
      v_changed := true;
    end if;
  end if;
  return case when v_changed then 'applied' else 'noop' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tick helpers
-- ---------------------------------------------------------------------------
create or replace function public.fn_norma_queue_release_expired_leases(p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.norma_queue_entries%rowtype;
  v_n integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  for e in
    select * from public.norma_queue_entries x
     where x.status = 'calling' and x.lease_expires_at < p_now
     order by x.id for update skip locked
  loop
    if exists (select 1 from public.norma_call_requests q where q.queue_entry_id = e.id
                and q.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')) then
      continue;
    end if;
    if e.blocked_reason is not null then
      update public.norma_queue_entries
         set status = 'done', end_reason = 'blocked:' || e.blocked_reason, pause_reason = null
       where id = e.id;
    else
      perform norma_private.fn_norma_queue_reschedule(e.id, p_now);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.fn_norma_queue_sweep_blocks()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.norma_queue_entries%rowtype;
  v_reason text;
  v_n integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  for e in
    select * from public.norma_queue_entries x
     where x.status in ('queued', 'calling', 'paused') and x.blocked_reason is null
     order by x.id for update skip locked
  loop
    v_reason := norma_private.fn_norma_queue_block_reason_core(e.property_id, e.contact_id);
    if v_reason is null then continue; end if;
    if e.status = 'calling' then
      update public.norma_queue_entries set blocked_reason = v_reason, dispatch_token = gen_random_uuid() where id = e.id;
    else
      update public.norma_queue_entries
         set status = 'done', blocked_reason = v_reason, end_reason = 'blocked:' || v_reason,
             pause_reason = null, dispatch_token = gen_random_uuid()
       where id = e.id;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function public.fn_norma_queue_sweep_replies()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.norma_queue_entries%rowtype;
  v_n integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  for e in
    select * from public.norma_queue_entries x
     where x.status = 'queued'
       and exists (select 1 from public.messages m
                    where m.property_id = x.property_id and m.direction = 'inbound'
                      and m.created_at > coalesce(x.reply_ack_at, x.created_at))
     order by x.id for update skip locked
  loop
    update public.norma_queue_entries
       set status = 'paused', pause_reason = 'inbound_reply', dispatch_token = gen_random_uuid()
     where id = e.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---- guard trigger function: copy of 20261008090100 + queue link rules ----
create or replace function public.norma_call_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_retry boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then
      raise exception 'NORMA_TRANSITION: a request must be inserted as requested'
        using errcode = '23514';
    end if;
    if new.attempt <> 1 or new.first_bland_call_id is not null or new.first_attempt_outcome is not null then
      raise exception 'NORMA_TRANSITION: a request must start at attempt 1'
        using errcode = '23514';
    end if;
    if new.queue_entry_id is not null and not exists (
      select 1 from public.norma_queue_entries qe
       where qe.id = new.queue_entry_id and qe.org_id = new.org_id
         and qe.property_id = new.property_id and qe.contact_id is not distinct from new.contact_id) then
      raise exception 'NORMA_QUEUE_LINK: entry must match the request org, property and contact'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.queue_entry_id is distinct from old.queue_entry_id
     or new.queue_lease_token is distinct from old.queue_lease_token
     or new.queue_dispatch_token is distinct from old.queue_dispatch_token then
    raise exception 'NORMA_IMMUTABLE: queue link cannot change'
      using errcode = '23514';
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.property_id is distinct from old.property_id
     or new.phone_e164 is distinct from old.phone_e164
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'NORMA_IMMUTABLE: request identity cannot change'
      using errcode = '23514';
  end if;

  -- The one backwards edge: attempt 1 confirmed not answered, retry scheduled.
  v_retry := coalesce(old.attempt = 1 and new.attempt = 2
         and old.status in ('dispatching', 'dispatched') and new.status = 'requested'
         and new.first_attempt_outcome = 'no_answer'
         and new.first_bland_call_id is not null
         and (old.bland_call_id is null or old.bland_call_id = new.first_bland_call_id)
         and new.bland_call_id is null, false);

  -- Enforce the same operator decision at the row transition, so direct
  -- service-role DML or another writer cannot bypass completion admission.
  if v_retry and not coalesce((select enabled from public.norma_retry_admission
                              where singleton = true for share), false) then
    raise exception 'NORMA_RETRY_DISABLED: operator admission is OFF'
      using errcode = '42501';
  end if;

  if new.attempt is distinct from old.attempt and not v_retry then
    raise exception 'NORMA_TRANSITION: attempt can only move 1 -> 2 when scheduling the retry'
      using errcode = '23514';
  end if;
  if old.first_bland_call_id is not null
     and (new.first_bland_call_id is distinct from old.first_bland_call_id
          or new.first_attempt_outcome is distinct from old.first_attempt_outcome) then
    raise exception 'NORMA_IMMUTABLE: first attempt record cannot change'
      using errcode = '23514';
  end if;
  if not v_retry and old.first_bland_call_id is null
     and (new.first_bland_call_id is not null or new.first_attempt_outcome is not null) then
    raise exception 'NORMA_IMMUTABLE: first attempt is recorded only by scheduling the retry'
      using errcode = '23514';
  end if;

  if old.bland_call_id is not null and new.bland_call_id is distinct from old.bland_call_id and not v_retry then
    raise exception 'NORMA_IMMUTABLE: bland_call_id cannot be overwritten'
      using errcode = '23514';
  end if;

  if old.status = 'completed' then
    if new.status <> 'completed'
       or new.outcome is distinct from old.outcome
       or new.completed_at is distinct from old.completed_at then
      raise exception 'NORMA_TRANSITION: a completed request is final'
        using errcode = '23514';
    end if;
  elsif new.status is distinct from old.status then
    if not (
      (old.status = 'requested' and new.status in ('dispatching', 'dispatch_rejected'))
      or (old.status = 'dispatching' and new.status in
            ('dispatched', 'dispatch_rejected', 'dispatch_unknown', 'completed', 'needs_review'))
      or (old.status = 'dispatched' and new.status in ('completed', 'needs_review'))
      or (old.status = 'dispatch_unknown' and new.status in
            ('dispatched', 'dispatch_rejected', 'completed', 'needs_review'))
      or (old.status = 'needs_review' and new.status in ('completed', 'dispatch_rejected'))
      or v_retry
    ) then
      raise exception 'NORMA_TRANSITION: % -> % is not allowed', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  -- A scheduling-only change (the reconciliation sweep pushing next_check_at
  -- out) must not look like activity: updated_at is the request's idle clock.
  if new.status is not distinct from old.status
     and new.next_check_at is distinct from old.next_check_at
     and (to_jsonb(new) - 'next_check_at' - 'updated_at') = (to_jsonb(old) - 'next_check_at' - 'updated_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ---- bind: copy + pending attempts row for queue requests ----
create or replace function public.fn_norma_bind_call_id(p_request_id uuid, p_call_id text, p_expected_attempt integer default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_call_id is null or btrim(p_call_id) = '' then
    return 'invalid_call_id';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then return 'not_found'; end if;
  if r.status = 'completed' then return 'already_completed'; end if;
  if r.first_bland_call_id is not null and r.first_bland_call_id = p_call_id then
    return 'already_completed';
  end if;
  if p_expected_attempt is not null and r.attempt <> p_expected_attempt then
    return 'stale_attempt';
  end if;
  if p_expected_attempt is null and r.attempt <> 1 then
    return 'already_completed';
  end if;
  if r.status in ('requested', 'dispatch_rejected') then return 'invalid_state'; end if;
  if r.bland_call_id is not null and r.bland_call_id <> p_call_id then
    return 'call_id_conflict';
  end if;
  begin
    update public.norma_call_requests
       set bland_call_id = p_call_id,
           status = case when status in ('dispatching', 'dispatch_unknown') then 'dispatched' else status end,
           dispatched_at = coalesce(dispatched_at, now())
     where id = r.id;
  exception when unique_violation or check_violation then
    return 'call_id_conflict';
  end;
  perform norma_private.fn_norma_queue_attempt_upsert(r.id, null, null);
  return 'bound';
end;
$$;

-- ---- completion: copy + savepoint isolation + queue settlement ----
create or replace function public.fn_norma_complete_call(
  p_request_id uuid,
  p_call_id text,
  p_outcome text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_payload jsonb := case when jsonb_typeof(p_payload) = 'object' then p_payload else '{}'::jsonb end;
  v_summary text := left(nullif(btrim(v_payload ->> 'summary'), ''), 4000);
  v_qual jsonb := case when jsonb_typeof(v_payload -> 'qualification') = 'object'
                       then v_payload -> 'qualification' else '{}'::jsonb end;
  v_cb_raw text := left(nullif(btrim(v_payload ->> 'callback_raw'), ''), 1000);
  v_cb_tz text := left(nullif(btrim(v_payload ->> 'callback_timezone'), ''), 100);
  v_cb_at timestamptz;
  v_prop record;
  v_task_key text;
  v_task_id uuid;
  v_task_type text;
  v_task_title text;
  v_task_due timestamptz;
  v_task_desc text;
  v_dispo_before text;
  v_dispo_target text;
  v_dispo_changed boolean := false;
  v_converted integer := 0;
  v_gap integer := 0;
  v_gap_seqs uuid[] := '{}'::uuid[];
  v_released integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in (
       'no_answer', 'callback_requested', 'reached_no_callback',
       'not_interested', 'wrong_number', 'unknown') then
    raise exception 'invalid norma outcome' using errcode = '22023';
  end if;
  if p_call_id is null or btrim(p_call_id) = '' then
    return jsonb_build_object('result', 'call_id_required');
  end if;

  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- Lock order (see fn_norma_lock_lead): request -> enrollments -> contact ->
  -- property. The disposition, pause and task writes below all end up on those
  -- rows, so they are all taken now: a do-not-contact lock (which takes contact
  -- then property) cannot land between a read and the write that depends on it,
  -- and no other path can hold one of them while waiting for another of ours.
  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
  -- The FIRST call of a request that was already retried: its result was
  -- applied when the retry was scheduled. A webhook replay or a reconciliation
  -- lookup for it is a no-op, never a mismatch and never a second retry.
  if r.first_bland_call_id is not null and r.first_bland_call_id = p_call_id then
    return jsonb_build_object('result', 'replayed', 'status', r.status, 'outcome', r.outcome);
  end if;
  -- Only the CURRENT attempt may complete or advance the request. Both calls
  -- share request_id + idempotency_key, so the call echoes its attempt number in
  -- the metadata (carried here as payload.attempt). While the current attempt has
  -- no bound call id yet (between scheduling and bind) any id would otherwise be
  -- accepted, including a stale or forged attempt-1 one: a result for another
  -- attempt is a no-op.
  -- Attempt metadata is required once the request has been retried. A legacy
  -- completion without metadata remains valid for attempt 1 only; it cannot
  -- settle the current attempt 2 call by omission.
  if not (v_payload ? 'attempt' and (v_payload ->> 'attempt') ~ '^[0-9]+$')
     and r.attempt <> 1 then
    return jsonb_build_object('result', 'stale_attempt', 'status', r.status);
  end if;
  if v_payload ? 'attempt' and (v_payload ->> 'attempt') not in ('1', '2') then
    return jsonb_build_object('result', 'stale_attempt', 'status', r.status);
  end if;
  if v_payload ? 'attempt'
     and coalesce(case when (v_payload ->> 'attempt') ~ '^[0-9]+$' then (v_payload ->> 'attempt')::integer end, 0) <> r.attempt then
    return jsonb_build_object('result', 'stale_attempt', 'status', r.status);
  end if;
  if r.bland_call_id is not null and r.bland_call_id <> p_call_id then
    return jsonb_build_object('result', 'call_id_mismatch', 'status', r.status);
  end if;
  if r.status = 'completed' then
    return jsonb_build_object('result', 'replayed', 'status', 'completed', 'outcome', r.outcome);
  end if;
  if r.status not in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    return jsonb_build_object('result', 'invalid_state', 'status', r.status);
  end if;

  begin
    v_cb_at := (v_payload ->> 'callback_requested_for')::timestamptz;
  exception when others then
    v_cb_at := null;
  end;

  v_task_key := 'norma_call:' || r.id::text;

  -- ---- call twice: the first call was confirmed a non-connect ---------------
  -- Exactly once per request: only an explicitly identified attempt 1, only from an in-flight status
  -- (a late result on dispatch_unknown / needs_review is applied as a plain
  -- no_answer, never retried), and the same row-locked transaction moves the
  -- request to attempt 2, so a replay or a concurrent sweep finds attempt = 2.
  -- The request goes back to `requested`, which is an OPEN status: the hold,
  -- the drip pauses and the one-open-request fence all stay in force, and the
  -- caller then runs the ordinary dispatchNormaCall (gate + dial-time recheck).
  -- Nothing is released and no task/disposition/notification is written yet.
  if p_outcome = 'no_answer' and r.attempt = 1 and r.status in ('dispatching', 'dispatched')
     and (v_payload ->> 'attempt') = '1'
     -- Queue rows never use attempt 2 (approved decision): the queue settles its own no_answer.
     and r.queue_entry_id is null
     -- Lock the admission row through the scheduling commit. An operator's OFF
     -- commit waits for admitted schedulers; later callers see OFF (or abort
     -- under an older repeatable-read snapshot), never a cached runtime flag.
     and coalesce((select enabled from public.norma_retry_admission
                   where singleton = true for share), false) then
    begin
      update public.norma_call_requests
         set status = 'requested', attempt = 2,
             first_bland_call_id = p_call_id, first_attempt_outcome = 'no_answer',
             first_attempt_at = now(), bland_call_id = null,
             dispatch_started_at = null, dispatched_at = null, next_check_at = now()
       where id = r.id;
    exception when unique_violation then
      return jsonb_build_object('result', 'call_id_conflict', 'status', r.status);
    end;
    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (r.org_id, r.property_id, 'system', 'norma_call_attempt_no_answer',
            jsonb_build_object('request_id', r.id, 'attempt', 1, 'call_id', p_call_id,
                               'phone_e164', r.phone_e164),
            'norma_call_requests.attempt1', r.id)
    on conflict (source_type, source_id) where source_id is not null do nothing;
    return jsonb_build_object('result', 'applied', 'status', 'requested', 'outcome', 'no_answer',
                              'retry', true);
  end if;

  -- ---- unknown: park for a human, keep every hold ------------------------
  if p_outcome = 'unknown' then
    if r.status = 'needs_review' and r.outcome = 'unknown' then
      return jsonb_build_object('result', 'replayed', 'status', 'needs_review', 'outcome', 'unknown');
    end if;
    begin
      update public.norma_call_requests
         set bland_call_id = p_call_id, outcome = 'unknown',
             qualification = v_qual, summary = coalesce(v_summary, summary),
             dispatched_at = coalesce(dispatched_at, now())
       where id = r.id;
    exception when unique_violation then
      return jsonb_build_object('result', 'call_id_conflict', 'status', r.status);
    end;
    perform public.fn_norma_mark_needs_review(r.id, 'Bland result did not map to a known outcome', r.attempt);
    return jsonb_build_object('result', 'applied', 'status', 'needs_review', 'outcome', 'unknown');
  end if;

  -- ---- known outcome ------------------------------------------------------
  begin
    update public.norma_call_requests
       set status = 'completed', completed_at = now(), outcome = p_outcome,
           bland_call_id = p_call_id,
           callback_requested_for = case when p_outcome = 'callback_requested' then v_cb_at end,
           callback_timezone = case when p_outcome = 'callback_requested' then v_cb_tz end,
           callback_raw = case when p_outcome = 'callback_requested' then v_cb_raw end,
           qualification = v_qual, summary = v_summary,
           dispatched_at = coalesce(dispatched_at, now())
     where id = r.id;
  exception when unique_violation then
    return jsonb_build_object('result', 'call_id_conflict', 'status', r.status);
  end;

  select pr.is_dnc_locked, pr.outreach_dispo, pr.homeowner_contact_id
    into v_prop from public.properties pr where pr.id = r.property_id;

  -- Disposition writes. Never touch a DNC-locked lead or downgrade a stronger
  -- terminal disposition.
  -- (wrong_number deliberately writes no property disposition: only that phone
  -- number is wrong, not the lead.)
  if p_outcome = 'not_interested' and not coalesce(v_prop.is_dnc_locked, true) then
    v_dispo_target := p_outcome;
    v_dispo_before := v_prop.outreach_dispo;
    update public.properties pr
       set outreach_dispo = v_dispo_target, follow_up_at = null, updated_at = now()
     where pr.id = r.property_id
       and not pr.is_dnc_locked
       and (pr.outreach_dispo is null
            or pr.outreach_dispo <> all (array['dnc', 'opted_out', 'bad_number', 'wrong_number']))
       and not exists (
         select 1 from public.contacts c
          where c.id = pr.homeowner_contact_id and c.do_not_contact);
    v_dispo_changed := found;
    if v_dispo_changed and v_dispo_before is distinct from v_dispo_target then
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
      values (r.org_id, r.property_id, 'system', 'dispo_set',
              jsonb_build_object('from', v_dispo_before, 'to', v_dispo_target,
                                 'trigger', 'norma_call', 'request_id', r.id,
                                 'phone_e164', r.phone_e164),
              'norma_call_requests.dispo', r.id)
      on conflict (source_type, source_id) where source_id is not null do nothing;
    end if;
  end if;

  -- Pause handling (the request is no longer open, so the hold is gone).
  if p_outcome = 'no_answer' then
    v_released := public.fn_norma_release_pauses(r.id);
  elsif not coalesce(v_prop.is_dnc_locked, true) then
    -- Outcomes that keep the drip paused: a softphone pause that was not ours
    -- is converted so it cannot resume later.
    update public.sequence_enrollments e
       set pause_reason = 'norma_call', updated_at = now()
     where e.property_id = r.property_id and e.status = 'paused'
       and e.pause_reason = 'call_in_progress';
    get diagnostics v_converted = row_count;
    -- A drip created in the check-then-write gap (enrol after the request
    -- opened) must not run later either.
    with gap as (
      update public.sequence_enrollments e
         set status = 'paused', pause_reason = 'norma_call', updated_at = now()
       where e.property_id = r.property_id and e.status = 'active'
      returning e.id, e.sequence_id
    )
    select count(*)::integer, coalesce(array_agg(distinct gap.sequence_id), '{}'::uuid[])
      into v_gap, v_gap_seqs
      from gap;
    -- Same "sequence paused" timeline event the request-time pause writes.
    if v_gap > 0 then
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
      values (r.org_id, r.property_id, 'system', 'sequence_paused',
              jsonb_build_object('count', v_gap, 'sequence_ids', to_jsonb(v_gap_seqs),
                                 'reason', 'norma_call', 'permanent', false));
    end if;
  end if;

  -- Task: exactly one per request, only for outcomes that need one.
  if p_outcome in ('callback_requested', 'reached_no_callback', 'wrong_number') then
    if p_outcome = 'callback_requested' then
      v_task_type := 'callback';
      v_task_title := 'Call back seller (requested via Norma, time unconfirmed)';
      v_task_due := coalesce(v_cb_at, now());
      v_task_desc := concat_ws(E'\n',
        case when v_cb_raw is not null then 'Seller said: ' || v_cb_raw end,
        case when v_cb_tz is not null then 'Timezone: ' || v_cb_tz end,
        v_summary);
    elsif p_outcome = 'reached_no_callback' then
      v_task_type := 'callback';
      v_task_title := 'Call back seller (Norma reached them, no callback time given)';
      v_task_due := now();
      v_task_desc := v_summary;
    else
      v_task_type := 'custom';
      v_task_title := 'Norma dialled a wrong number: check the contact phones';
      v_task_due := now();
      v_task_desc := concat_ws(E'\n', 'Number dialled: ' || r.phone_e164, v_summary);
    end if;

    -- A do-not-contact lead's tasks are read-only, and a callback to it is not
    -- wanted: the call result is still recorded, only the task is skipped.
    -- The next step goes through fn_create_next_step: a callback is a phone appointment, the
    -- wrong-number case a task, both upserted by the request's source key (one row per request).
    -- The actor is the requester when still an active member, else the assignee (the shared
    -- function refuses an actor without an active membership; the old insert did not care).
    -- If the keyed appointment was closed, rescheduled or superseded the shared function
    -- refuses to reopen it; the result then becomes a fresh next step under a deterministic key (request key + call id), so a repeat updates that row instead of adding another.
    begin
      begin
        v_task_id := (public.fn_create_next_step(
          p_org := r.org_id,
          p_actor := coalesce((select m.user_id from public.memberships m
                                where m.user_id = r.requested_by and m.org_id = r.org_id
                                  and m.access_status = 'active' and m.deletion_prepared_at is null
                                  and (m.access_expires_at is null or m.access_expires_at > now())),
                              r.callback_assignee_id),
          p_assignee := r.callback_assignee_id,
          p_kind := case when v_task_type = 'custom' then 'task' else 'appointment' end,
          p_title := v_task_title, p_due_at := v_task_due,
          p_property := r.property_id, p_contact := r.contact_id,
          p_mode := 'phone', p_description := v_task_desc,
          p_source_key := v_task_key, p_origin := 'norma') ->> 'task_id')::uuid;
      exception when others then
        if not (sqlstate = 'P0001' and sqlerrm like '%was closed, rescheduled or superseded%') then raise; end if;
        v_task_id := (public.fn_create_next_step(
          p_org := r.org_id,
          p_actor := coalesce((select m.user_id from public.memberships m
                                where m.user_id = r.requested_by and m.org_id = r.org_id
                                  and m.access_status = 'active' and m.deletion_prepared_at is null
                                  and (m.access_expires_at is null or m.access_expires_at > now())),
                              r.callback_assignee_id),
          p_assignee := r.callback_assignee_id,
          p_kind := case when v_task_type = 'custom' then 'task' else 'appointment' end,
          p_title := v_task_title, p_due_at := v_task_due,
          p_property := r.property_id, p_contact := r.contact_id,
          p_mode := 'phone', p_description := v_task_desc,
          p_source_key := v_task_key || ':' || p_call_id,
          p_origin := 'norma') ->> 'task_id')::uuid;
      end;
    exception when others then
      if sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED' then
        v_task_id := null;
      elsif sqlstate = '42501' and sqlerrm like 'FORBIDDEN:%' then
        -- [B11] actor/membership rejection: the call result still commits; the task becomes a reassignment.
        v_task_id := null;
        perform norma_private.fn_norma_followup_reassignment_upsert(
          r.org_id, r.id, r.property_id, r.callback_assignee_id, 'callback_task',
          jsonb_build_object('title', v_task_title, 'due_at', v_task_due, 'description', v_task_desc,
                             'outcome', p_outcome, 'call_id', p_call_id));
      else
        raise;
      end if;
    end;
  else
    -- No task wanted: close a review task a prior escalation may have opened.
    begin
      update public.tasks
         set status = 'cancelled', updated_at = now()
       where org_id = r.org_id and source_key = v_task_key and status in ('open', 'snoozed');
    exception when others then
      if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
    end;
  end if;

  insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
  values (r.org_id, r.property_id, 'system', 'norma_call_completed',
          jsonb_build_object('request_id', r.id, 'outcome', p_outcome, 'call_id', p_call_id,
                             'phone_e164', r.phone_e164, 'summary', v_summary,
                             'callback_requested_for', v_cb_at,
                             'drip_resumed', v_released > 0, 'attempts', r.attempt),
          'norma_call_requests.completed', r.id)
  on conflict (source_type, source_id) where source_id is not null do nothing;

  insert into public.norma_notifications (request_id, kind)
  values (r.id, 'call_completed')
  on conflict (request_id, kind) do nothing;

  -- Queue settlement: LAST in the lock order (request -> enrollment -> contact -> property -> entry).
  perform norma_private.fn_norma_queue_settle_core(r.id, p_outcome, 'webhook');

  return jsonb_build_object('result', 'applied', 'status', 'completed', 'outcome', p_outcome,
                            'task_id', v_task_id, 'released', v_released, 'converted', v_converted);
end;
$$;

-- ---- shared eligibility core (no caller check; public wrapper below) ----
create or replace function norma_private.fn_norma_eligibility_core(
  p_property_id uuid,
  p_contact_id uuid,
  p_phone_e164 text
)
returns table (eligible boolean, block_reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prop record;
  v_contact record;
begin
  if p_property_id is null or p_contact_id is null
     or p_phone_e164 is null or p_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    eligible := false; block_reason := 'invalid_request';
    return next; return;
  end if;

  select p.org_id, p.homeowner_contact_id, p.is_dnc_locked, p.outreach_dispo,
         p.is_training, p.deleted_at
    into v_prop
    from public.properties p
   where p.id = p_property_id;
  if not found or v_prop.deleted_at is not null then
    eligible := false; block_reason := 'property_not_found';
    return next; return;
  end if;

  if v_prop.is_training or public.is_training_target(p_property_id, p_contact_id, p_phone_e164) then
    eligible := false; block_reason := 'training_lead';
    return next; return;
  end if;

  if v_prop.is_dnc_locked or v_prop.outreach_dispo = 'dnc' then
    eligible := false; block_reason := 'dnc_locked';
    return next; return;
  end if;

  if v_prop.homeowner_contact_id is distinct from p_contact_id then
    eligible := false; block_reason := 'contact_not_on_property';
    return next; return;
  end if;

  select c.org_id, c.do_not_contact, c.sms_opted_out, c.phone_1, c.phone_2, c.phone_3
    into v_contact
    from public.contacts c
   where c.id = p_contact_id;
  if not found or v_contact.org_id is distinct from v_prop.org_id then
    eligible := false; block_reason := 'contact_not_on_property';
    return next; return;
  end if;
  if v_contact.do_not_contact then
    eligible := false; block_reason := 'dnc_contact';
    return next; return;
  end if;
  -- STOP: a seller who opted out by text (contact flag, durable phone
  -- suppression, or the opted_out disposition) must not be called next either.
  if coalesce(v_contact.sms_opted_out, false) or v_prop.outreach_dispo = 'opted_out' then
    eligible := false; block_reason := 'sms_opted_out';
    return next; return;
  end if;
  -- Effective consent opt-out in consent_events (latest event wins, consent.ts:79-84): voice, then sms.
  if norma_private.fn_norma_consent_opted_out(p_contact_id, 'voice') then
    eligible := false; block_reason := 'voice_consent_opted_out';
    return next; return;
  end if;
  if norma_private.fn_norma_consent_opted_out(p_contact_id, 'sms') then
    eligible := false; block_reason := 'sms_consent_opted_out';
    return next; return;
  end if;
  -- contacts.phone_1..3 have no format constraint. CSV import writes +1XXXXXXXXXX
  -- (normalizePhone) but other writers may store "(816) 555-0142". Normalise a
  -- stored slot to +1XXXXXXXXXX only when it has exactly 10 digits, or 11
  -- starting with 1 (the same rule as normalizePhone); any other slot is
  -- ignored. The dialled number must equal a normalised slot in full, so a
  -- non-US number can never match a US-looking contact number.
  if not exists (
    select 1
      from unnest(array[v_contact.phone_1, v_contact.phone_2, v_contact.phone_3]) as t(ph),
           lateral (select regexp_replace(coalesce(ph, ''), '\D', '', 'g') as d) x
     where case
             -- A slot written with a leading "+" is an international number
             -- unless it is exactly +1 and ten digits: "+44 12 3456 7890" must
             -- never be read as a US number.
             when btrim(coalesce(ph, '')) like '+%'
                  and not (length(x.d) = 11 and x.d like '1%') then null
             when length(x.d) = 10 then '+1' || x.d
             when length(x.d) = 11 and x.d like '1%' then '+' || x.d
             else null
           end = p_phone_e164
  ) then
    eligible := false; block_reason := 'phone_not_on_contact';
    return next; return;
  end if;

  -- evaluateSuppression queries nothing; the registry must be read directly.
  if exists (
    select 1 from public.global_phone_dnc_registry g
     where g.org_id = v_prop.org_id and g.phone_e164 = p_phone_e164
  ) then
    eligible := false; block_reason := 'global_dnc_registry';
    return next; return;
  end if;

  if exists (
    select 1 from public.sms_phone_suppressions s
     where s.org_id = v_prop.org_id and s.channel = 'sms' and s.phone_e164 = p_phone_e164
  ) then
    eligible := false; block_reason := 'sms_phone_suppressed';
    return next; return;
  end if;

  -- A number Norma already reached as wrong is never dialled again. (Sandra has
  -- no per-number wrong-number flag on main; this is the only record of it.)
  if exists (
    select 1 from public.norma_call_requests w
     where w.org_id = v_prop.org_id and w.phone_e164 = p_phone_e164
       and w.status = 'completed' and w.outcome = 'wrong_number'
  ) then
    eligible := false; block_reason := 'wrong_number_flagged';
    return next; return;
  end if;

  if v_prop.outreach_dispo = 'not_interested' then
    eligible := false; block_reason := 'not_interested';
    return next; return;
  end if;

  eligible := true; block_reason := null;
  return next; return;
exception
  when insufficient_privilege then
    raise;
  when others then
    eligible := false; block_reason := 'eligibility_check_failed';
    return next; return;
end;
$$;

-- ---- escalation: copy + savepoint isolation + queue settlement ----
create or replace function public.fn_norma_mark_needs_review(p_request_id uuid, p_reason text, p_expected_attempt integer default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_task uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then return 'not_found'; end if;
  if p_expected_attempt is not null and r.attempt <> p_expected_attempt then return r.status; end if;
  if p_expected_attempt is null and r.attempt <> 1 then return r.status; end if;
  if r.status not in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    return r.status;
  end if;
  if r.status <> 'needs_review' then
    update public.norma_call_requests
       set status = 'needs_review', dispatch_error = coalesce(left(p_reason, 1000), dispatch_error)
     where id = r.id;
  end if;
  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
  -- A do-not-contact lead is read-only (tasks_reject_dnc_locked_contact), and
  -- nobody should be asked to ring it back anyway. The escalation still
  -- happens; only the review task is skipped. The handler also covers a lock
  -- that lands between this statement and the commit.
  -- Same contract as before: an existing task for this request is left exactly as it is (a
  -- review task a human already closed is not reopened by a repeated escalation).
  if not exists (select 1 from public.tasks t where t.org_id = r.org_id and t.source_key = 'norma_call:' || r.id::text) then
    begin
      v_task := (public.fn_create_next_step(
        p_org := r.org_id,
        p_actor := coalesce((select m.user_id from public.memberships m
                              where m.user_id = r.requested_by and m.org_id = r.org_id
                                and m.access_status = 'active' and m.deletion_prepared_at is null
                                and (m.access_expires_at is null or m.access_expires_at > now())),
                            r.callback_assignee_id),
        p_assignee := r.callback_assignee_id,
        p_kind := 'task', p_title := 'Norma call needs review: outcome unknown', p_due_at := now(),
        p_property := r.property_id, p_contact := r.contact_id,
        p_description := 'Norma may have called this seller but Sandra could not confirm the result. Check Bland and the lead before calling again.',
        p_source_key := 'norma_call:' || r.id::text, p_origin := 'norma') ->> 'task_id')::uuid;
    exception when others then
      if sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED' then
        v_task := null;
      elsif sqlstate = '42501' and sqlerrm like 'FORBIDDEN:%' then
        -- [B11] the escalation still commits; the review task becomes a reassignment.
        v_task := null;
        perform norma_private.fn_norma_followup_reassignment_upsert(
          r.org_id, r.id, r.property_id, r.callback_assignee_id, 'review_task',
          jsonb_build_object('title', 'Norma call needs review: outcome unknown'));
      else
        raise;
      end if;
    end;
  end if;
  perform norma_private.fn_norma_queue_settle_core(r.id, 'unknown', 'reconcile');
  return 'needs_review';
end;
$$;

-- ---- review: copy + queue settlement ----
create or replace function public.fn_norma_mark_reviewed(
  p_request_id uuid,
  p_property_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_org uuid;
  v_prop_id uuid;
  v_locked boolean;
  v_prev_outcome text;
  v_task uuid;
  v_converted integer := 0;
  v_gap integer := 0;
  v_gap_seqs uuid[] := '{}'::uuid[];
  v_kept integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null or p_property_id is null or p_user_id is null then
    return jsonb_build_object('result', 'not_authorized');
  end if;

  -- Cheap unlocked read to authorise BEFORE taking any row lock, so a caller
  -- who is not allowed here cannot queue behind (or stall) a live request.
  select q.org_id, q.property_id into v_org, v_prop_id
    from public.norma_call_requests q where q.id = p_request_id;
  if v_org is null or v_prop_id is distinct from p_property_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = p_user_id and m.org_id = v_org
       and m.access_status = 'active' and m.deletion_prepared_at is null
       and (m.access_expires_at is null or m.access_expires_at > now())
  ) then
    return jsonb_build_object('result', 'not_authorized');
  end if;

  -- Lock order (see fn_norma_lock_lead): request -> enrollments -> contact -> property.
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- A double click or a replay: already done, nothing to do, still a success.
  if r.status = 'completed' and r.outcome = 'reviewed' then
    return jsonb_build_object('result', 'already_reviewed', 'status', 'completed');
  end if;
  if r.status <> 'needs_review' then
    return jsonb_build_object('result', 'invalid_state', 'status', r.status);
  end if;

  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
  select pr.is_dnc_locked into v_locked from public.properties pr where pr.id = r.property_id;
  v_prev_outcome := r.outcome;

  update public.norma_call_requests
     set status = 'completed', outcome = 'reviewed', completed_at = now(),
         reviewed_by = p_user_id, reviewed_at = now()
   where id = r.id;

  -- Disown the request's pauses: they stay paused, but nothing of Norma's may
  -- resume them later. The rep owns the follow-up.
  update public.norma_enrollment_pauses
     set released_at = now(), release_result = 'kept_paused_reviewed'
   where request_id = r.id and released_at is null;

  if not coalesce(v_locked, true) then
    -- Same conversions as a completion that keeps the drip paused: a softphone
    -- pause that was not ours must not resume by itself, and a drip created in
    -- the check-then-write gap must not run.
    update public.sequence_enrollments e
       set pause_reason = 'norma_call', updated_at = now()
     where e.property_id = r.property_id and e.status = 'paused'
       and e.pause_reason = 'call_in_progress';
    get diagnostics v_converted = row_count;
    with gap as (
      update public.sequence_enrollments e
         set status = 'paused', pause_reason = 'norma_call', updated_at = now()
       where e.property_id = r.property_id and e.status = 'active'
      returning e.id, e.sequence_id
    )
    select count(*)::integer, coalesce(array_agg(distinct gap.sequence_id), '{}'::uuid[])
      into v_gap, v_gap_seqs
      from gap;
    if v_gap > 0 then
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
      values (r.org_id, r.property_id, 'system', 'sequence_paused',
              jsonb_build_object('count', v_gap, 'sequence_ids', to_jsonb(v_gap_seqs),
                                 'reason', 'norma_call', 'permanent', false));
    end if;
  end if;
  select count(*)::integer into v_kept
    from public.sequence_enrollments e
   where e.property_id = r.property_id and e.status = 'paused' and e.pause_reason = 'norma_call';

  -- Close the open review task. A do-not-contact lead's tasks are read-only: the
  -- guard raises DNC_LOCKED, the review still lands and the task is left as is.
  begin
    update public.tasks
       set status = 'completed', completed_at = now(), completed_by = p_user_id, updated_at = now()
     where org_id = r.org_id and source_key = 'norma_call:' || r.id::text
       and status in ('open', 'snoozed')
    returning id into v_task;
  exception when others then
    if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
    v_task := null;
  end;

  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
  values (r.org_id, r.property_id, 'user', p_user_id, 'norma_call_reviewed',
          jsonb_build_object('request_id', r.id, 'previous_outcome', v_prev_outcome,
                             'task_closed', v_task is not null, 'drips_kept_paused', v_kept),
          'norma_call_requests.reviewed', r.id)
  on conflict (source_type, source_id) where source_id is not null do nothing;

  perform norma_private.fn_norma_queue_settle_core(r.id, 'reviewed', 'reviewed');

  return jsonb_build_object('result', 'reviewed', 'status', 'completed',
                            'task_closed', v_task is not null, 'drips_kept_paused', v_kept);
end;
$$;

-- ---- merge: copy of 20261008135000 + queue repoint ----
create or replace function public.merge_duplicate_properties(
  keeper_id uuid,
  loser_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keeper_org_id uuid;
  v_loser_org_id uuid;
begin
  select property.org_id into v_keeper_org_id
  from public.properties property where property.id = keeper_id;
  select property.org_id into v_loser_org_id
  from public.properties property where property.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;

  -- Deterministic locking makes a concurrent save either complete before the
  -- merge or fail cleanly before the loser is removed.
  perform 1
  from public.properties property
  where property.id in (keeper_id, loser_id)
  order by property.id
  for update;

  update public.norma_inbound_calls set property_id=keeper_id,updated_at=now()
    where property_id=loser_id and org_id=v_keeper_org_id;
  update public.norma_inbound_reviews set property_id=keeper_id
    where property_id=loser_id and org_id=v_keeper_org_id;

  update public.lead_events
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.ai_disposition_reviews
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.esign_requests
  set property_id = keeper_id,
      updated_at = now()
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.lead_files
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  perform set_config('offer_calculations.merge_repoint', 'true', true);
  set constraints offer_calculations_parent_org_property_series_fkey deferred;
  update public.offer_calculations
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  -- The trigger marker is transaction-local and only covers the repoint above.
  -- Clear it before invoking the private merge body so no later maintenance
  -- statement can accidentally inherit calculator write authority.
  perform set_config('offer_calculations.merge_repoint', '', true);

  -- Norma queue [H8]: entries are locked after the properties (property -> entry). When both properties
  -- hold a LIVE entry the survivor's is kept and the loser's is cancelled before the repoint (one live
  -- entry per property). The attempts ledger follows via entry_id and survives the loser's request delete.
  perform 1 from public.norma_queue_entries qe
   where qe.property_id in (keeper_id, loser_id) order by qe.id for update;
  update public.norma_queue_entries l
     set status = 'cancelled', end_reason = 'merged_into:' || k.id::text, pause_reason = null,
         dispatch_token = gen_random_uuid()
    from public.norma_queue_entries k
   where l.property_id = loser_id and l.status in ('queued', 'calling', 'paused')
     and k.property_id = keeper_id and k.status in ('queued', 'calling', 'paused');
  -- The entry's contact follows the survivor's homeowner contact (eligibility is per property+contact).
  update public.norma_queue_entries
     set property_id = keeper_id,
         contact_id = coalesce((select kp.homeowner_contact_id from public.properties kp where kp.id = keeper_id), contact_id)
   where property_id = loser_id and org_id = v_keeper_org_id;
  update public.norma_followup_reassignments set property_id = keeper_id
   where property_id = loser_id and org_id = v_keeper_org_id;

  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: every new function is service-role only. Pre-existing objects' privileges (other than the
-- fn_norma_eligibility wrapper, restated to its unchanged pre-queue values) are never altered.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'norma_private'
       -- ONLY the queue's own fn_norma_* functions. can_access_callbacks / associate_inbound_call (20261008135000) keep
       -- their authenticated EXECUTE: the inbound-call RLS policies call them.
       and p.proname like 'fn\_norma\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('fn_norma_queue_enqueue', 'fn_norma_queue_claim', 'fn_norma_create_request_v2',
         'fn_norma_claim_dispatch_v2', 'fn_norma_mark_sending', 'fn_norma_queue_settle', 'fn_norma_queue_pause',
         'fn_norma_queue_resume', 'fn_norma_queue_cancel', 'fn_norma_queue_block_reason',
         'fn_norma_queue_next_slot', 'fn_norma_queue_next_slot_for', 'fn_norma_queue_apply_presend',
         'fn_norma_queue_release_expired_leases', 'fn_norma_queue_sweep_blocks', 'fn_norma_queue_sweep_replies',
         'fn_norma_queue_pause_unknown_state', 'fn_norma_eligibility')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- merge_duplicate_properties is create-or-replaced above, which preserves its existing grants; nothing to do here.

commit;
