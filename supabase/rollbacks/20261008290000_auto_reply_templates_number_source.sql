-- Rollback for 20261008290000_auto_reply_templates_number_source.
-- Removes number_source from the check constraint and the RPC allow-list,
-- leaving every other key (including any wrong_number / hostile widening from
-- 20261008270000) exactly as it was. number_source mappings cannot exist under
-- the restored constraint, so they are deleted (the code that reads them is
-- rolled back with it).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

delete from public.auto_reply_templates where outcome = 'number_source';

do $$
declare
  v_def text;
  v_keys text[];
  v_fn text;
  v_new text;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conname = 'auto_reply_templates_outcome_check'
    and c.conrelid = 'public.auto_reply_templates'::regclass;
  if v_def is not null then
    v_keys := array['nurture', 'not_interested'];
    if position('wrong_number' in v_def) > 0 then v_keys := v_keys || 'wrong_number'::text; end if;
    if position('hostile' in v_def) > 0 then v_keys := v_keys || 'hostile'::text; end if;
    alter table public.auto_reply_templates drop constraint auto_reply_templates_outcome_check;
    execute format(
      'alter table public.auto_reply_templates add constraint auto_reply_templates_outcome_check check (outcome in (%s))',
      (select string_agg(quote_literal(k), ', ') from unnest(v_keys) k)
    );
  end if;

  v_fn := pg_get_functiondef(
    'public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)'::regprocedure
  );
  v_new := replace(v_fn, 'p_outcome not in (''number_source'', ''nurture'', ''not_interested''', 'p_outcome not in (''nurture'', ''not_interested''');
  if v_new <> v_fn then
    execute v_new;
  end if;
end $$;

commit;
