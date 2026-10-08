-- 20261008290000_auto_reply_templates_number_source.sql
-- Messages v2: approved "where did you get my number" reply (stacked on Phase 4,
-- 20261008240000). Widens the outcome -> template mapping key with
-- `number_source`, which is NOT a Jev outcome: it is keyed off Jev's separate
-- `asked_how_number_obtained` answer. The reply is the owner-approved library
-- template mapped here; no text, mapping or approval is created by this
-- migration.
--
-- Order-independent on purpose: PR #851 (migration 20261008270000) widens the
-- same check constraint and RPC allow-list with wrong_number / hostile. Rather
-- than hard-code the full list (which would drop or pre-grant those keys
-- depending on merge order), this patches whatever the live constraint and
-- function currently allow by adding `number_source`.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_def text;
  v_keys text[];
  v_fn text;
  v_new text;
  v_anchor constant text := 'p_outcome not in (''nurture'', ''not_interested''';
begin
  -- 1. CHECK constraint: current allow-list + number_source.
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conname = 'auto_reply_templates_outcome_check'
    and c.conrelid = 'public.auto_reply_templates'::regclass;
  if v_def is null then
    raise exception 'auto_reply_templates_outcome_check not found';
  end if;
  v_keys := array['nurture', 'not_interested'];
  if position('wrong_number' in v_def) > 0 then v_keys := v_keys || 'wrong_number'::text; end if;
  if position('hostile' in v_def) > 0 then v_keys := v_keys || 'hostile'::text; end if;
  v_keys := v_keys || 'number_source'::text;
  alter table public.auto_reply_templates drop constraint auto_reply_templates_outcome_check;
  execute format(
    'alter table public.auto_reply_templates add constraint auto_reply_templates_outcome_check check (outcome in (%s))',
    (select string_agg(quote_literal(k), ', ') from unnest(v_keys) k)
  );

  -- 2. RPC allow-list: same keys. Patch the live definition so a #851 widening
  --    (or its absence) is preserved exactly.
  v_fn := pg_get_functiondef(
    'public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)'::regprocedure
  );
  if position('number_source' in v_fn) = 0 then
    v_new := replace(v_fn, v_anchor, 'p_outcome not in (''number_source'', ''nurture'', ''not_interested''');
    if v_new = v_fn then
      raise exception 'fn_set_auto_reply_template allow-list anchor not found';
    end if;
    execute v_new;
  end if;
end $$;

commit;
