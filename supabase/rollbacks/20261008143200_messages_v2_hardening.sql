-- Rollback for 20261008143200_messages_v2_hardening. Drops the 6-arg
-- fn_set_jev_outcome_threshold (re-apply the 5-arg definition from
-- 20261008140000 to restore it), drops the new columns/table/index, and puts
-- the any-active-member SELECT policies back. The RPC access-parity patch and
-- the reset_tenant_tables patch are NOT reverted (re-apply the earlier
-- migrations' definitions if needed); the looser RPC check only widens access
-- back to the pre-patch state when those definitions are replayed.
begin;
drop function if exists public.pipeline_runs_latest_for_properties(uuid, uuid[]);
drop index if exists public.idx_pipeline_runs_running_started;
drop table if exists public.ai_reply_drafts;
alter table public.ai_responder_configs drop constraint if exists ai_responder_configs_outbound_mode_check;
alter table public.ai_responder_configs drop column if exists outbound_mode;
drop function if exists public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid, boolean);
alter table public.jev_outcome_threshold_history
  drop column if exists previous_automation_enabled,
  drop column if exists new_automation_enabled;
alter table public.jev_outcome_thresholds drop column if exists automation_enabled;
drop policy if exists jev_lead_decisions_org_select on public.jev_lead_decisions;
create policy jev_lead_decisions_org_select on public.jev_lead_decisions
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
commit;
