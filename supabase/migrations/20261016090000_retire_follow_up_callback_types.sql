-- P1a-retire: refuse NEW follow_up / callback task rows.
-- New next steps are appointments (phone by default) or tasks (custom) written through
-- fn_create_next_step. Historical rows keep their type (the type CHECK is NOT narrowed), and
-- completing, reassigning or editing an existing legacy row still works: the trigger only fires on
-- INSERT and on a change of type INTO a retired value.
-- Escape hatch: set_config('sandra.allow_retired_task_type','on',true) (the relabel rollback and
-- test fixtures use it).
-- This migration is schema only. It does NOT raise on leftover legacy rows and converts nothing;
-- the operator gate is `node scripts/my-leads-housekeeping.mjs retire-preflight --org <uuid>`
-- (fn_my_leads_next_step_retire_preflight, shipped in 20261005121500).
begin;

create or replace function public.tasks_reject_retired_types() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('sandra.allow_retired_task_type', true), '') = 'on' then
    return new;
  end if;
  -- explicit branches: plpgsql does not short-circuit, and OLD is unassigned in INSERT triggers
  -- (same warning as tasks_tenant_integrity_guard, 20260814150000_appointments_schema.sql)
  if tg_op = 'INSERT' then
    if new.type in ('follow_up', 'callback') then
      raise exception 'TASK_TYPE_RETIRED: create an appointment (phone) or a task instead of %', new.type
        using errcode = 'P0001';
    end if;
  elsif new.type in ('follow_up', 'callback') and new.type is distinct from old.type then
    raise exception 'TASK_TYPE_RETIRED: create an appointment (phone) or a task instead of %', new.type
      using errcode = 'P0001';
  end if;
  return new;
end $$;

revoke all on function public.tasks_reject_retired_types() from public, anon, authenticated;

create trigger trg_tasks_reject_retired_types
  before insert or update of type on public.tasks
  for each row execute function public.tasks_reject_retired_types();

commit;
