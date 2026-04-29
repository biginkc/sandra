-- ============================================================================
-- System-managed lists (migration 031)
--
-- Pre-populates 20 lists that mirror PropStream's "Lead Lists" categories
-- so VAs see the same names they're used to. System-managed lists:
--   * Pin to the top of every list picker (sorted system_managed DESC, name ASC)
--   * Cannot be archived or deleted via the UI/server actions
--   * Are protected against rename/delete by the `archiveList` action
--
-- Mirrors the same `system_managed` flag the `tags` table introduced in
-- migration 012 — same semantics, same default (false), same intent.
--
-- Part of the broader admin-page cleanup tracked in
-- docs/admin-page/inventory-2026-04-29.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add the column
-- ----------------------------------------------------------------------------
alter table public.lists
  add column if not exists system_managed boolean not null default false;

-- Index supports the (system_managed desc, name asc) sort that every list
-- picker now uses. Cheap — `lists` is a tiny table (dozens of rows, not
-- thousands) — but adds clarity to plans.
create index if not exists idx_lists_system_first_name
  on public.lists (system_managed desc, lower(name) asc)
  where archived_at is null;

-- ----------------------------------------------------------------------------
-- 2. Seed the 20 PropStream "Lead Lists" categories.
--
-- Color = #10b981 (emerald) to match the existing palette in
-- create-list-form.tsx — picked from the existing COLOR_PRESETS so the
-- chip tint stays visually consistent with hand-created lists.
--
-- ON CONFLICT (org_id, name) DO NOTHING — keyed on the existing unique
-- constraint so re-running this migration is safe if rows already exist
-- (e.g. another env where a VA created "Vacant" by hand before 031).
-- ----------------------------------------------------------------------------
insert into public.lists (name, color, system_managed)
values
  ('Auctions',          '#10b981', true),
  ('Bank Owned',        '#10b981', true),
  ('Bankruptcy',        '#10b981', true),
  ('Cash Buyers',       '#10b981', true),
  ('Divorce',           '#10b981', true),
  ('Failed Listings',   '#10b981', true),
  ('Flippers',          '#10b981', true),
  ('Free & Clear',      '#10b981', true),
  ('High Equity',       '#10b981', true),
  ('Liens',             '#10b981', true),
  ('On Market',         '#10b981', true),
  ('Pre-Foreclosures',  '#10b981', true),
  ('Pre-Probate',       '#10b981', true),
  ('Senior Owners',     '#10b981', true),
  ('Tax Delinquency',   '#10b981', true),
  ('Tired Landlords',   '#10b981', true),
  ('Upside Down',       '#10b981', true),
  ('Vacant',            '#10b981', true),
  ('Vacant Land',       '#10b981', true),
  ('Zombie Properties', '#10b981', true)
on conflict (org_id, name) do nothing;

-- ----------------------------------------------------------------------------
-- 3. Update reset_tenant_tables() so system-managed lists survive the
-- between-test truncate. property_lists is still truncated (memberships are
-- per-test) and non-system lists are deleted — system rows persist so
-- integration tests see them on every run.
--
-- This replaces the version from migration 021_skip_trace.sql.
-- ----------------------------------------------------------------------------
create or replace function reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Truncate everything that depends on properties + memberships first.
  truncate table
    job_items,
    messages,
    consent_events,
    property_merges,
    jobs,
    csv_imports,
    webhook_events,
    notifications,
    lead_notes,
    sequence_step_runs,
    sequence_enrollments,
    sequence_steps,
    sequences,
    ai_responder_configs,
    property_lists,
    property_tags,
    tags,
    test_sms_log,
    properties,
    homeowner_details,
    agent_details,
    contacts,
    cass_cache,
    skip_trace_cache
  restart identity cascade;

  -- Drop only non-system lists. The 20 system-managed rows seeded in
  -- migration 031 stay so tests can rely on them being present.
  delete from public.lists where coalesce(system_managed, false) = false;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
-- service_role retains execute permission by default.
