-- Rollback for 20261008150000_hold_alert_deliveries. Drops the delivery table
-- (its rows are lost) and unpatches reset_tenant_tables.
begin;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'\n    public.hold_alert_deliveries,', '');
  if v_new <> v_def then execute v_new; end if;
end $$;

drop table if exists public.hold_alert_deliveries;

commit;
