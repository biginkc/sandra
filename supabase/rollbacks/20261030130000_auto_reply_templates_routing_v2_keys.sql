-- Rollback for 20261030130000_auto_reply_templates_routing_v2_keys.
-- Removes the eight routing v2 keys from the check constraint and the RPC
-- allow-list, leaving every other key exactly as it was. Mappings on those keys
-- cannot exist under the restored constraint, so they are deleted (templates
-- themselves are untouched).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

delete from public.auto_reply_templates
where outcome in ('where_property', 'where_located', 'text_only', 'how_it_works', 'driving', 'price_too_high', 'no_repairs_realtor', 'fair_price');

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
    select array_agg(distinct m[1] order by m[1]) into v_keys
    from regexp_matches(v_def, '''([a-z_]+)''', 'g') m
    where m[1] <> all (array['where_property', 'where_located', 'text_only', 'how_it_works', 'driving', 'price_too_high', 'no_repairs_realtor', 'fair_price']);
    alter table public.auto_reply_templates drop constraint auto_reply_templates_outcome_check;
    execute format(
      'alter table public.auto_reply_templates add constraint auto_reply_templates_outcome_check check (outcome in (%s))',
      (select string_agg(quote_literal(k), ', ') from unnest(v_keys) k)
    );
  end if;

  v_fn := pg_get_functiondef(
    'public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)'::regprocedure
  );
  v_new := replace(v_fn, 'p_outcome not in (''where_property'', ''where_located'', ''text_only'', ''how_it_works'', ''driving'', ''price_too_high'', ''no_repairs_realtor'', ''fair_price'', ', 'p_outcome not in (');
  if v_new <> v_fn then
    execute v_new;
  end if;
end $$;

commit;
