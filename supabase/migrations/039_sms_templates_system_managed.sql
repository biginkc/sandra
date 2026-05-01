-- Migration 039: System-managed SMS templates
--
-- Adds system_managed flag and unique constraint to sms_templates,
-- then updates reset_tenant_tables() to preserve system rows across
-- test resets (same pattern as lists / migration 031).

-- ----------------------------------------------------------------------------
-- 1. Add the column
-- ----------------------------------------------------------------------------
alter table public.sms_templates
  add column if not exists system_managed boolean not null default false;

-- ----------------------------------------------------------------------------
-- 2. Unique constraint on (org_id, name) — required for the ON CONFLICT
--    seed upsert in migration 040.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from   pg_constraint
    where  conrelid = 'public.sms_templates'::regclass
    and    conname  = 'sms_templates_org_name_unique'
  ) then
    alter table public.sms_templates
      add constraint sms_templates_org_name_unique unique (org_id, name);
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Update reset_tenant_tables() to preserve system-managed templates.
--
--    sms_templates was not in the TRUNCATE list in migration 031 (it
--    didn't exist yet — added in 034). We CREATE OR REPLACE the full
--    function here so it stays consistent with the current schema.
--    Any future migration that adds tables must update this function.
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

  -- Drop only non-system SMS templates. The 43 BMH templates seeded in
  -- migration 040 stay so tests can rely on them being present.
  delete from public.sms_templates
  where coalesce(system_managed, false) = false
    and deleted_at is null;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
-- service_role retains execute permission by default.
