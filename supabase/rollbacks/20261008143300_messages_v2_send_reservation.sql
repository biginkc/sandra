-- Rollback for 20261008143300_messages_v2_send_reservation. Restores the
-- 20261008143200 policy forms, drops the reservation objects and the pending
-- draft unique index, and unpatches reset_tenant_tables. Drafts that the
-- migration marked 'discarded' as duplicates stay discarded.
begin;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'\n    public.ai_send_reservations,', '');
  if v_new <> v_def then execute v_new; end if;
end $$;

drop policy if exists pipeline_runs_org_select on public.pipeline_runs;
create policy pipeline_runs_org_select on public.pipeline_runs
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and (select public.pipeline_runs_can_read(org_id)));
drop policy if exists pipeline_run_steps_org_select on public.pipeline_run_steps;
create policy pipeline_run_steps_org_select on public.pipeline_run_steps
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and (select public.pipeline_runs_can_read(org_id)));
drop policy if exists jev_lead_decisions_org_select on public.jev_lead_decisions;
create policy jev_lead_decisions_org_select on public.jev_lead_decisions
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and (select public.pipeline_runs_can_read(org_id)));
drop policy if exists ai_reply_drafts_org_select on public.ai_reply_drafts;
create policy ai_reply_drafts_org_select on public.ai_reply_drafts
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and (select public.pipeline_runs_can_read(org_id)));

drop function if exists public.pipeline_runs_readable_org_ids();
drop index if exists public.uq_ai_reply_drafts_pending_inbound;
drop function if exists public.fn_release_ai_send(uuid, text);
drop function if exists public.fn_reserve_ai_send(uuid, uuid, text, integer);
drop table if exists public.ai_send_reservations;

commit;
