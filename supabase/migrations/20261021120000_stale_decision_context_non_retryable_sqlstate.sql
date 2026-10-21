-- Stop PostgREST's endless retry of STALE_DECISION_CONTEXT. ERROR CODE ONLY: no business rule, message, or behaviour change.
--
-- Incident (prod, 2026-10-21): STALE_DECISION_CONTEXT raised ~360k times/hour, all from PostgREST 14.5, inside
-- fn_apply_ai_disposition_with_review. Every STALE_DECISION_CONTEXT raise used errcode '40001' (serialization_failure).
-- PostgREST 14 treats 40001 as a transient conflict and re-runs the whole transaction, with no limit; the revision check
-- is deterministic, so the request never finishes and the caller never sees the error (Supabase troubleshooting guide
-- "SQLSTATE 40001 (serialization_failure) in an RPC function causes infinite retries"). Same rationale as
-- MY_LEADS_CONFLICT_SQLSTATE ('MLS01') in src/lib/my-leads/sqlstate.ts.
--
-- Fix: re-create the CURRENT definition of each of the five functions that raise it, with that one raise's errcode changed
-- from '40001' to 'JDC01' (a dedicated, non-retryable code; PostgREST returns it as a plain HTTP 400). The definition is
-- read from the live catalog (pg_get_functiondef) and only the exact raise statement is substituted, so the rest of each
-- function (body, SECURITY DEFINER, search_path, signature) is byte-identical to what is deployed. CREATE OR REPLACE keeps
-- owner and grants. Callers (src/lib/ai-responder/dispatch.ts) match on the message text, which is unchanged; nothing
-- matches these functions' 40001.
-- Rollback: supabase/rollbacks/20261021120000_stale_decision_context_non_retryable_sqlstate.sql.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $migration$
declare
  v_old constant text := $q$raise exception 'STALE_DECISION_CONTEXT' using errcode = '40001';$q$;
  v_new constant text := $q$raise exception 'STALE_DECISION_CONTEXT' using errcode = 'JDC01';$q$;
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
      raise exception 'expected exactly one 40001 STALE_DECISION_CONTEXT raise in public.%, found %', v_name, v_count;
    end if;

    execute replace(v_def, v_old, v_new);
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%STALE_DECISION_CONTEXT%'
      and pg_get_functiondef(p.oid) ~ $re$'STALE_DECISION_CONTEXT' using errcode = '40001'$re$
  ) then
    raise exception 'a 40001 STALE_DECISION_CONTEXT raise remains';
  end if;
end;
$migration$;

commit;
