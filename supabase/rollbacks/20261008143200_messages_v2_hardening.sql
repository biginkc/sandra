-- Rollback for 20261008143200_messages_v2_hardening. Apply AFTER rolling back
-- 20261008143300_messages_v2_send_reservation (which depends on this table).
-- Restores: reset_tenant_tables (no ai_reply_drafts / automation_enabled), the
-- 5-arg fn_set_jev_outcome_threshold (verbatim from 20261008140000), the
-- any-active-member check inside the decision RPCs, and the SELECT policies.
begin;

-- reset_tenant_tables: undo the three textual patches (each is a no-op if the
-- patched text is absent, so a repeated rollback is safe).
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'    public.ai_reply_drafts,\n    public.jev_lead_decisions,', E'    public.jev_lead_decisions,');
  v_new := replace(v_new, '(org_id, outcome, min_confidence, version, updated_by, automation_enabled)',
    '(org_id, outcome, min_confidence, version, updated_by)');
  v_new := replace(v_new, 'select o.id, v.outcome, v.min_confidence, 1, null, (v.outcome <> ''new_lead'')',
    'select o.id, v.outcome, v.min_confidence, 1, null');
  if v_new <> v_def then execute v_new; end if;
end $$;

-- Decision RPCs: put the any-active-member check back.
do $$
declare
  v_fn record;
  v_def text;
  v_new text;
  v_old constant text := 'if not public.hugo_has_active_org_access(v_decision.org_id) then';
  v_repl constant text :=
    'if not (public.hugo_has_active_org_access(v_decision.org_id) and public.pipeline_runs_can_read(v_decision.org_id)) then';
begin
  for v_fn in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'fn_confirm_jev_lead_decision',
        'fn_correct_jev_lead_decision',
        'fn_apply_and_record_jev_lead_decision_correction',
        'fn_mark_jev_lead_decision_reviewed',
        'fn_begin_jev_lead_decision_correction',
        'fn_record_jev_lead_decision_correction'
      )
  loop
    v_def := pg_get_functiondef(v_fn.oid);
    v_new := replace(v_def, v_repl, v_old);
    if v_new <> v_def then execute v_new; end if;
  end loop;
end $$;

drop function if exists public.pipeline_runs_latest_for_properties(uuid, uuid[]);
drop index if exists public.idx_pipeline_runs_running_started;
drop table if exists public.ai_reply_drafts;
alter table public.ai_responder_configs drop constraint if exists ai_responder_configs_outbound_mode_check;
alter table public.ai_responder_configs drop column if exists outbound_mode;

drop function if exists public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid, boolean);
alter table public.jev_outcome_threshold_history
  drop column if exists previous_automation_enabled,
  drop column if exists new_automation_enabled;
alter table public.jev_outcome_thresholds drop column if exists automation_enabled;

