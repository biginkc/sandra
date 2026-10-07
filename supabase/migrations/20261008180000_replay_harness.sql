-- 20261008180000_replay_harness.sql
-- Messages v2 Phase 5: 30-day production-replay harness (docs/messages-v2-replay.md).
-- Three small, additive, inert tables. Nothing in the app reads or writes them
-- unless a replay batch exists (only the local/test replay tooling creates one):
--   replay_batches      one row per seeded replay; its org is the "replay org".
--   replay_row_tags     every row the seed loaded, tagged with its batch (for --wipe).
--   replay_outbound_log what the pipeline WOULD have sent (SMS_PROVIDER_STUB=1).
-- Idempotent; rollback in supabase/rollbacks/20261008180000_replay_harness.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.replay_batches (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  org_id uuid not null unique references public.organizations(id) on delete cascade,
  source_label text,
  window_start timestamptz,
  window_end timestamptz,
  inbound_count integer,
  created_at timestamptz not null default now()
);
comment on table public.replay_batches is
  'Messages v2 replay: one row per seeded replay batch; org_id is the replay org. Local/test databases only.';

create table if not exists public.replay_row_tags (
  batch_id text not null references public.replay_batches(id) on delete cascade,
  table_name text not null,
  row_id text not null,
  primary key (batch_id, table_name, row_id)
);
comment on table public.replay_row_tags is
  'Messages v2 replay: replay_batch tag for every seeded row, so --wipe can prove nothing is left behind.';

create table if not exists public.replay_outbound_log (
  id uuid primary key default gen_random_uuid(),
  batch_id text references public.replay_batches(id) on delete cascade,
  provider text not null,
  from_address text,
  to_address text not null,
  body text not null,
  external_id text not null,
  created_at timestamptz not null default now()
);
comment on table public.replay_outbound_log is
  'Messages v2 replay: SMS the pipeline would have sent. Written by the SMS_PROVIDER_STUB=1 stub; nothing was transmitted.';
create index if not exists idx_replay_outbound_log_batch_created
  on public.replay_outbound_log (batch_id, created_at);

alter table public.replay_batches enable row level security;
alter table public.replay_row_tags enable row level security;
alter table public.replay_outbound_log enable row level security;

-- Owners of the replay org only (the /messages-v2 header badge reads this).
drop policy if exists replay_batches_owner_select on public.replay_batches;
create policy replay_batches_owner_select on public.replay_batches
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and exists (
      select 1 from public.memberships m
      where m.org_id = replay_batches.org_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

drop policy if exists replay_outbound_log_owner_select on public.replay_outbound_log;
create policy replay_outbound_log_owner_select on public.replay_outbound_log
  for select to authenticated
  using (
    exists (
      select 1
      from public.replay_batches b
      join public.memberships m on m.org_id = b.org_id
      where b.id = replay_outbound_log.batch_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
        and public.hugo_has_active_org_access(b.org_id)
    )
  );

revoke all on table public.replay_batches from public, anon, authenticated, service_role;
revoke all on table public.replay_row_tags from public, anon, authenticated, service_role;
revoke all on table public.replay_outbound_log from public, anon, authenticated, service_role;
grant select on table public.replay_batches to authenticated;
grant select on table public.replay_outbound_log to authenticated;
grant select, insert, update, delete on table public.replay_batches to service_role;
grant select, insert, update, delete on table public.replay_row_tags to service_role;
grant select, insert, update, delete on table public.replay_outbound_log to service_role;

commit;
