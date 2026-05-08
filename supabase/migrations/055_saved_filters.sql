-- ============================================================================
-- Phase 05 — Prospects Filter Drawer: saved_filters persistence
--
-- Stores per-user filter presets plus 5 base (org-shared) presets seeded below.
-- RLS pattern mirrors 054_memberships_and_rls_rewrite.sql verbatim:
--   read_own_plus_base  — user reads their own rows + their org's base rows
--   write_own (split)   — user can insert / update / delete only their own rows
--   service_all         — service_role bypass for the seed step + admin tooling
--
-- The seed uses `INSERT ... ON CONFLICT (org_id, name) WHERE is_base = true
-- DO NOTHING` to keep re-runs idempotent. The partial unique index supporting
-- that conflict target is created below.
--
-- CI-only: applied by .github/workflows/db-migrate.yml after merge.
-- ============================================================================

begin;

-- gen_random_uuid (Supabase usually has this enabled but be explicit)
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. saved_filters table
-- ----------------------------------------------------------------------------
create table if not exists public.saved_filters (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete cascade,  -- null for base presets
  name          text not null,
  filters_json  jsonb not null,
  starred       boolean not null default false,
  is_base       boolean not null default false,
  last_run_at   timestamptz,
  last_count    integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.saved_filters is
  'Per-user filter presets for the /properties drawer + 5 org-shared base presets. RLS: user reads own + org base; user writes own; service_role bypass for seed.';

-- ----------------------------------------------------------------------------
-- 2. Indexes (per SPEC R7)
-- ----------------------------------------------------------------------------
-- Quick Filters bar query: starred custom presets per user, ordered by name
create index if not exists idx_saved_filters_user_starred_name
  on public.saved_filters (user_id, starred desc, name)
  where user_id is not null;

-- Base preset lookup per org (seed read by Quick Filters bar via union with starred)
create index if not exists idx_saved_filters_org_base
  on public.saved_filters (org_id, is_base)
  where is_base = true;

-- Idempotent seed conflict target: one base preset per (org_id, name)
create unique index if not exists idx_saved_filters_base_unique
  on public.saved_filters (org_id, name)
  where is_base = true;

-- ----------------------------------------------------------------------------
-- 3. updated_at trigger
-- ----------------------------------------------------------------------------
create or replace function public.saved_filters_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_saved_filters_updated_at on public.saved_filters;
create trigger trg_saved_filters_updated_at
  before update on public.saved_filters
  for each row execute function public.saved_filters_set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Row-Level Security — three policies (read_own_plus_base, write_own
--    split into insert/update/delete per Postgres RLS, service_all)
-- ----------------------------------------------------------------------------
alter table public.saved_filters enable row level security;

drop policy if exists saved_filters_read_own_plus_base on public.saved_filters;
create policy saved_filters_read_own_plus_base on public.saved_filters
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or (
      is_base = true
      and org_id in (
        select m.org_id from public.memberships m where m.user_id = auth.uid()
      )
    )
  );

drop policy if exists saved_filters_insert_own on public.saved_filters;
create policy saved_filters_insert_own on public.saved_filters
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists saved_filters_update_own on public.saved_filters;
create policy saved_filters_update_own on public.saved_filters
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists saved_filters_delete_own on public.saved_filters;
create policy saved_filters_delete_own on public.saved_filters
  for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists saved_filters_service_all on public.saved_filters;
create policy saved_filters_service_all on public.saved_filters
  for all
  to service_role
  using (true)
  with check (true);

-- ----------------------------------------------------------------------------
-- 5. Idempotent base preset seed for BMH Group org
--    Names are exact (case-sensitive) per SPEC.md acceptance criteria line 145.
--    filters_json shapes match the v1 FilterBlock discriminated union from
--    src/lib/prospects/filter-schema.ts (Plan 01).
--    Block ids are stable string literals (NOT random UUIDs) so re-running the
--    migration produces identical JSON; ON CONFLICT dedupes by (org_id, name).
-- ----------------------------------------------------------------------------
insert into public.saved_filters
  (org_id, user_id, name, filters_json, is_base)
values
  ('00000000-0000-0000-0000-000000000bbb', null, 'Stacked',
    $${"v": 1, "blocks": [{"id": "base-stacked-list-count-v1", "kind": "list_count", "range": {"min": 2, "max": null}}]}$$::jsonb,
    true),
  ('00000000-0000-0000-0000-000000000bbb', null, 'Vacant',
    $${"v": 1, "blocks": [{"id": "base-vacant-vacancy-v1", "kind": "vacancy", "tri": "yes"}]}$$::jsonb,
    true),
  ('00000000-0000-0000-0000-000000000bbb', null, 'Engaged',
    $${"v": 1, "blocks": [{"id": "base-engaged-engagement-v1", "kind": "engagement", "combinator": "any", "values": ["replied", "attempted"]}]}$$::jsonb,
    true),
  ('00000000-0000-0000-0000-000000000bbb', null, 'Cold',
    $${"v": 1, "blocks": [{"id": "base-cold-engagement-v1", "kind": "engagement", "combinator": "any", "values": ["never_contacted"]}]}$$::jsonb,
    true),
  ('00000000-0000-0000-0000-000000000bbb', null, 'High Equity',
    $${"v": 1, "blocks": [{"id": "base-highequity-equity-v1", "kind": "equity_pct", "range": {"min": 50, "max": null}}]}$$::jsonb,
    true)
on conflict (org_id, name) where is_base = true do nothing;

commit;
