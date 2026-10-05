-- My Leads one-call close, P1a-core (1a.5): relabel run, mode setter, retire preflight, and the
-- rollback entry point extended with a `relabel` branch.
--
-- Definitions only. NO data step runs at merge: the relabel is an operator run
-- (scripts/my-leads-housekeeping.mjs relabel: preview, then --apply --confirm <fingerprint>),
-- every function is service-role only and takes p_org_id. fn_my_leads_housekeeping_rollback and
-- my_leads_housekeeping_rollback_fingerprint are copy-replaced from 20261005100100: the reassign
-- and close_attempts branches are byte-identical; this file adds the relabel branch, the
-- attribution/relabel-task fence in the fingerprint, and row locks for the attribution rows.
-- The rollback twin restores the 20261005100100 bodies verbatim.
begin;

-- Internal: the ids of the open future legacy next steps a relabel would convert. Effective due =
-- the snoozed time for a snoozed row; open and future only (completed/cancelled/past-due rows are
-- history); the property must exist and not be DNC-locked.
create or replace function public.my_leads_relabel_candidate_ids(p_org_id uuid, p_cutoff timestamptz)
returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(t.id order by t.id), '{}'::uuid[])
  from public.tasks t
  join public.properties p on p.id = t.related_property_id and p.org_id = t.org_id
  where t.org_id = p_org_id
    and t.type in ('callback', 'follow_up')
    and t.status in ('open', 'snoozed')
    and greatest(t.due_at, case when t.status = 'snoozed' then t.snoozed_until end) > p_cutoff
    and p.deleted_at is null
    and not coalesce(p.is_dnc_locked, false)
$$;