-- 5-arg definition, verbatim from 20261008140000_jev_outcome_thresholds.sql.
create or replace function public.fn_set_jev_outcome_threshold(
  p_org_id uuid,
  p_outcome text,
  p_min_confidence numeric,
  p_expected_version integer,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_threshold_id uuid;
  v_current_version integer;
  v_previous_confidence numeric(4,3);
  v_new_version integer;
  v_existing_history public.jev_outcome_threshold_history%rowtype;
  v_result jsonb;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_org_id is null or p_outcome is null or p_min_confidence is null
     or p_expected_version is null or p_expected_version < 0
     or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_outcome not in ('new_lead', 'wrong_number', 'not_interested', 'nurture', 'opted_out') then
    raise exception 'INVALID_OUTCOME' using errcode = '22023';
  end if;
  if p_min_confidence < 0 or p_min_confidence > 1 then
    raise exception 'INVALID_CONFIDENCE' using errcode = '22023';
  end if;

  -- Root PR-review finding (2026-09-20): normalize BEFORE any comparison
  -- or storage, not just at the column type. The column is numeric(4,3),
  -- so a caller-supplied value with more precision (e.g. 0.9555) would
  -- otherwise be compared against its own future re-round on replay —
  -- the idempotency check below would see the raw 0.9555 not-equal to
  -- the stored, already-rounded 0.956 and wrongly raise
  -- IDEMPOTENCY_CONFLICT on a genuine identical-request replay. Rounding
  -- once, here, means every later reference to p_min_confidence (the
  -- idempotency comparison, the insert/update, the returned result) is
  -- already the exact value that will be stored.
  p_min_confidence := round(p_min_confidence, 3);

  -- Owner-role, active-membership authorization — the actual boundary.
  -- App-side admin-email checks are UX only; this is what actually gates
  -- the write, and it cannot be bypassed by a client that skips the app
  -- layer (a direct RPC call still hits this same check).
  if not exists (
    select 1
    from public.memberships m
    where m.user_id = v_actor
      and m.org_id = p_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  -- Serialize concurrent edits to the same org/outcome cutoff.
  perform pg_advisory_xact_lock(hashtextextended(
    format('jev-outcome-threshold:%s:%s', p_org_id, p_outcome), 0
  ));

  -- Idempotent replay: an identical request (same org/outcome/key) already
  -- recorded — return that result rather than writing again. A caller that
  -- reuses the key with a different requested value gets a hard conflict
  -- instead of a silently-wrong "success".
  select * into v_existing_history
  from public.jev_outcome_threshold_history h
  where h.org_id = p_org_id
    and h.outcome = p_outcome
    and h.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_history.new_min_confidence is distinct from p_min_confidence then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
    end if;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'orgId', p_org_id,
      'outcome', p_outcome,
      'minConfidence', v_existing_history.new_min_confidence,
      'version', v_existing_history.version
    );
  end if;

  select id, version, min_confidence
  into v_threshold_id, v_current_version, v_previous_confidence
  from public.jev_outcome_thresholds
  where org_id = p_org_id and outcome = p_outcome
  for update;

  if not found then
    v_current_version := 0;
    v_previous_confidence := null;
  end if;

  if v_current_version is distinct from p_expected_version then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  v_new_version := v_current_version + 1;

  if v_threshold_id is null then
    insert into public.jev_outcome_thresholds (
      org_id, outcome, min_confidence, version, updated_at, updated_by
    ) values (
      p_org_id, p_outcome, p_min_confidence, v_new_version, statement_timestamp(), v_actor
    )
    returning id into v_threshold_id;
  else
    update public.jev_outcome_thresholds
    set min_confidence = p_min_confidence,
        version = v_new_version,
        updated_at = statement_timestamp(),
        updated_by = v_actor
    where id = v_threshold_id;
  end if;

  insert into public.jev_outcome_threshold_history (
    threshold_id, org_id, outcome, previous_min_confidence,
    new_min_confidence, version, changed_by, idempotency_key
  ) values (
    v_threshold_id, p_org_id, p_outcome, v_previous_confidence,
    p_min_confidence, v_new_version, v_actor, p_idempotency_key
  );

  v_result := jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'orgId', p_org_id,
    'outcome', p_outcome,
    'minConfidence', p_min_confidence,
    'version', v_new_version
  );
  return v_result;
end;
$$;

revoke all on function public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid)
  from public, anon, service_role;
grant execute on function public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid)
  to authenticated;

drop policy if exists jev_lead_decisions_org_select on public.jev_lead_decisions;
create policy jev_lead_decisions_org_select on public.jev_lead_decisions
  for select to authenticated using (public.hugo_has_active_org_access(org_id));

drop policy if exists pipeline_runs_org_select on public.pipeline_runs;
create policy pipeline_runs_org_select on public.pipeline_runs
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and public.pipeline_runs_can_read(org_id));
drop policy if exists pipeline_run_steps_org_select on public.pipeline_run_steps;
create policy pipeline_run_steps_org_select on public.pipeline_run_steps
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and public.pipeline_runs_can_read(org_id));

commit;
