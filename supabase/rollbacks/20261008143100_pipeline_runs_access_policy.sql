-- Rollback for 20261008143100_pipeline_runs_access_policy: restore the
-- any-active-member SELECT policies from 20261008143000 and drop the helper.
begin;

drop policy if exists pipeline_runs_org_select on public.pipeline_runs;
create policy pipeline_runs_org_select on public.pipeline_runs
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

drop policy if exists pipeline_run_steps_org_select on public.pipeline_run_steps;
create policy pipeline_run_steps_org_select on public.pipeline_run_steps
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

drop function if exists public.pipeline_runs_can_read(uuid);

commit;