-- Relabel run (kind 'relabel'): converts open future callback / follow_up rows to phone
-- appointments in place. No ledger row (phone appointments never get a Google event). Service
-- role only; definitions only, the merge runs nothing.
create or replace function public.fn_my_leads_relabel_open_next_steps(
  p_org_id uuid,
  p_expected_assignee uuid,
  p_apply boolean default false,
  p_fingerprint text default null,
  p_cutoff timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cutoff timestamptz;
  v_ids uuid[];
  v_run uuid;
  t record;
  v_fp text;
  v_preview jsonb;
  v_candidates int;
  v_snoozed int;
  v_skipped_locked int;
  v_mismatch int;
  v_by_type jsonb;
  v_by_assignee jsonb;
  v_has_settings boolean;
  v_prior_flag text;
  v_due timestamptz;
  v_rows int;
  v_applied_updated timestamptz;
  v_applied_end timestamptz;
  v_applied_chain uuid;
  v_captured timestamptz;
  v_converted int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null or p_expected_assignee is null then
    raise exception 'INVALID_INPUT: org and expected assignee are required' using errcode = 'P0001';
  end if;
  -- The preview reports the cutoff it used; apply must be handed that same timestamp.
  if p_apply and p_cutoff is null then
    raise exception 'CUTOFF_REQUIRED: apply needs the cutoff from the preview' using errcode = 'P0001';
  end if;
  v_cutoff := coalesce(p_cutoff, statement_timestamp());
  if v_cutoff > statement_timestamp() + interval '1 minute' or v_cutoff < statement_timestamp() - interval '1 day' then
    raise exception 'INVALID_INPUT: cutoff must be within the last day' using errcode = 'P0001';
  end if;

  if p_apply then
    if p_fingerprint is null then
      raise exception 'FINGERPRINT_REQUIRED: apply needs the fingerprint from the preview' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    perform 1 from public.tasks tk
    where tk.org_id = p_org_id and tk.id = any(public.my_leads_relabel_candidate_ids(p_org_id, v_cutoff))
    order by tk.id for update;
  end if;
  -- The id array is built once (under the locks on apply); the fingerprint and every
  -- mutation use exactly this array.
  v_ids := public.my_leads_relabel_candidate_ids(p_org_id, v_cutoff);
  v_candidates := coalesce(array_length(v_ids, 1), 0);

  select count(*) filter (where tk.status = 'snoozed')::int,
         count(*) filter (where tk.assignee_id <> p_expected_assignee)::int
  into v_snoozed, v_mismatch
  from public.tasks tk where tk.org_id = p_org_id and tk.id = any(v_ids);
  select coalesce(jsonb_object_agg(s.type, s.n), '{}'::jsonb) into v_by_type
  from (select tk.type, count(*) as n from public.tasks tk
        where tk.org_id = p_org_id and tk.id = any(v_ids) group by tk.type) s;
  select coalesce(jsonb_agg(jsonb_build_object('assignee', s.assignee_id, 'count', s.n) order by s.assignee_id), '[]'::jsonb)
  into v_by_assignee
  from (select tk.assignee_id, count(*) as n from public.tasks tk
        where tk.org_id = p_org_id and tk.id = any(v_ids) group by tk.assignee_id) s;
  -- Visibility only: same filter, but the property is deleted or DNC-locked (never touched).
  select count(*)::int into v_skipped_locked
  from public.tasks tk
  join public.properties p on p.id = tk.related_property_id and p.org_id = tk.org_id
  where tk.org_id = p_org_id
    and tk.type in ('callback', 'follow_up')
    and tk.status in ('open', 'snoozed')
    and greatest(tk.due_at, case when tk.status = 'snoozed' then tk.snoozed_until end) > v_cutoff
    and (p.deleted_at is not null or coalesce(p.is_dnc_locked, false));

  select encode(sha256(convert_to('relabel|' || p_expected_assignee::text || '|' || v_cutoff::text || '|' ||
           coalesce(string_agg(tk.id::text || ':' || tk.type || ':' || tk.status || ':' || tk.due_at::text || ':' ||
             coalesce(tk.snoozed_until::text, '') || ':' || tk.assignee_id::text || ':' || tk.updated_at::text,
             ',' order by tk.id), ''), 'utf8')), 'hex')
  into v_fp
  from public.tasks tk where tk.org_id = p_org_id and tk.id = any(v_ids);

  v_preview := jsonb_build_object(
    'kind', 'relabel',
    'cutoff', v_cutoff,
    'expectedAssignee', p_expected_assignee,
    'candidates', v_candidates,
    'snoozedToOpen', v_snoozed,
    'skippedLocked', v_skipped_locked,
    'byType', v_by_type,
    'byAssignee', v_by_assignee,
    'assigneeMismatch', v_mismatch,
    'fingerprint', v_fp);

  if not p_apply then
    return v_preview;
  end if;
  if p_fingerprint is distinct from v_fp then
    raise exception 'FINGERPRINT_MISMATCH: the cohort changed since the preview; run a new preview' using errcode = 'P0001';
  end if;
  if v_mismatch > 0 then
    raise exception 'ASSIGNEE_MISMATCH: % rows', v_mismatch using errcode = 'P0001';
  end if;
  if v_candidates = 0 then
    return v_preview || jsonb_build_object('noop', true, 'runId', null);
  end if;

  v_has_settings := exists (select 1 from public.acquisition_org_settings s where s.org_id = p_org_id);
  insert into public.my_leads_housekeeping_runs (org_id, kind, params, created_at)
  values (p_org_id, 'relabel', jsonb_build_object(
    'expectedAssignee', p_expected_assignee, 'cutoff', v_cutoff, 'fingerprint', v_fp), clock_timestamp())
  returning id into v_run;

  for t in
    select tk.id, tk.type, tk.status, tk.due_at, tk.snoozed_until, tk.end_at, tk.calendar_chain_id,
           tk.mode, tk.related_property_id, tk.assignee_id, tk.updated_at,
           greatest(tk.due_at, case when tk.status = 'snoozed' then tk.snoozed_until end) as eff_due
    from public.tasks tk
    where tk.org_id = p_org_id and tk.id = any(v_ids)
    order by tk.id
  loop
    v_prior_flag := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
    begin
      v_due := t.eff_due;
      -- Before-image first; the row is updated only where one exists.
      insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
      values (v_run, 'tasks', t.id, jsonb_build_object(
        'op', 'updated', 'type', t.type, 'status', t.status, 'due_at', t.due_at,
        'snoozed_until', t.snoozed_until, 'end_at', t.end_at, 'calendar_chain_id', t.calendar_chain_id,
        'mode', t.mode, 'related_property_id', t.related_property_id, 'assignee_id', t.assignee_id,
        'updated_at', t.updated_at));
      perform set_config('sandra.allow_appointment_time_move', 'on', true);
      update public.tasks
      set type = 'appointment', mode = 'phone', due_at = v_due, end_at = v_due + interval '15 minutes',
          status = 'open', snoozed_until = null, calendar_chain_id = gen_random_uuid(), updated_at = now()
      where id = t.id and org_id = p_org_id and type in ('callback', 'follow_up')
        and status in ('open', 'snoozed')
        and id in (select b.row_id from public.my_leads_housekeeping_before_images b
                   where b.run_id = v_run and b.table_name = 'tasks');
      get diagnostics v_rows = row_count;
      perform set_config('sandra.allow_appointment_time_move', v_prior_flag, true);
      if v_rows <> 1 then
        raise exception 'TASK_CHANGED' using errcode = 'P0001';
      end if;
      select tk.updated_at, tk.end_at, tk.calendar_chain_id into v_applied_updated, v_applied_end, v_applied_chain
      from public.tasks tk where tk.id = t.id and tk.org_id = p_org_id;
      update public.my_leads_housekeeping_before_images b
      set before = b.before || jsonb_build_object(
        'applied_updated_at', v_applied_updated, 'applied_due_at', v_due,
        'applied_end_at', v_applied_end, 'applied_calendar_chain_id', v_applied_chain)
      where b.run_id = v_run and b.table_name = 'tasks' and b.row_id = t.id;

      -- The attribution trigger fires on INSERT only, so the relabel records it by hand, under
      -- the trigger's own conditions (appointment with a property, org has acquisition settings).
      if v_has_settings and t.related_property_id is not null then
        insert into public.acquisition_appointment_attribution (task_id, org_id, accountable_user_id, source)
        values (t.id, p_org_id, t.assignee_id, 'relabel_2026_10')
        on conflict (task_id) do nothing
        returning captured_at into v_captured;
        get diagnostics v_rows = row_count;
        if v_rows = 1 then
          insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
          values (v_run, 'acquisition_appointment_attribution', t.id, jsonb_build_object(
            'op', 'created', 'source', 'relabel_2026_10', 'accountable_user_id', t.assignee_id,
            'applied_captured_at', v_captured));
        end if;
      end if;
      v_converted := v_converted + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'task', t.id, 'reason', sqlerrm, 'code', sqlstate));
    end;
  end loop;

  v_result := jsonb_build_object('converted', v_converted, 'skipped', v_skipped);
  update public.my_leads_housekeeping_runs set summary = v_result where id = v_run and org_id = p_org_id;
  return v_preview || jsonb_build_object('runId', v_run) || v_result;
