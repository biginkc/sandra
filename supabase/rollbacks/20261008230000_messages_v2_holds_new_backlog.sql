-- Rollback for 20261008230000_messages_v2_holds_new_backlog. Drops the bucket
-- function and the settings table (the seeded cutover is lost) and unpatches
-- reset_tenant_tables.
begin;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'\n    public.messages_v2_settings,', '');
  if v_new <> v_def then execute v_new; end if;
end $$;

drop function if exists public.messages_v2_hold_buckets(uuid, text, integer, integer);
drop table if exists public.messages_v2_settings;

commit;
