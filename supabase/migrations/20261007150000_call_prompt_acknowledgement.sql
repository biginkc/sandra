-- My Leads one-call close, P2 UI (2.6): durable unacknowledged-call prompts.
--
-- Replaces the 5-intent / 1-hour listRecentDialpadCalls window with a persisted acknowledgement on
-- the attempt row and a paginated read RPC, so a call that ended yesterday still pops its post-call
-- prompt the next time /my-leads is opened, and a prompt the rep closed never pops again.
--
-- NO data step. The five canary attempts already in production are acknowledged later by the
-- service-only housekeeping function fn_my_leads_ack_legacy_call_prompts (run kind
-- 'ack_legacy_prompts', preview then --confirm, before-image first), which must run before the
-- auto_prompt flag is turned on. Inert until auto_prompt is on and schemaReady('ack_prompts') is true.
--
-- The housekeeping rollback entry point and its fingerprint are patched in place (anchored, asserted,
-- idempotent) to add the ack_legacy_prompts branch; every other line of the live bodies is untouched.
begin;

alter table public.acquisition_attempts
  add column if not exists prompt_acknowledged_at timestamptz,
  add column if not exists prompt_acknowledged_via text
    check (prompt_acknowledged_via is null or prompt_acknowledged_via in ('saved', 'skipped', 'dismissed'));

create index if not exists acquisition_attempts_unacked_prompt_idx
  on public.acquisition_attempts (org_id, actor_user_id, occurred_at desc, id desc)
  where prompt_acknowledged_at is null and outcome is null and call_activity_id is not null
    and public.dialpad_cti_is_ledger_key(provider_attempt_key);

-- Read RPC: the caller's own ended, outcome-less, unacknowledged Dialpad calls on leads still assigned
-- to them. Personal (auth.uid()), keyset paginated on (c.ended_at, a.id) descending.
create or replace function public.fn_list_unacknowledged_call_prompts(
  p_org_id uuid,
  p_limit integer default 20,
  p_before_ended timestamptz default null,
  p_before_id uuid default null,
  p_horizon interval default interval '14 days'
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_items jsonb;
  v_count integer;
  v_last record;
begin
  if p_org_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform public.my_leads_require_read_scope(p_org_id, v_uid);
  if (p_before_ended is null) <> (p_before_id is null) then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'cursor_incomplete';
  end if;

  with page as (
    select a.id as attempt_id, a.property_id, a.call_activity_id, c.ended_at, c.duration_seconds,
           c.talk_duration_seconds,
           case when a.provider_attempt_key like 'dialpad-native:%' then 'native' else 'sandra' end as origin,
           case
             when c.outcome = 'voicemail' or c.provider_voicemail_url is not null then 'voicemail'
             when c.outcome = 'no_answer' then 'no_answer'
             when c.outcome in ('unknown', 'connected_human') and coalesce(c.talk_duration_seconds, 0) > 0 then 'reached'
             else null
           end as outcome_guess,
           (c.outcome = 'voicemail' or c.provider_voicemail_url is not null) as voicemail
    from public.acquisition_attempts a
    join public.call_activities c on c.id = a.call_activity_id and c.org_id = a.org_id
    join public.properties p on p.id = a.property_id and p.org_id = a.org_id
    where a.org_id = p_org_id
      and a.actor_user_id = v_uid
      and a.source = 'dialpad'
      and public.dialpad_cti_is_ledger_key(a.provider_attempt_key)
      and a.outcome is null
      and a.prompt_acknowledged_at is null
      and c.ended_at is not null
      and c.call_purpose = 'customer'
      and c.ended_at > now() - coalesce(p_horizon, interval '14 days')
      and p.assigned_user_id = v_uid
      and p.deleted_at is null
      and (p_before_ended is null or (c.ended_at, a.id) < (p_before_ended, p_before_id))
    order by c.ended_at desc, a.id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'attemptId', attempt_id, 'propertyId', property_id, 'callActivityId', call_activity_id,
           'endedAt', ended_at, 'durationSeconds', duration_seconds, 'talkDurationSeconds', talk_duration_seconds,
           'origin', origin, 'outcomeGuess', outcome_guess, 'voicemail', voicemail)
           order by ended_at desc, attempt_id desc), '[]'::jsonb),
         count(*)::int
  into v_items, v_count
  from page;

  if v_count = v_limit then
    select (v_items -> (v_count - 1) ->> 'endedAt')::timestamptz as ended_at,
           (v_items -> (v_count - 1) ->> 'attemptId')::uuid as attempt_id
    into v_last;
    return jsonb_build_object('items', v_items,
      'nextCursor', jsonb_build_object('beforeEnded', v_last.ended_at, 'beforeId', v_last.attempt_id));
  end if;
  return jsonb_build_object('items', v_items, 'nextCursor', null);
