-- ============================================================================
-- Feature — Tasks (V1: assignee + dashboard panel + dispo auto-create)
--
-- First-class task entity, replacing the dead-letter `properties.follow_up_at`
-- column with a proper task row that can be assigned, completed, snoozed, and
-- reassigned. Each `nurture` / `callback_requested` dispo write inserts a
-- task here so it surfaces on the assignee's dashboard.
--
-- `follow_up_at` on properties stays for one release as a denormalized
-- convenience (UI continues to show "next follow-up" without a join), then
-- retires in v2.2.
--
-- More task types and integrations land in V2 (Slack DM, Google Calendar
-- sync) on top of this same row shape.
--
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml to both
--   - prod (copflsklaefwzipsrjqz)
--   - test (ncsngxlcyxylaeskiteu)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  assignee_id uuid not null references auth.users(id) on delete cascade,
  related_property_id uuid not null references properties(id) on delete cascade,
  type text not null check (type in ('follow_up', 'callback', 'custom')),
  status text not null default 'open' check (status in ('open', 'snoozed', 'completed', 'cancelled')),
  title text not null,
  due_at timestamptz not null,
  snoozed_until timestamptz,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "My open tasks ordered by due date" — the dashboard panel query.
-- Partial on status='open' keeps the index small (completed/snoozed/cancelled
-- rows drop out).
create index idx_tasks_assignee_open_due
  on tasks (assignee_id, due_at)
  where status = 'open';

-- "All tasks on this property" — for property detail / future timeline view.
create index idx_tasks_property_status
  on tasks (related_property_id, status);

-- ----------------------------------------------------------------------------
-- 2. RLS
-- ----------------------------------------------------------------------------
alter table tasks enable row level security;

-- Same pattern as notifications (migration 016): authenticated users see all
-- rows in their org. Per-user narrowing lands with the broader RBAC pass.
create policy tasks_authenticated_all on tasks
  for all
  to authenticated
  using (true)
  with check (true);

-- ----------------------------------------------------------------------------
-- 3. Extend notifications.entity_type to include 'task'
--
-- The notifications table (migration 016) was created with a check constraint
-- locking entity_type to 'property' or 'job'. The new task_assigned dispatch
-- writes notifications with entity_type='task', so we widen the constraint
-- here to keep both feature shipping and migration history coherent.
-- ----------------------------------------------------------------------------
alter table notifications drop constraint notifications_entity_type_check;
alter table notifications add constraint notifications_entity_type_check
  check (entity_type in ('property', 'job', 'task'));

-- ----------------------------------------------------------------------------
-- 4. Update reset_tenant_tables() to include tasks
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
    tasks,
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
