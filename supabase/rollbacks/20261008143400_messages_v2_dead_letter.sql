-- Rollback for 20261008143400_messages_v2_dead_letter. Drops the dead-letter
-- table (its rows are lost) and fn_renew_ai_send, and unpatches
-- reset_tenant_tables. The regex guard assertion is a one-shot check with no
-- persisted object; policy comments revert to NULL.
begin;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'\n    public.ai_reply_dead_letters,', '');
  if v_new <> v_def then execute v_new; end if;
end $$;

comment on policy pipeline_runs_org_select on public.pipeline_runs is null;
comment on policy pipeline_run_steps_org_select on public.pipeline_run_steps is null;
comment on policy jev_lead_decisions_org_select on public.jev_lead_decisions is null;
comment on policy ai_reply_drafts_org_select on public.ai_reply_drafts is null;

drop function if exists public.fn_renew_ai_send(uuid, text, integer);
drop table if exists public.ai_reply_dead_letters;

commit;
