-- ============================================================================
-- Migration: direct_calls
-- Created: 2026-10-01
-- Purpose: Server-side state for the direct Telnyx calling pilot
-- (.planning/direct-calling/PILOT-SPEC.md). Writes happen only from server
-- code using the service-role client; authenticated users get read-only
-- access to their own rows.
-- ============================================================================

begin;

create table if not exists public.direct_call_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null,
  telnyx_credential_id text not null,
  sip_username text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.direct_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  operator_user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  destination_e164 text not null,
  caller_id_e164 text not null,
  status text not null default 'browser_connecting'
    check (status in ('browser_connecting', 'seller_dialing', 'connected', 'ending', 'ended', 'failed')),
  browser_leg_id text unique,
  seller_leg_id text unique,
  browser_command_id uuid not null default gen_random_uuid(),
  -- Provider-side leg teardown is tracked per leg so a terminal business status
  -- can still have cleanup outstanding (retried until the provider confirms).
  browser_hangup_pending boolean not null default false,
  seller_hangup_pending boolean not null default false,
  -- Set when the provider accepted (2xx) the hangup: stops blind resends. The leg is only
  -- confirmed ended (flag cleared) by the hangup webhook, a 404, or a status check showing it dead.
  -- Doubles as the last-checked time for the 10s status re-check throttle.
  browser_hangup_acked_at timestamptz,
  seller_hangup_acked_at timestamptz,
  -- Provider legs we dialed that conflict with the stored seller leg: hung up until confirmed ended.
  orphan_hangup_leg_ids text[] not null default '{}',
  -- Seller Dial command state, persisted with the transition: pending -> sent | unknown.
  seller_dial_state text check (seller_dial_state in ('pending', 'sent', 'unknown')),
  hangup_cause text,
  failure_reason text,
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (operator_user_id, client_request_id)
);

-- One live direct call per operator. The lock covers pending leg/orphan teardown, so a new call
-- cannot start while a leg of the previous one may still be up.
create unique index if not exists direct_calls_one_active_per_operator_idx
  on public.direct_calls (operator_user_id)
  where status not in ('ended', 'failed')
     or browser_hangup_pending
     or seller_hangup_pending
     or cardinality(orphan_hangup_leg_ids) > 0;

-- Same predicate as the index above (single source of truth for the service's active-call lookup).
create or replace function public.direct_call_active_for_operator(p_user uuid)
returns setof public.direct_calls language sql stable security invoker set search_path = public as $$
  select * from public.direct_calls
   where operator_user_id = p_user
     and (status not in ('ended', 'failed')
          or browser_hangup_pending
          or seller_hangup_pending
          or cardinality(orphan_hangup_leg_ids) > 0)
   limit 1;
$$;

create or replace function public.direct_call_orphan_add(p_id uuid, p_leg text)
returns void language sql security invoker set search_path = public as $$
  update public.direct_calls
     set orphan_hangup_leg_ids = array(select distinct unnest(orphan_hangup_leg_ids || p_leg))
   where id = p_id;
$$;

create or replace function public.direct_call_orphan_remove(p_id uuid, p_leg text)
returns void language sql security invoker set search_path = public as $$
  update public.direct_calls
     set orphan_hangup_leg_ids = array_remove(orphan_hangup_leg_ids, p_leg)
   where id = p_id;
$$;

revoke all on function public.direct_call_active_for_operator(uuid) from public, anon, authenticated;
grant execute on function public.direct_call_active_for_operator(uuid) to service_role;
revoke all on function public.direct_call_orphan_add(uuid, text) from public, anon, authenticated;
revoke all on function public.direct_call_orphan_remove(uuid, text) from public, anon, authenticated;
grant execute on function public.direct_call_orphan_add(uuid, text) to service_role;
grant execute on function public.direct_call_orphan_remove(uuid, text) to service_role;

create table if not exists public.direct_call_events (
  provider_event_id text primary key,
  direct_call_id uuid references public.direct_calls(id) on delete set null,
  event_type text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  payload jsonb not null
);

create index if not exists direct_call_events_call_idx
  on public.direct_call_events (direct_call_id, received_at);

alter table public.direct_call_operators enable row level security;
alter table public.direct_calls enable row level security;
alter table public.direct_call_events enable row level security;

revoke all on public.direct_call_operators from public, anon, authenticated;
revoke all on public.direct_calls from public, anon, authenticated;
revoke all on public.direct_call_events from public, anon, authenticated;
grant select on public.direct_call_operators to authenticated;
grant select on public.direct_calls to authenticated;
grant select on public.direct_call_events to authenticated;
grant select, insert, update, delete on public.direct_call_operators to service_role;
grant select, insert, update, delete on public.direct_calls to service_role;
grant select, insert, update, delete on public.direct_call_events to service_role;

drop policy if exists direct_call_operators_own_select on public.direct_call_operators;
create policy direct_call_operators_own_select on public.direct_call_operators
  for select to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = direct_call_operators.org_id
        and m.access_status = 'active' and m.deletion_prepared_at is null)
  );

drop policy if exists direct_calls_own_select on public.direct_calls;
create policy direct_calls_own_select on public.direct_calls
  for select to authenticated
  using (
    operator_user_id = auth.uid()
    and exists (select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = direct_calls.org_id
        and m.access_status = 'active' and m.deletion_prepared_at is null)
  );

drop policy if exists direct_call_events_own_select on public.direct_call_events;
create policy direct_call_events_own_select on public.direct_call_events
  for select to authenticated
  using (
    exists (select 1 from public.direct_calls c
      where c.id = direct_call_events.direct_call_id and c.operator_user_id = auth.uid()
        and exists (select 1 from public.memberships m
          where m.user_id = auth.uid() and m.org_id = c.org_id
            and m.access_status = 'active' and m.deletion_prepared_at is null))
  );

commit;
