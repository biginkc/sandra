-- Rollback for 20261008250000_luna_suggestions. Drops the stats function, the
-- update guard, the table, and unpatches reset_tenant_tables.
begin;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'\n    public.luna_suggestions,', '');
  if v_new <> v_def then execute v_new; end if;
end $$;

drop function if exists public.fn_luna_suggestion_stats(uuid, integer);
drop table if exists public.luna_suggestions;
drop function if exists public.luna_suggestions_guard_update();

commit;