end $$;

-- Operator step: flag an open appointment in_person (or back to phone). Mode-aware with the
-- calendar ledger: phone -> in_person queues the Google 'create' exactly as booking does;
-- in_person -> phone queues a 'cancel' for an event the row already carries. Service role only.
create or replace function public.fn_set_next_step_mode(
  p_task uuid, p_mode text, p_location text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks%rowtype;
  v_loc text;
  v_gen integer;
  v_prior_flag text;
  v_ledger uuid;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_mode is null or p_mode not in ('phone', 'in_person') then
    raise exception 'INVALID_INPUT: mode must be phone or in_person' using errcode = 'P0001';
  end if;
  v_loc := nullif(btrim(p_location), '');
  if p_mode = 'phone' and v_loc is not null then
    raise exception 'INVALID_INPUT: a location is only valid for in_person' using errcode = 'P0001';
  end if;
  if v_loc is not null and length(v_loc) > 500 then
    raise exception 'INVALID_INPUT: location is at most 500 characters' using errcode = 'P0001';
  end if;

  select * into v_task from public.tasks where id = p_task for update;
  if not found then
    raise exception 'TASK_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_task.type <> 'appointment' then
    raise exception 'NOT_AN_APPOINTMENT: only appointments have a mode' using errcode = 'P0001';
  end if;
  if v_task.status <> 'open' then
    raise exception 'NOT_OPEN: appointment is %', v_task.status using errcode = 'P0001';
  end if;
  if v_task.mode = p_mode and v_task.location is not distinct from v_loc then
    return;
  end if;
  perform 1 from public.task_calendar_mutations m
  where m.org_id = v_task.org_id and m.calendar_chain_id = v_task.calendar_chain_id
    and m.phase in ('pending', 'provider_done', 'needs_repair')
  for update;
  if found then
    raise exception 'calendar sync in progress for this appointment' using errcode = 'P0001';
  end if;
  if p_mode = 'in_person'
     and (v_task.end_at is null or v_task.end_at - v_task.due_at < interval '15 minutes'
          or v_task.end_at - v_task.due_at > interval '24 hours') then
    raise exception 'INVALID_INPUT: an in-person appointment lasts 15 minutes to 24 hours' using errcode = 'P0001';
  end if;

  v_prior_flag := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
  perform set_config('sandra.allow_appointment_time_move', 'on', true);
  if v_task.mode is distinct from p_mode then
    update public.tasks
    set mode = p_mode, location = v_loc, calendar_generation = calendar_generation + 1, updated_at = now()
    where id = p_task and org_id = v_task.org_id
    returning calendar_generation into v_gen;
  else
    update public.tasks set location = v_loc, updated_at = now()
    where id = p_task and org_id = v_task.org_id;
  end if;
  perform set_config('sandra.allow_appointment_time_move', v_prior_flag, true);

  if v_task.mode is distinct from p_mode then
    if p_mode = 'in_person' and v_task.google_calendar_event_id is null then
      -- Same row booking inserts (fn_book_appointment), at the post-bump generation.
      insert into public.task_calendar_mutations (
        org_id, calendar_chain_id, operation, phase, source_task_id, old_assignee_id, expected_generation
      ) values (
        v_task.org_id, v_task.calendar_chain_id, 'create', 'pending', p_task, v_task.assignee_id, v_gen
      ) returning id into v_ledger;
      update public.task_calendar_mutations
      set client_event_id = public.fn_uuid_to_base32hex(id), updated_at = now()
      where id = v_ledger and org_id = v_task.org_id;
    elsif p_mode = 'phone' and v_task.google_calendar_event_id is not null then
      -- The row already carries a Google event: remove it through the sweep.
      insert into public.task_calendar_mutations (
        org_id, calendar_chain_id, operation, phase, source_task_id, old_assignee_id, event_id, expected_generation
      ) values (
        v_task.org_id, v_task.calendar_chain_id, 'cancel', 'pending', p_task, v_task.assignee_id,
        v_task.google_calendar_event_id, v_gen);
    end if;
  end if;
end $$;

-- Read-only gate for the retire trigger (20261008100000): how many legacy follow_up/callback
-- rows are still open. Must report openFutureLegacy = 0 before that migration merges.
create or replace function public.fn_my_leads_next_step_retire_preflight(p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.my_leads_housekeeping_require_service();
  return (select jsonb_build_object(
    'openFutureLegacy',  count(*) filter (where t.eff >  statement_timestamp()),
    'openPastDueLegacy', count(*) filter (where t.eff <= statement_timestamp()),
    'snoozedLegacy',     count(*) filter (where t.status = 'snoozed'),
    'byAssignee', coalesce((select jsonb_agg(jsonb_build_object('assignee', x.assignee_id, 'count', x.n))
      from (select assignee_id, count(*) n from public.tasks
            where org_id = p_org_id and type in ('follow_up','callback') and status in ('open','snoozed')
            group by 1) x), '[]'::jsonb))
    from (select status, greatest(due_at, case when status = 'snoozed' then snoozed_until end) as eff
          from public.tasks
          where org_id = p_org_id and type in ('follow_up','callback') and status in ('open','snoozed')) t);
end $$;

-- Copy-replaced from 20261005100100 (adds the attribution/relabel-task fence).
create or replace function public.my_leads_housekeeping_rollback_fingerprint(p_run uuid, p_org_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(
    r.status || '|' || coalesce((
      select string_agg(
        b.table_name || ':' || b.row_id::text || ':' || b.before::text || ':' || coalesce(case b.table_name
          when 'properties' then (select p.assigned_user_id::text || '/' || p.updated_at::text
            from public.properties p where p.id = b.row_id and p.org_id = p_org_id)
          when 'tasks' then (select t.assignee_id::text || '/' || t.status || '/' || t.updated_at::text || '/' || t.calendar_generation::text
              || case when r.kind = 'relabel' then
                   '/' || t.type || '/' || t.mode || '/' || t.due_at::text || '/' || coalesce(t.end_at::text, '')
                   || '/' || coalesce(t.calendar_chain_id::text, '')
                   || '/' || (select count(*) from public.task_calendar_mutations m
                              where m.org_id = p_org_id and m.calendar_chain_id = t.calendar_chain_id)::text
                   || '/' || (select count(*) from public.tasks s
                              where s.org_id = p_org_id and s.calendar_chain_id = t.calendar_chain_id)::text
                 else '' end
            from public.tasks t where t.id = b.row_id and t.org_id = p_org_id)
          when 'acquisition_appointment_attribution' then (select a.source || '/' || a.accountable_user_id::text || '/' || a.captured_at::text
            from public.acquisition_appointment_attribution a where a.task_id = b.row_id and a.org_id = p_org_id)
          when 'acquisition_attempts' then (select coalesce(a.outcome, '')
            from public.acquisition_attempts a where a.id = b.row_id and a.org_id = p_org_id)
          when 'acquisition_assignment_episodes' then (select e.eligible::text || '/' || coalesce(e.ended_at::text, '')
            from public.acquisition_assignment_episodes e where e.id = b.row_id and e.org_id = p_org_id)
        end, 'missing'),
        ',' order by b.table_name, b.row_id)
      from public.my_leads_housekeeping_before_images b where b.run_id = p_run), ''), 'utf8')), 'hex')
  from public.my_leads_housekeeping_runs r
  where r.id = p_run and r.org_id = p_org_id
$$;

-- Copy-replaced from 20261005100100 (adds the relabel branch; other branches unchanged).
create or replace function public.fn_my_leads_housekeeping_rollback(
  p_run uuid, p_org_id uuid, p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.my_leads_housekeeping_runs%rowtype;
  v_target uuid;
  v_owner uuid;
  r record;
  v_cur record;
  v_old uuid;
  v_created uuid;
  v_orig uuid;
  v_work text;
  v_prior_sub text;
  v_restored int := 0;
  v_already int := 0;
  v_not_restored jsonb := '[]'::jsonb;
  v_images int;
  v_summary jsonb;
  v_flag_move text;
  v_flag_retired text;
  v_rows int;
  v_attr_src text;
  v_attr_user uuid;
  v_attr_at timestamptz;
  v_attr_img jsonb;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;
  select * into v_run from public.my_leads_housekeeping_runs
  where id = p_run and org_id = p_org_id for update;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
  if v_run.status = 'rolled_back' then
    return jsonb_build_object('runId', p_run, 'noop', true, 'status', 'rolled_back');
  end if;
  if p_fingerprint is null then
    raise exception 'FINGERPRINT_REQUIRED: rollback needs the fingerprint from the run info' using errcode = 'P0001';
  end if;
  -- Lock every row the rollback may touch, then recompute the fence under those locks.
  perform 1 from public.properties p
  where p.org_id = p_org_id and p.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'properties') order by p.id for update;
  perform 1 from public.tasks t
  where t.org_id = p_org_id and t.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'tasks') order by t.id for update;
  perform 1 from public.acquisition_attempts a
  where a.org_id = p_org_id and a.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts') order by a.id for update;
  perform 1 from public.acquisition_appointment_attribution aa
  where aa.org_id = p_org_id and aa.task_id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_appointment_attribution') order by aa.task_id for update;
  if p_fingerprint is distinct from public.my_leads_housekeeping_rollback_fingerprint(p_run, p_org_id) then
    raise exception 'FINGERPRINT_MISMATCH: the run state changed since the preview; run a new preview' using errcode = 'P0001';
  end if;

  if v_run.kind = 'reassign' then
    v_target := (v_run.params ->> 'target')::uuid;
    v_owner := (v_run.params ->> 'owner')::uuid;

    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'properties' order by b.row_id
    loop
      begin
        select p.assigned_user_id, p.updated_at into v_cur
        from public.properties p
        where p.id = r.row_id and p.org_id = p_org_id;
        if not found then
          raise exception 'PROPERTY_MISSING' using errcode = 'P0001';
        end if;
        v_old := (r.before ->> 'assigned_user_id')::uuid;
        if v_cur.assigned_user_id is not distinct from v_old then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.assigned_user_id is distinct from v_target then
          raise exception 'REASSIGNED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        select i.row_id into v_created
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_assignment_episodes'
          and i.before ->> 'op' = 'created' and i.before ->> 'property_id' = r.row_id::text;
        select i.row_id into v_orig
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_assignment_episodes'
          and i.before ->> 'op' = 'updated' and i.before ->> 'property_id' = r.row_id::text;
        if v_created is null or v_orig is null then
          raise exception 'EPISODE_IMAGE_MISSING' using errcode = 'P0001';
        end if;
        v_work := public.my_leads_housekeeping_work_since(p_org_id, r.row_id, v_created, v_run.created_at);
        if v_work is not null then
          raise exception 'WORK_RECORDED: %', v_work using errcode = 'P0001';
        end if;

        -- Observer ends the created episode and opens a throwaway one for the old owner.
        update public.properties
        set assigned_user_id = v_old, updated_at = (r.before ->> 'updated_at')::timestamptz
        where id = r.row_id and org_id = p_org_id;
        delete from public.acquisition_assignment_episodes e
        where e.org_id = p_org_id and e.property_id = r.row_id and e.ended_at is null;
        delete from public.acquisition_assignment_episodes e
        where e.id = v_created and e.org_id = p_org_id and e.property_id = r.row_id;
        update public.acquisition_assignment_episodes e
        set ended_at = null
        where e.id = v_orig and e.org_id = p_org_id and e.property_id = r.row_id;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'property', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'tasks' order by b.row_id
    loop
      v_prior_sub := coalesce(current_setting('request.jwt.claim.sub', true), '');
      begin
        select t.assignee_id, t.status, t.type, t.updated_at, t.calendar_generation into v_cur
        from public.tasks t where t.id = r.row_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        v_old := (r.before ->> 'assignee_id')::uuid;
        if v_cur.assignee_id is not distinct from v_old then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.assignee_id is distinct from v_target then
          raise exception 'ASSIGNEE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz
           or v_cur.calendar_generation is distinct from (r.before ->> 'applied_generation')::int
           or v_cur.status is distinct from (r.before ->> 'status') then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        -- A task goes back with its lead: while the lead is kept (work recorded, edited), so is the task.
        perform 1 from public.properties p
        where p.id = (r.before ->> 'property_id')::uuid and p.org_id = p_org_id
          and p.assigned_user_id is not distinct from v_target;
        if found then
          raise exception 'LEAD_NOT_RESTORED' using errcode = 'P0001';
        end if;
        if v_cur.type = 'appointment' then
          perform set_config('request.jwt.claim.sub', v_owner::text, true);
          perform public.fn_reassign_appointment(
            r.row_id, v_old, md5('rollback:' || p_run::text || r.row_id::text)::uuid);
          perform set_config('request.jwt.claim.sub', v_prior_sub, true);
        else
          update public.tasks set assignee_id = v_old, updated_at = (r.before ->> 'updated_at')::timestamptz
          where id = r.row_id and org_id = p_org_id and assignee_id = v_target;
        end if;
        v_restored := v_restored + 1;
      exception when others then
        perform set_config('request.jwt.claim.sub', v_prior_sub, true);
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'task', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  elsif v_run.kind = 'close_attempts' then
    select count(*)::int into v_images
    from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts';
    -- Only rows still carrying the housekeeping value are restored; a row changed since
    -- (e.g. a call finalised it) is reported, never overwritten.
    update public.acquisition_attempts a
    set outcome = b.before ->> 'outcome'
    from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts'
      and b.row_id = a.id and a.org_id = p_org_id and a.outcome = 'not_logged';
    get diagnostics v_restored = row_count;
    if v_restored < v_images then
      select coalesce(jsonb_agg(jsonb_build_object('attempt', b.row_id, 'reason', 'outcome_changed_since')), '[]'::jsonb)
      into v_not_restored
      from public.my_leads_housekeeping_before_images b
      join public.acquisition_attempts a on a.id = b.row_id and a.org_id = p_org_id
      where b.run_id = p_run and b.table_name = 'acquisition_attempts'
        and a.outcome is distinct from (b.before ->> 'outcome');
    end if;
  elsif v_run.kind = 'relabel' then
    -- A relabeled row goes back only while it still equals what the run left: open, same
    -- type/times/chain, no calendar ledger row or successor on the chain, no work on the lead
    -- since the run, and its attribution row (when the run created one) untouched.
    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'tasks' order by b.row_id
    loop
      v_flag_move := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
      v_flag_retired := coalesce(current_setting('sandra.allow_retired_task_type', true), '');
      begin
        select t.type, t.status, t.mode, t.location, t.due_at, t.end_at, t.calendar_chain_id, t.updated_at into v_cur
        from public.tasks t where t.id = r.row_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        if v_cur.type is not distinct from (r.before ->> 'type') and v_cur.calendar_chain_id is null then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.type <> 'appointment' then
          raise exception 'TYPE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.status <> 'open' then
          raise exception 'NOT_OPEN_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.due_at is distinct from (r.before ->> 'applied_due_at')::timestamptz
           or v_cur.end_at is distinct from (r.before ->> 'applied_end_at')::timestamptz
           or v_cur.calendar_chain_id is distinct from (r.before ->> 'applied_calendar_chain_id')::uuid then
          raise exception 'RESCHEDULED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.mode <> 'phone' or v_cur.location is not null then
          raise exception 'MODE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.task_calendar_mutations m
                   where m.org_id = p_org_id and m.calendar_chain_id = v_cur.calendar_chain_id) then
          raise exception 'CALENDAR_ACTIVITY_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.tasks s
                   where s.org_id = p_org_id and s.calendar_chain_id = v_cur.calendar_chain_id and s.id <> r.row_id) then
          raise exception 'SUCCESSOR_EXISTS' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        v_work := public.my_leads_housekeeping_work_since(
          p_org_id, (r.before ->> 'related_property_id')::uuid, null::uuid, v_run.created_at);
        if v_work is not null then
          raise exception 'WORK_RECORDED: %', v_work using errcode = 'P0001';
        end if;
        select i.before into v_attr_img
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_appointment_attribution'
          and i.row_id = r.row_id and i.before ->> 'op' = 'created';
        if v_attr_img is not null then
          select a.source, a.accountable_user_id, a.captured_at into v_attr_src, v_attr_user, v_attr_at
          from public.acquisition_appointment_attribution a
          where a.task_id = r.row_id and a.org_id = p_org_id;
          if found and (v_attr_src is distinct from 'relabel_2026_10'
                        or v_attr_user::text is distinct from (v_attr_img ->> 'accountable_user_id')
                        or v_attr_at is distinct from (v_attr_img ->> 'applied_captured_at')::timestamptz) then
            raise exception 'ATTRIBUTION_CHANGED_SINCE' using errcode = 'P0001';
          end if;
        end if;

        perform set_config('sandra.allow_appointment_time_move', 'on', true);
        perform set_config('sandra.allow_retired_task_type', 'on', true);
        update public.tasks
        set type = r.before ->> 'type', status = r.before ->> 'status',
            due_at = (r.before ->> 'due_at')::timestamptz,
            snoozed_until = (r.before ->> 'snoozed_until')::timestamptz,
            end_at = (r.before ->> 'end_at')::timestamptz,
            calendar_chain_id = (r.before ->> 'calendar_chain_id')::uuid,
            mode = r.before ->> 'mode',
            updated_at = (r.before ->> 'updated_at')::timestamptz
        where id = r.row_id and org_id = p_org_id and type = 'appointment' and status = 'open';
        get diagnostics v_rows = row_count;
        perform set_config('sandra.allow_appointment_time_move', v_flag_move, true);
        perform set_config('sandra.allow_retired_task_type', v_flag_retired, true);
        if v_rows <> 1 then
          raise exception 'TASK_CHANGED' using errcode = 'P0001';
        end if;
        if v_attr_img is not null then
          delete from public.acquisition_appointment_attribution a
          where a.task_id = r.row_id and a.org_id = p_org_id and a.source = 'relabel_2026_10';
        end if;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'task', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  else
    raise exception 'ROLLBACK_UNSUPPORTED: kind % has no rollback branch in this release', v_run.kind
      using errcode = 'P0001';
  end if;

  v_summary := jsonb_build_object(
    'restored', v_restored, 'alreadyRestored', v_already, 'notRestored', v_not_restored);
  if jsonb_array_length(v_not_restored) = 0 then
    update public.my_leads_housekeeping_runs
    set status = 'rolled_back', rolled_back_at = now(),
        summary = summary || jsonb_build_object('rollback', v_summary)
    where id = p_run and org_id = p_org_id;
  else
    update public.my_leads_housekeeping_runs
    set summary = summary || jsonb_build_object('rollback', v_summary)
    where id = p_run and org_id = p_org_id;
  end if;
  return jsonb_build_object('runId', p_run,
    'status', case when jsonb_array_length(v_not_restored) = 0 then 'rolled_back' else 'applied' end)
    || v_summary;
end $$;

revoke all on function public.my_leads_relabel_candidate_ids(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_my_leads_relabel_open_next_steps(uuid, uuid, boolean, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.fn_set_next_step_mode(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.fn_my_leads_next_step_retire_preflight(uuid)
  from public, anon, authenticated;
revoke all on function public.my_leads_housekeeping_rollback_fingerprint(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_my_leads_housekeeping_rollback(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_my_leads_relabel_open_next_steps(uuid, uuid, boolean, text, timestamptz) to service_role;
grant execute on function public.fn_set_next_step_mode(uuid, text, text) to service_role;
grant execute on function public.fn_my_leads_next_step_retire_preflight(uuid) to service_role;
grant execute on function public.fn_my_leads_housekeeping_rollback(uuid, uuid, text) to service_role;

commit;
