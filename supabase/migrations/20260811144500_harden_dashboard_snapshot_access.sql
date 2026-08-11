begin;

drop policy if exists "authenticated users can read dashboard snapshots"
  on public.dashboard_snapshots;
create policy "authenticated users can read dashboard snapshots"
  on public.dashboard_snapshots
  for select
  to authenticated
  using (public.hugo_has_any_active_access());

commit;
