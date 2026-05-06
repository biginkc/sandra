-- 049_metric_snapshots_table.sql
--
-- Introduces a general-purpose metric snapshot store used by daily crons
-- to persist computed counters. The first consumer is the phone-coverage
-- cron which captures how many non-deleted properties have at least one
-- homeowner phone number, so the dashboard donut reads from a snapshot
-- instead of running an expensive live join every page load.

-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------
create table public.metric_snapshots (
  id           uuid        primary key default gen_random_uuid(),
  metric_key   text        not null,
  numerator    integer     not null,
  denominator  integer     not null,
  captured_on  date        not null default current_date,
  captured_at  timestamptz not null default now()
);

-- One snapshot per (metric, day) — re-running the cron updates, not inserts.
create unique index metric_snapshots_key_date_uidx
  on public.metric_snapshots (metric_key, captured_on);

-- Fast look-up of the most-recent snapshot for a given key.
create index metric_snapshots_key_at_idx
  on public.metric_snapshots (metric_key, captured_at desc);

-- ----------------------------------------------------------------------------
-- 2. RLS
-- ----------------------------------------------------------------------------
alter table public.metric_snapshots enable row level security;

create policy "authenticated users can read metric snapshots"
  on public.metric_snapshots
  for select
  to authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- 3. Helper RPC — used by capturePhoneCoverageSnapshot()
-- ----------------------------------------------------------------------------
create or replace function public.count_phone_coverage_stats()
returns table(numerator bigint, denominator bigint)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select
    (
      select count(distinct p.id)
      from   properties p
      join   contacts c on c.id = p.homeowner_contact_id
      where  p.deleted_at is null
        and  (c.phone_1 is not null or c.phone_2 is not null or c.phone_3 is not null)
    ) as numerator,
    (
      select count(*)
      from   properties
      where  deleted_at is null
    ) as denominator;
$$;

-- Only service_role needs this; revoke from lower-privilege callers.
revoke execute on function public.count_phone_coverage_stats() from public;
grant  execute on function public.count_phone_coverage_stats() to service_role;

-- ----------------------------------------------------------------------------
-- 4. Update reset_tenant_tables() to include metric_snapshots
-- ----------------------------------------------------------------------------
create or replace function reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate table
    metric_snapshots,
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

  delete from public.lists where coalesce(system_managed, false) = false;

  delete from public.sms_templates
  where coalesce(system_managed, false) = false
    and deleted_at is null;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