end;
$$;
revoke all on function public.fn_list_unacknowledged_call_prompts(uuid, integer, timestamptz, uuid, interval)
  from public, anon, service_role;
grant execute on function public.fn_list_unacknowledged_call_prompts(uuid, integer, timestamptz, uuid, interval)
  to authenticated;

-- Ack RPC: idempotent, personal. The outcome is never touched here; a skipped prompt leaves the
-- attempt pending (outcome null) and the touch still counts (D9).
create or replace function public.fn_acknowledge_call_prompt(p_org_id uuid, p_attempt_id uuid, p_via text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_attempt public.acquisition_attempts%rowtype;
begin
  if p_org_id is null or p_attempt_id is null or p_via is null or p_via not in ('saved', 'skipped', 'dismissed') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  perform public.my_leads_require_read_scope(p_org_id, v_uid);
  select * into v_attempt from public.acquisition_attempts
    where id = p_attempt_id and org_id = p_org_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_attempt.actor_user_id <> v_uid then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'not_own_attempt';
  end if;
  if v_attempt.prompt_acknowledged_at is not null then
    return jsonb_build_object('status', 'already', 'attemptId', v_attempt.id,
      'acknowledgedAt', v_attempt.prompt_acknowledged_at, 'via', v_attempt.prompt_acknowledged_via);
  end if;
  update public.acquisition_attempts
    set prompt_acknowledged_at = now(), prompt_acknowledged_via = p_via
    where id = v_attempt.id
    returning * into v_attempt;
  return jsonb_build_object('status', 'acknowledged', 'attemptId', v_attempt.id,
    'acknowledgedAt', v_attempt.prompt_acknowledged_at, 'via', v_attempt.prompt_acknowledged_via);
end;
$$;
revoke all on function public.fn_acknowledge_call_prompt(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.fn_acknowledge_call_prompt(uuid, uuid, text) to authenticated;

-- Legacy acknowledgement (service only, housekeeping contract): every pre-existing unacknowledged
-- Dialpad ledger attempt of the org is marked 'dismissed' so the prompt never pops for calls that
-- predate the feature. Preview returns the cohort and fingerprint and writes nothing; apply needs
-- the fingerprint, locks the rows in id order, recomputes under lock, and records before-images.
create or replace function public.fn_my_leads_ack_legacy_call_prompts(
  p_org_id uuid,
  p_apply boolean default false,
  p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
  v_fp text;
  v_sample jsonb;
  v_preview jsonb;
  v_run uuid;
  v_now timestamptz;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;

  if p_apply then
    if p_fingerprint is null then
      raise exception 'FINGERPRINT_REQUIRED: apply needs the fingerprint from the preview' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    perform 1 from public.acquisition_attempts a
    where a.org_id = p_org_id and a.prompt_acknowledged_at is null
      and public.dialpad_cti_is_ledger_key(a.provider_attempt_key)
    order by a.id for update;
  end if;

  select count(*)::int,
         encode(sha256(convert_to('ack_legacy_prompts|' || coalesce(string_agg(
           a.id::text || ':' || coalesce(a.provider_attempt_key, '') || ':' || coalesce(a.prompt_acknowledged_at::text, ''),
           ',' order by a.id), ''), 'utf8')), 'hex')
  into v_count, v_fp
  from public.acquisition_attempts a
  where a.org_id = p_org_id and a.prompt_acknowledged_at is null
    and public.dialpad_cti_is_ledger_key(a.provider_attempt_key);
  select coalesce(jsonb_agg(u.x order by u.x), '[]'::jsonb) into v_sample from (
    select a.id::text as x from public.acquisition_attempts a
    where a.org_id = p_org_id and a.prompt_acknowledged_at is null
      and public.dialpad_cti_is_ledger_key(a.provider_attempt_key)
    order by a.id limit 20) u;

  v_preview := jsonb_build_object('kind', 'ack_legacy_prompts', 'candidates', v_count, 'sample', v_sample, 'fingerprint', v_fp);
  if not p_apply then
    return v_preview;
  end if;
  if p_fingerprint is distinct from v_fp then
    raise exception 'FINGERPRINT_MISMATCH: the cohort changed since the preview; run a new preview' using errcode = 'P0001';
  end if;
  if v_count = 0 then
    return v_preview || jsonb_build_object('noop', true, 'runId', null);
  end if;

  v_now := clock_timestamp();
  insert into public.my_leads_housekeeping_runs (org_id, kind, params, created_at)
  values (p_org_id, 'ack_legacy_prompts', jsonb_build_object('fingerprint', v_fp), clock_timestamp())
  returning id into v_run;

  insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
  select v_run, 'acquisition_attempts', a.id,
         jsonb_build_object('op', 'updated', 'prompt_acknowledged_at', a.prompt_acknowledged_at,
                            'prompt_acknowledged_via', a.prompt_acknowledged_via,
                            'applied_at', v_now, 'applied_via', 'dismissed')
  from public.acquisition_attempts a
  where a.org_id = p_org_id and a.prompt_acknowledged_at is null
    and public.dialpad_cti_is_ledger_key(a.provider_attempt_key);

  update public.acquisition_attempts a
  set prompt_acknowledged_at = v_now, prompt_acknowledged_via = 'dismissed'
  where a.org_id = p_org_id and a.prompt_acknowledged_at is null
    and public.dialpad_cti_is_ledger_key(a.provider_attempt_key);

  update public.my_leads_housekeeping_runs
  set summary = jsonb_build_object('acknowledged', v_count)
  where id = v_run and org_id = p_org_id;
  return v_preview || jsonb_build_object('runId', v_run, 'acknowledged', v_count);
end $$;
revoke all on function public.fn_my_leads_ack_legacy_call_prompts(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_my_leads_ack_legacy_call_prompts(uuid, boolean, text) to service_role;

-- Rollback support: anchored patches of the live fingerprint and rollback functions.
do $patch$
declare
  r record;
  v_def text;
  v_found int;
begin
  for r in select * from (values
    ('public.my_leads_housekeeping_rollback_fingerprint(uuid,uuid)',
      E'          when ''acquisition_attempts'' then (select coalesce(a.outcome, '''')\n',
      E'          when ''acquisition_attempts'' then (select coalesce(a.outcome, '''')\n'
      '            || case when r.kind = ''ack_legacy_prompts'' then ''/'' || coalesce(a.prompt_acknowledged_at::text, '''') || ''/'' || coalesce(a.prompt_acknowledged_via, '''') else '''' end\n'),
    ('public.fn_my_leads_housekeeping_rollback(uuid,uuid,text)',
      E'  else\n    raise exception ''ROLLBACK_UNSUPPORTED',
      E'  elsif v_run.kind = ''ack_legacy_prompts'' then\n'
      '    -- An acknowledgement goes back to null only while the row still carries exactly what the run\n'
      '    -- wrote (dismissed, at the run timestamp); a row acknowledged again by the rep is reported.\n'
      '    select count(*)::int into v_images\n'
      '    from public.my_leads_housekeeping_before_images b\n'
      '    where b.run_id = p_run and b.table_name = ''acquisition_attempts'';\n'
      '    update public.acquisition_attempts a\n'
      '    set prompt_acknowledged_at = null, prompt_acknowledged_via = null\n'
      '    from public.my_leads_housekeeping_before_images b\n'
      '    where b.run_id = p_run and b.table_name = ''acquisition_attempts''\n'
      '      and b.row_id = a.id and a.org_id = p_org_id\n'
      '      and a.prompt_acknowledged_via = ''dismissed''\n'
      '      and a.prompt_acknowledged_at = (b.before ->> ''applied_at'')::timestamptz;\n'
      '    get diagnostics v_restored = row_count;\n'
      '    if v_restored < v_images then\n'
      '      select coalesce(jsonb_agg(jsonb_build_object(''attempt'', b.row_id, ''reason'', ''acknowledgement_changed_since'')), ''[]''::jsonb)\n'
      '      into v_not_restored\n'
      '      from public.my_leads_housekeeping_before_images b\n'
      '      join public.acquisition_attempts a on a.id = b.row_id and a.org_id = p_org_id\n'
      '      where b.run_id = p_run and b.table_name = ''acquisition_attempts''\n'
      '        and a.prompt_acknowledged_at is not null;\n'
      '    end if;\n'
      '  else\n    raise exception ''ROLLBACK_UNSUPPORTED')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    v_found := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if position(r.repl in v_def) > 0 then continue; end if; -- already patched
    if v_found <> 1 then
      raise exception 'ack legacy prompts rollback patch: expected one anchor in %, found %', r.sig, v_found;
    end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $patch$;

commit;
