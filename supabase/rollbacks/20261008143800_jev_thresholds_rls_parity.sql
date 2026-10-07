-- Rollback for 20261008143800_jev_thresholds_rls_parity. Restores the
-- 20261008140000 SELECT policies exactly (any active org member can read).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists jev_outcome_thresholds_org_select on public.jev_outcome_thresholds;
create policy jev_outcome_thresholds_org_select on public.jev_outcome_thresholds
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

drop policy if exists jev_outcome_threshold_history_org_select on public.jev_outcome_threshold_history;
create policy jev_outcome_threshold_history_org_select on public.jev_outcome_threshold_history
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

commit;
