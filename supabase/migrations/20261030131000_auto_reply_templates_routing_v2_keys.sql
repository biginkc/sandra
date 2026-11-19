-- 20261030131000_auto_reply_templates_routing_v2_keys.sql
-- SMS reply routing v2, PR-B: eight new outcome -> template mapping keys for the
-- approved v2 replies (where_property, where_located, text_only, how_it_works,
-- driving, price_too_high, no_repairs_realtor, fair_price). number_source
-- already exists (20261012020000).
--
-- Additive only. No template text, mapping or approval is created here: the texts
-- are seeded UNAPPROVED into the Templates library by code
-- (routing-v2/seed-v2-reply-templates.ts), an owner must approve each one, and the
-- v2 executor only sends while routing_v2_flags.questions_live + replies are on.
--
-- Order-independent: patches whatever keys the live constraint and RPC allow-list
-- currently hold, adding the new keys (same approach as 20261012020000).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_def text;
  v_keys text[];
  v_new_keys constant text[] := array['where_property', 'where_located', 'text_only', 'how_it_works', 'driving', 'price_too_high', 'no_repairs_realtor', 'fair_price'];
  v_fn text;
  v_new text;
  v_anchor constant text := 'p_outcome not in (';
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conname = 'auto_reply_templates_outcome_check'
    and c.conrelid = 'public.auto_reply_templates'::regclass;
  if v_def is null then
    raise exception 'auto_reply_templates_outcome_check not found';
  end if;
  select array_agg(distinct m[1]) into v_keys from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  select array_agg(distinct k order by k) into v_keys from unnest(v_keys || v_new_keys) k;
  alter table public.auto_reply_templates drop constraint auto_reply_templates_outcome_check;
  execute format(
    'alter table public.auto_reply_templates add constraint auto_reply_templates_outcome_check check (outcome in (%s))',
    (select string_agg(quote_literal(k), ', ') from unnest(v_keys) k)
  );

  v_fn := pg_get_functiondef(
    'public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)'::regprocedure
  );
  if position('fair_price' in v_fn) = 0 then
    v_new := replace(
      v_fn,
      v_anchor,
      v_anchor || '''where_property'', ''where_located'', ''text_only'', ''how_it_works'', ''driving'', ''price_too_high'', ''no_repairs_realtor'', ''fair_price'', '
    );
    if v_new = v_fn then
      raise exception 'fn_set_auto_reply_template allow-list anchor not found';
    end if;
    execute v_new;
  end if;
end $$;

commit;
