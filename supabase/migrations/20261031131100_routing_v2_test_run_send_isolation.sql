-- STRESS-TEST-DESIGN §5.4 (G6 prerequisite): test-run taint for the final send boundary.
--
-- 1. properties.test_run_id: set ONLY by the stress seeder on its canary leads. NULL for every
--    real lead (no backfill), so production sends are unaffected.
-- 2. routing_v2_outbox.test_run_id: inherited from the lead when a row is inserted (trigger),
--    so a reply / alert derived from a test-tagged lead carries the tag. The send boundary
--    (assertSendAllowed in messaging/send.ts) also re-reads the lead's tag, so a derived row
--    whose tag was lost by a bug is still refused.
-- 3. test_send_refusals: one row per refused send (refused_non_owned); last 4 digits only.
-- Additive. Rollback: supabase/rollbacks/20261031131100_routing_v2_test_run_send_isolation.sql
begin;
set local lock_timeout = '5s';

alter table public.properties add column if not exists test_run_id text;
create index if not exists properties_test_run_id_idx on public.properties (test_run_id) where test_run_id is not null;
comment on column public.properties.test_run_id is
  'Stress/canary run tag set only by the test seeder. A tagged lead may be texted only on TEST_DEST_ALLOWLIST numbers (§5.4).';

alter table public.routing_v2_outbox add column if not exists test_run_id text;

create or replace function public.routing_v2_outbox_inherit_test_run()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.test_run_id is null then
    select p.test_run_id into new.test_run_id from public.properties p where p.id = new.property_id;
  end if;
  return new;
end;
$$;
revoke all on function public.routing_v2_outbox_inherit_test_run() from public, anon, authenticated;
drop trigger if exists trg_routing_v2_outbox_inherit_test_run on public.routing_v2_outbox;
create trigger trg_routing_v2_outbox_inherit_test_run
  before insert on public.routing_v2_outbox
  for each row execute function public.routing_v2_outbox_inherit_test_run();

create table if not exists public.test_send_refusals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  test_run_id text,
  destination_last4 text check (destination_last4 is null or destination_last4 ~ '^[0-9]{1,4}$'),
  origin text not null,
  reason text not null check (reason in ('refused_non_owned')),
  message_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists test_send_refusals_run_idx on public.test_send_refusals (test_run_id, created_at);
create index if not exists test_send_refusals_org_idx on public.test_send_refusals (org_id);
create index if not exists test_send_refusals_property_idx on public.test_send_refusals (property_id);
alter table public.test_send_refusals enable row level security;
revoke all on public.test_send_refusals from public, anon, authenticated;
grant select, insert on public.test_send_refusals to service_role;
commit;
