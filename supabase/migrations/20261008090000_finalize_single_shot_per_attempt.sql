-- My Leads post-call prompt: finalize is single-shot per attempt (second-tab duplicate fix).
--
-- Two prompts for the same call (two browser tabs, or the call-screen dock plus a My Leads auto-open)
-- each mint their own idempotency key. The old guard refused a second finalize only when the outcome
-- differed, so a same-outcome save under a second key was accepted and the client then wrote the note
-- and the next-step appointment a second time. The guard now refuses ANY finalize for an attempt that
-- already has a finalize receipt under a different key (this key's own receipt is handled earlier and
-- still replays as a duplicate), with the distinct code ALREADY_FINALIZED (MLS01, never retried).
-- Defence in depth: fn_post_call_extras_foreign_finalize lets the extras writer ask whether a call was
-- already finalized under a different key (so a refused prompt's stored note/appointment write nothing).
-- Anchored, fail-loud patch of the live body: nothing else in the function changes. No data is touched.
-- Rollback twin: supabase/rollbacks/20261008090000_finalize_single_shot_per_attempt.sql
begin;

do $patch$
declare
  v_sig constant text := 'public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)';
  v_anchor constant text := $a$  if v_attempt.outcome is distinct from p_input->>'outcome' and exists(
    select 1 from public.acquisition_commands r where r.org_id=v_org
      and r.operation='finalize_acquisition_attempt' and r.result->>'attemptId'=v_attempt.id::text
  ) then raise exception 'STALE_STATE' using errcode='MLS01'; end if;$a$;
  v_repl constant text := $r$  if exists(
    select 1 from public.acquisition_commands r where r.org_id=v_org
      and r.operation='finalize_acquisition_attempt' and r.result->>'attemptId'=v_attempt.id::text
  ) then raise exception 'ALREADY_FINALIZED' using errcode='MLS01'; end if;$r$;
  v_def text;
  v_found int;
begin
  v_def := pg_get_functiondef(v_sig::regprocedure);
  v_found := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_found <> 1 then
    raise exception 'finalize single-shot patch: expected 1 anchor in %, found %', v_sig, v_found;
  end if;
  execute replace(v_def, v_anchor, v_repl);
  if position('ALREADY_FINALIZED' in pg_get_functiondef(v_sig::regprocedure)) = 0 then
    raise exception 'finalize single-shot patch: did not apply to %', v_sig;
  end if;
end $patch$;

create or replace function public.fn_post_call_extras_foreign_finalize(p_org uuid, p_attempt_key uuid, p_call_activity uuid)
returns boolean
language plpgsql stable security definer set search_path to '' as $function$
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid()
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  -- True only when this call's attempt was finalized by this rep under some OTHER key and never under p_attempt_key.
  return exists(
      select 1 from public.acquisition_commands r
      join public.acquisition_attempts a on a.id=(r.result->>'attemptId')::uuid and a.org_id=r.org_id
      where r.org_id=p_org and r.operation='finalize_acquisition_attempt' and r.idempotency_key<>p_attempt_key
        and a.call_activity_id=p_call_activity and a.actor_user_id=auth.uid())
    and not exists(
      select 1 from public.acquisition_commands r
      where r.org_id=p_org and r.operation='finalize_acquisition_attempt' and r.idempotency_key=p_attempt_key);
end;
$function$;
revoke all on function public.fn_post_call_extras_foreign_finalize(uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_post_call_extras_foreign_finalize(uuid, uuid, uuid) to authenticated, service_role;

commit;
