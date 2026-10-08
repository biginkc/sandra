-- Rollback for 20261008240000_auto_reply_templates. Drops the template
-- auto-send approval columns, the approval audit table, the outcome ->
-- template mapping and both RPCs, and removes the reset_tenant_tables patch.
-- Destructive for approval/mapping data by design: with the feature gone,
-- nothing can send from a template.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(
    v_def,
    E'  perform set_config(''sandra.template_approval'', ''on'', true);\n'
    || E'  delete from public.auto_reply_templates;\n'
    || E'  delete from public.sms_template_approval_events;\n'
    || E'  update public.sms_templates set approved_for_auto_send = false, approved_by = null, approved_at = null, approved_content = null where approved_for_auto_send;\n'
    || E'  perform set_config(''sandra.template_approval'', ''off'', true);\n',
    ''
  );
  if v_new <> v_def then
    execute v_new;
  end if;
end $$;

drop index if exists public.idx_ai_response_claims_template_pending;
drop function if exists public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean);
drop function if exists public.fn_set_template_auto_send_approval(uuid, boolean, text);
drop table if exists public.auto_reply_templates;
drop trigger if exists trg_sms_templates_guard_approval on public.sms_templates;
drop function if exists public.sms_templates_guard_approval();
drop table if exists public.sms_template_approval_events;

alter table public.sms_templates drop constraint if exists sms_templates_approval_shape_check;
alter table public.sms_templates
  drop column if exists approved_content,
  drop column if exists approved_at,
  drop column if exists approved_by,
  drop column if exists approved_for_auto_send;

commit;
