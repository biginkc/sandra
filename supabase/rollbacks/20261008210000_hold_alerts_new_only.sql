-- Rollback for 20261008210000_hold_alerts_new_only. Drops the watermark table,
-- the start-time trigger/function/column, and unpatches reset_tenant_tables.
-- Deliveries marked skipped 'backlog_discarded' stay skipped (intentional: the
-- discarded backlog must never be sent).
begin;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'\n    public.hold_alert_settings,', '');
  if v_new <> v_def then execute v_new; end if;
end $$;

drop index if exists public.idx_messages_org_inbound_created;
drop table if exists public.hold_alert_settings;
drop trigger if exists trg_properties_track_needs_attention_since on public.properties;
drop function if exists public.properties_track_needs_attention_since();
alter table public.properties drop column if exists needs_human_attention_since;

commit;
