-- 20261008143100_pipeline_runs_access_policy.sql
-- Messages v2 evidence rows carry seller message previews and pipeline
-- decisions. The first migration (20261008143000) let ANY active org member
-- read them; the /messages-v2 page is owner + Acquisitions only, so tighten
-- the database to the same audience (a plain member could otherwise read the
-- tables directly or subscribe over realtime).
--
-- Mirrors src/lib/auth/surface-access.ts: owner role, or the Acquisitions
-- designation (memberships.acquisitions_enabled, any role), each with an
-- active, unexpired, not-deletion-prepared grant. hugo_has_active_org_access
-- stays as the base check.

begin;

create or replace function public.pipeline_runs_can_read(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = p_org_id
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > now())
        and (m.role = 'owner' or m.acquisitions_enabled = true)
    );
$$;

revoke all on function public.pipeline_runs_can_read(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.pipeline_runs_can_read(uuid) to authenticated;

drop policy if exists pipeline_runs_org_select on public.pipeline_runs;
create policy pipeline_runs_org_select on public.pipeline_runs
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and public.pipeline_runs_can_read(org_id)
  );

drop policy if exists pipeline_run_steps_org_select on public.pipeline_run_steps;
create policy pipeline_run_steps_org_select on public.pipeline_run_steps
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and public.pipeline_runs_can_read(org_id)
  );

commit;
