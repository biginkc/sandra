-- 20261008143800_jev_thresholds_rls_parity.sql
-- Messages v2 merge-gate P1 (Codex). jev_outcome_thresholds and
-- jev_outcome_threshold_history were readable by ANY active org member
-- (20261008140000: hugo_has_active_org_access only). Thresholds and their
-- audit trail are part of the Messages v2 surface, which is owner +
-- Acquisitions only (pipeline_runs_can_read / pipeline_runs_readable_org_ids,
-- 20261008143100..143300). Tighten both SELECT policies to the same audience,
-- in the same uncorrelated-subquery form as 20261008143300 so Postgres
-- evaluates the org set once per statement, not once per row.
--
-- Unchanged: grants (RLS does the narrowing), service_role access (BYPASSRLS
-- and pipeline_runs_can_read returns true for it), and the owner-only write
-- RPC fn_set_jev_outcome_threshold (security definer, own authorization).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop policy if exists jev_outcome_thresholds_org_select on public.jev_outcome_thresholds;
create policy jev_outcome_thresholds_org_select on public.jev_outcome_thresholds
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

drop policy if exists jev_outcome_threshold_history_org_select on public.jev_outcome_threshold_history;
create policy jev_outcome_threshold_history_org_select on public.jev_outcome_threshold_history
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

commit;
