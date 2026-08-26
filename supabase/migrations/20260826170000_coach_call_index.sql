-- ============================================================================
-- Migration: coach_call_index
-- Created: 2026-08-26
-- Purpose: Realtime Broadcast Authorization for the live-call coach channel.
--
-- The coach UI subscribes to a PRIVATE Supabase Realtime Broadcast channel
-- named `coach:{client_call_id}` (client_call_id is the softphone's wrap
-- token — the idempotency key Sandra mints and sends to Jitter on every
-- start-call request; see src/lib/dialer/jitter-server.ts). Jitter's own
-- softphone ledger (jitter_sandra_softphone_calls) lives in a SEPARATE
-- Supabase project from Sandra's — broadcasts land in Sandra's project, so
-- ownership for the realtime.messages RLS policy must be recorded here,
-- not traced through Jitter's tables.
--
-- coach_call_index is a small, purpose-built ownership index: one row per
-- call, written by Sandra's server (service-role only — no client INSERT
-- policy) at call-start time, read only by the realtime.messages policy's
-- ownership check (and, transitively, by that same operator via their own
-- SELECT policy below, since a Postgres RLS policy's subquery against
-- another table is itself subject to that table's RLS for the querying
-- role — see https://supabase.com/docs/guides/realtime/authorization).
-- ============================================================================

begin;

create table if not exists public.coach_call_index (
  client_call_id text primary key,
  operator_user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.coach_call_index is
  'Ownership index for the live-call coach realtime channel (coach:{client_call_id}). Written server-side at call start; read by the realtime.messages RLS policy below to authorize broadcast subscription. Small and retention-friendly — safe to purge alongside old calls.';

create index if not exists coach_call_index_operator_created_idx
  on public.coach_call_index (operator_user_id, created_at desc);

alter table public.coach_call_index enable row level security;

-- The operator who owns a call can see their own index row. This is the
-- minimum read surface needed for the realtime.messages policy below to
-- evaluate correctly for the legitimate owner — RLS on this table applies
-- to that policy's subquery too, so without this, the EXISTS(...) check
-- would return false for everyone, including the true owner.
drop policy if exists coach_call_index_owner_select on public.coach_call_index;
create policy coach_call_index_owner_select on public.coach_call_index
  for select
  to authenticated
  using (operator_user_id = auth.uid());

-- No insert/update/delete policy for `authenticated` — rows are written
-- exclusively by the service-role client from the server-authenticated
-- start-call path (src/lib/dialer/jitter-server.ts), never by the browser.
-- A rep must not be able to claim ownership of an arbitrary call id.

-- ----------------------------------------------------------------------------
-- Realtime Broadcast Authorization: coach:{client_call_id}
-- ----------------------------------------------------------------------------
-- Client channels must be created with `{ config: { private: true } }` for
-- this policy to be enforced (already the case in
-- src/lib/coach/use-coach-channel.ts). No insert policy — broadcasts are
-- published exclusively by the coach ingest service's service-role client.

drop policy if exists coach_broadcast_owner_select on realtime.messages;
create policy coach_broadcast_owner_select on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'coach:%'
    and exists (
      select 1
      from public.coach_call_index cci
      where cci.client_call_id = split_part(realtime.topic(), ':', 2)
        and cci.operator_user_id = (select auth.uid())
    )
  );

commit;
