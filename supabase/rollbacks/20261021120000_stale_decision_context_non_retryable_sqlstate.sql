-- Roll back 20261021120000: puts errcode '40001' back on the STALE_DECISION_CONTEXT raise in the five functions, reading
-- each live definition and substituting only that raise (everything else byte-identical). WARNING: this re-enables the
-- PostgREST 14 infinite retry loop on stale decisions.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $migration$
declare
  v_old constant text := $q$raise exception 'STALE_DECISION_CONTEXT' using errcode = 'JDC01';$q$;
  v_new constant text := $q$raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';$q$;
  v_name text;
  v_oid oid;
  v_def text;
  v_count integer;
begin
  foreach v_name in array array[
    'fn_apply_ai_disposition_with_review',
    'fn_propose_deferred_ai_disposition_review',
    'fn_propose_jev_lead_decision',
    'fn_auto_apply_jev_lead_decision',
    'fn_propose_ai_dnc_suppression_review'
  ] loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name and p.prokind = 'f';
    if v_count <> 1 then
      raise exception 'expected exactly one public.% overload, found %', v_name, v_count;
    end if;

    select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_name and p.prokind = 'f';

    v_def := pg_get_functiondef(v_oid);
    v_count := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_count <> 1 then
      raise exception 'expected exactly one JDC01 STALE_DECISION_CONTEXT raise in public.%, found %', v_name, v_count;
    end if;

    execute replace(v_def, v_old, v_new);
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%STALE_DECISION_CONTEXT%'
      and pg_get_functiondef(p.oid) ~ $re$'STALE_DECISION_CONTEXT' using errcode = 'JDC01'$re$
  ) then
    raise exception 'a JDC01 STALE_DECISION_CONTEXT raise remains';
  end if;
end;
$migration$;

commit;
