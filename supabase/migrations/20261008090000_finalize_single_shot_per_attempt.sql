-- My Leads post-call prompt: finalize is single-shot per attempt (second-tab duplicate fix).
--
-- Two prompts for the same call (two browser tabs, or the call-screen dock plus a My Leads auto-open)
-- each mint their own idempotency key. The old guard refused a second finalize only when the outcome
-- differed, so a same-outcome save under a second key was accepted and the client then wrote the note
-- and the next-step appointment a second time. The guard now refuses ANY finalize for an attempt that
-- already has a finalize receipt under a different key (this key's own receipt is handled earlier and
-- still replays as a duplicate), with the distinct code ALREADY_FINALIZED (MLS01, never retried).
-- Defence in depth: fn_post_call_extras_proof is the only gate for the post-call note and appointment: positive proof
-- (this actor's key holds the attempt's receipt) returns attempt-derived idempotency keys; another key finalizing
-- the call returns foreign; no receipt returns pending (nothing written, extras kept for retry).
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

create or replace function public.fn_post_call_extras_proof(
  p_org uuid, p_property uuid, p_attempt_key uuid, p_call_activity uuid default null)
returns jsonb
language plpgsql stable security definer set search_path to '' as $function$
declare
  v_attempt uuid;
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org and m.user_id=auth.uid()
    and m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  -- Positive proof only: THIS actor's key holds the finalize (or manual log) receipt of an attempt on THIS lead.
  select a.id into v_attempt
    from public.acquisition_commands r
    join public.acquisition_attempts a on a.id=(r.result->>'attemptId')::uuid and a.org_id=r.org_id
   where r.org_id=p_org and r.idempotency_key=p_attempt_key
     and r.operation in ('finalize_acquisition_attempt','log_acquisition_attempt')
     and r.actor_user_id=auth.uid() and a.actor_user_id=auth.uid() and a.property_id=p_property
   limit 1;
  if found then
    -- Keys derive from the attempt, so any number of openings or retries map to one note and one appointment
    -- through the existing unique indexes (lead_notes idempotency, tasks booking idempotency).
    return jsonb_build_object('status','proven','attemptId',v_attempt,
      'noteKey',md5('post_call_note:'||v_attempt::text)::uuid,
      'nextStepKey',md5('post_call_next_step:'||v_attempt::text)::uuid);
  end if;
  -- Another key already finalized this call: this prompt's extras belong to a refused save.
  if p_call_activity is not null and exists(
      select 1 from public.acquisition_commands r
      join public.acquisition_attempts a on a.id=(r.result->>'attemptId')::uuid and a.org_id=r.org_id
     where r.org_id=p_org and r.operation='finalize_acquisition_attempt' and r.idempotency_key<>p_attempt_key
       and a.call_activity_id=p_call_activity and a.property_id=p_property and a.actor_user_id=auth.uid()) then
    return jsonb_build_object('status','foreign');
  end if;
  -- No proof either way (the save may never have committed): write nothing, keep the extras for a retry.
  return jsonb_build_object('status','pending');
end;
$function$;
revoke all on function public.fn_post_call_extras_proof(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_post_call_extras_proof(uuid, uuid, uuid, uuid) to authenticated, service_role;

commit;
