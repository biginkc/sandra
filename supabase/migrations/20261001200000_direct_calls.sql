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
  hangup_cause text,
  failure_reason text,
  client_request_id uuid not null,
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (operator_user_id, client_request_id)
);

-- One non-terminal direct call per operator.
create unique index if not exists direct_calls_one_active_per_operator_idx
  on public.direct_calls (operator_user_id)
  where status in ('browser_connecting', 'seller_dialing', 'connected', 'ending');

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
      where c.id = direct_call_events.direct_call_id and c.operator_user_id = auth.uid())
  );

commit;
