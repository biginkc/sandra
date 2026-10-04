-- My Leads one-call close, P1e (1e.2, 1e.3 function, rollback): service-only housekeeping
-- functions. Definitions only; nothing here runs against data when the migration applies.
-- Real-data changes run later via scripts/my-leads-housekeeping.mjs (preview, then
-- --apply --confirm <sha256 of the preview>), each writing a my_leads_housekeeping_runs
-- row plus before-images so fn_my_leads_housekeeping_rollback can undo it.
--
-- Contracts (Astra B3/B4):
--  * Every function takes p_org_id and filters every statement by it.
--  * Every preview returns a `fingerprint` (sha256 over the sorted candidate row ids plus the
--    before-values the apply changes). The apply RPC requires it, locks the candidate rows,
--    recomputes it inside the mutation transaction and raises FINGERPRINT_MISMATCH on any
--    difference (substituted rows, or an edit between preview and apply).
--  * Before-images cover every row changed and record `op` = 'updated' (before-values to
--    restore) or 'created' (row to delete) separately.
--  * Rollback is conflict-safe: a row edited since the run, or a lead with new work
--    (attempt, offer, note, SMS obligation, or a permanent Dialpad call intent) is skipped and
--    reported, never overwritten; a run with skipped rows stays 'applied' and can be re-run.
begin;

-- Internal: the exact "queue leads" in scope for the reassign (D10). Every
-- acquisitions-enabled member except the target, each member's my_leads_queue_rows
-- projection (assigned, open episode, not DNC-locked, not closed/dead/dnc, not archived).
create or replace function public.my_leads_housekeeping_reassign_scope(
  p_org_id uuid, p_target uuid, p_at timestamptz
) returns table (property_id uuid, old_assignee uuid)
language sql stable security definer set search_path = '' as $$
  select q.property_id, m.user_id
  from public.memberships m
  cross join lateral public.my_leads_queue_rows(p_org_id, m.user_id, p_at) q
  where m.org_id = p_org_id and m.acquisitions_enabled and m.user_id <> p_target
$$;

-- Internal: sha256 fingerprint over exactly the given cohort ids (the same arrays the apply
-- mutates) plus the values the apply changes.
create or replace function public.my_leads_housekeeping_reassign_fingerprint(
  p_org_id uuid, p_target uuid, p_owner uuid, p_keep_clock boolean,
  p_prop_ids uuid[], p_task_ids uuid[]
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_props text;
  v_eps text;
  v_tasks text;
begin
  select coalesce(string_agg(p.id::text || ':' || coalesce(p.assigned_user_id::text, '') || ':' || p.updated_at::text,
           ',' order by p.id), '')
  into v_props
  from public.properties p where p.org_id = p_org_id and p.id = any(p_prop_ids);

  select coalesce(string_agg(e.id::text || ':' || e.assignee_user_id::text || ':' || e.eligible::text,
           ',' order by e.id), '')
  into v_eps
  from public.acquisition_assignment_episodes e
  where e.org_id = p_org_id and e.ended_at is null and e.property_id = any(p_prop_ids);

  select coalesce(string_agg(t.id::text || ':' || t.assignee_id::text || ':' || t.type || ':' || t.status || ':' ||
           t.due_at::text || ':' || t.calendar_generation::text || ':' || coalesce(t.google_calendar_event_id, '') ||
           ':' || t.updated_at::text, ',' order by t.id), '')
  into v_tasks
  from public.tasks t where t.org_id = p_org_id and t.id = any(p_task_ids);

  return encode(sha256(convert_to(
    'reassign|' || p_target::text || '|' || p_owner::text || '|' || p_keep_clock::text ||
    '|' || v_props || '|' || v_eps || '|' || v_tasks, 'utf8')), 'hex');
end $$;

-- Internal: open tasks to move = open (or snoozed non-appointment) tasks on a scoped lead whose
-- assignee is that lead's OLD assignee. A VA's or admin's tasks on the lead are left alone.
create or replace function public.my_leads_housekeeping_reassign_task_ids(
  p_org_id uuid, p_target uuid, p_at timestamptz
) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(tk.id order by tk.id), '{}'::uuid[])
  from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, p_at) sc
  join public.tasks tk on tk.org_id = p_org_id and tk.related_property_id = sc.property_id
    and tk.assignee_id = sc.old_assignee
  where ((tk.type <> 'appointment' and tk.status in ('open', 'snoozed'))
      or (tk.type = 'appointment' and tk.status = 'open'))
$$;

create or replace function public.fn_my_leads_housekeeping_reassign(
  p_org_id uuid,
  p_target uuid,
  p_owner uuid,
  p_apply boolean default false,
  p_keep_clock boolean default false,
  p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_run uuid;
  r record;
  t record;
  v_prop_ids uuid[];
  v_task_ids uuid[];
  v_leads jsonb;
  v_lead_count int;
  v_na int;
  v_appt int;
  v_inflight int;
  v_by_assignee jsonb;
  v_sample jsonb;
  v_fp text;
  v_preview jsonb;
  v_orig uuid;
  v_new uuid;
  v_old_updated timestamptz;
  v_orig_eligible boolean;
  v_prior_sub text;
  v_applied_updated timestamptz;
  v_applied_generation int;
  v_moved int := 0;
  v_tasks_moved int := 0;
  v_appts_moved int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null or p_target is null or p_owner is null then
    raise exception 'INVALID_INPUT: org, target and owner are required' using errcode = 'P0001';
  end if;
  perform 1 from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_target and m.acquisitions_enabled
    and m.access_status = 'active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > v_now);
  if not found then
    raise exception 'INVALID_TARGET: target must be an active acquisitions-enabled member' using errcode = 'P0001';
  end if;
  perform 1 from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_owner and m.role = 'owner'
    and m.access_status = 'active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > v_now);
  if not found then
    raise exception 'INVALID_OWNER: owner must be an active org owner' using errcode = 'P0001';
  end if;

  if p_apply then
    if p_fingerprint is null then
      raise exception 'FINGERPRINT_REQUIRED: apply needs the fingerprint from the preview' using errcode = 'P0001';
    end if;
    -- Serialize housekeeping per org, lock the candidate rows, then (below) rebuild the id
    -- arrays under those locks: the fingerprint and every mutation use exactly those arrays.
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    perform 1 from public.properties p
    where p.org_id = p_org_id and p.id in (
      select sc.property_id from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, v_now) sc)
    order by p.id for update;
    perform 1 from public.tasks tk
    where tk.org_id = p_org_id
      and tk.id = any(public.my_leads_housekeeping_reassign_task_ids(p_org_id, p_target, v_now))
    order by tk.id for update;
  end if;

  select coalesce(array_agg(sc.property_id order by sc.property_id), '{}'::uuid[])
  into v_prop_ids
  from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, v_now) sc;
  v_task_ids := public.my_leads_housekeeping_reassign_task_ids(p_org_id, p_target, v_now);
  v_lead_count := coalesce(array_length(v_prop_ids, 1), 0);

  select coalesce(jsonb_agg(jsonb_build_object('from', s.old_assignee, 'count', s.n) order by s.old_assignee), '[]'::jsonb)
  into v_leads
  from (
    select sc.old_assignee, count(*) as n
    from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, v_now) sc
    group by sc.old_assignee
  ) s;
  select coalesce(jsonb_agg(u.x order by u.x), '[]'::jsonb) into v_sample
  from unnest(v_prop_ids[1:20]) as u(x);

  select count(*) filter (where tk.type <> 'appointment')::int,
         count(*) filter (where tk.type = 'appointment')::int,
         count(*) filter (where tk.type = 'appointment' and exists (
           select 1 from public.task_calendar_mutations m
           where m.org_id = p_org_id and m.calendar_chain_id = tk.calendar_chain_id
             and m.phase in ('pending', 'provider_done', 'needs_repair')))::int
  into v_na, v_appt, v_inflight
  from public.tasks tk where tk.org_id = p_org_id and tk.id = any(v_task_ids);
  select coalesce(jsonb_agg(jsonb_build_object('assignee', s.assignee_id, 'nonAppointment', s.na, 'appointments', s.ap)
           order by s.assignee_id), '[]'::jsonb)
  into v_by_assignee
  from (
    select tk.assignee_id,
           count(*) filter (where tk.type <> 'appointment') as na,
           count(*) filter (where tk.type = 'appointment') as ap
    from public.tasks tk where tk.org_id = p_org_id and tk.id = any(v_task_ids)
    group by tk.assignee_id
  ) s;

  v_fp := public.my_leads_housekeeping_reassign_fingerprint(p_org_id, p_target, p_owner, p_keep_clock, v_prop_ids, v_task_ids);
  v_preview := jsonb_build_object(
    'kind', 'reassign',
    'target', p_target,
    'owner', p_owner,
    'keepClock', p_keep_clock,
    'leads', v_leads,
    'leadCount', v_lead_count,
    'tasks', jsonb_build_object('nonAppointment', v_na, 'appointments', v_appt, 'byAssignee', v_by_assignee),
    'appointmentsInFlight', v_inflight,
    'sample', v_sample,
    'fingerprint', v_fp
  );

  if not p_apply then
    return v_preview;
  end if;
  if p_fingerprint is distinct from v_fp then
    raise exception 'FINGERPRINT_MISMATCH: the cohort changed since the preview; run a new preview' using errcode = 'P0001';
  end if;
  if v_lead_count = 0 then
    return v_preview || jsonb_build_object('noop', true, 'runId', null);
  end if;

  insert into public.my_leads_housekeeping_runs (org_id, kind, params, created_at)
  values (p_org_id, 'reassign', jsonb_build_object(
    'target', p_target, 'owner', p_owner, 'keepClock', p_keep_clock, 'fingerprint', v_fp),
    clock_timestamp())
  returning id into v_run;

  for r in
    select p.id as property_id, p.assigned_user_id as old_assignee
    from public.properties p
    where p.org_id = p_org_id and p.id = any(v_prop_ids)
    order by p.id
  loop
    begin
      select p.updated_at into v_old_updated
      from public.properties p
      where p.id = r.property_id and p.org_id = p_org_id and p.assigned_user_id = r.old_assignee
      for update;
      if not found then
        raise exception 'ASSIGNEE_CHANGED' using errcode = 'P0001';
      end if;
      select e.id, e.eligible into v_orig, v_orig_eligible
      from public.acquisition_assignment_episodes e
      where e.org_id = p_org_id and e.property_id = r.property_id and e.ended_at is null
        and e.assignee_user_id = r.old_assignee;
      if v_orig is null then
        raise exception 'OPEN_EPISODE_MISSING' using errcode = 'P0001';
      end if;

      insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
      values
        (v_run, 'properties', r.property_id, jsonb_build_object(
          'op', 'updated', 'assigned_user_id', r.old_assignee, 'updated_at', v_old_updated,
          'applied_updated_at', v_now)),
        (v_run, 'acquisition_assignment_episodes', v_orig, jsonb_build_object(
          'op', 'updated', 'kind', 'original', 'property_id', r.property_id,
          'assignee_user_id', r.old_assignee, 'eligible', v_orig_eligible, 'ended_at', null));

      -- The observer trigger ends the old episode and opens one for the target.
      update public.properties
      set assigned_user_id = p_target, updated_at = v_now
      where id = r.property_id and org_id = p_org_id and assigned_user_id = r.old_assignee;

      select e.id into v_new
      from public.acquisition_assignment_episodes e
      where e.org_id = p_org_id and e.property_id = r.property_id and e.ended_at is null
        and e.assignee_user_id = p_target;
      if v_new is null then
        raise exception 'NEW_EPISODE_MISSING' using errcode = 'P0001';
      end if;
      insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
      values (v_run, 'acquisition_assignment_episodes', v_new, jsonb_build_object(
        'op', 'created', 'kind', 'created', 'property_id', r.property_id, 'assignee_user_id', p_target,
        'eligible_forced_false', not p_keep_clock));
      -- eligible=false keeps the first-call clock and KPI samples unchanged (D10).
      if not p_keep_clock then
        update public.acquisition_assignment_episodes
        set eligible = false
        where id = v_new and org_id = p_org_id;
      end if;
      v_moved := v_moved + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'property', r.property_id, 'reason', sqlerrm, 'code', sqlstate));
      continue;
    end;

    for t in
      select tk.id, tk.type, tk.assignee_id, tk.status, tk.due_at, tk.end_at,
             tk.calendar_generation, tk.google_calendar_event_id, tk.updated_at
      from public.tasks tk
      where tk.org_id = p_org_id and tk.id = any(v_task_ids) and tk.related_property_id = r.property_id
      order by tk.id
    loop
      v_prior_sub := coalesce(current_setting('request.jwt.claim.sub', true), '');
      begin
        insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
        values (v_run, 'tasks', t.id, jsonb_build_object(
          'op', 'updated', 'assignee_id', t.assignee_id, 'type', t.type, 'status', t.status,
          'property_id', r.property_id, 'due_at', t.due_at, 'end_at', t.end_at,
          'calendar_generation', t.calendar_generation,
          'google_calendar_event_id', t.google_calendar_event_id, 'updated_at', t.updated_at));
        if t.type <> 'appointment' then
          update public.tasks
          set assignee_id = p_target, updated_at = v_now
          where id = t.id and org_id = p_org_id and assignee_id = t.assignee_id;
          v_tasks_moved := v_tasks_moved + 1;
        else
          -- The lifecycle RPC authorizes through auth.uid(); the owner claim is set for this
          -- one call and restored right after (this function is service-role gated).
          perform set_config('request.jwt.claim.sub', p_owner::text, true);
          perform public.fn_reassign_appointment(t.id, p_target, md5(v_run::text || t.id::text)::uuid);
          perform set_config('request.jwt.claim.sub', v_prior_sub, true);
          v_appts_moved := v_appts_moved + 1;
        end if;
        select tk.updated_at, tk.calendar_generation into v_applied_updated, v_applied_generation
        from public.tasks tk where tk.id = t.id and tk.org_id = p_org_id;
        update public.my_leads_housekeeping_before_images b
        set before = b.before || jsonb_build_object(
          'applied_updated_at', v_applied_updated, 'applied_generation', v_applied_generation)
        where b.run_id = v_run and b.table_name = 'tasks' and b.row_id = t.id;
      exception when others then
        perform set_config('request.jwt.claim.sub', v_prior_sub, true);
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'task', t.id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;
  end loop;

  v_result := jsonb_build_object(
    'leadsMoved', v_moved,
    'tasksMoved', v_tasks_moved,
    'appointmentsMoved', v_appts_moved,
    'skipped', v_skipped);
  update public.my_leads_housekeeping_runs set summary = v_result where id = v_run and org_id = p_org_id;
  return v_preview || jsonb_build_object('runId', v_run) || v_result;
end $$;

create or replace function public.fn_my_leads_housekeeping_close_attempts(
  p_org_id uuid,
  p_older_than interval default '7 days',
  p_apply boolean default false,
  p_fingerprint text default null,
  p_cutoff timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cutoff timestamptz;
  v_run uuid;
  v_count int;
  v_oldest timestamptz;
  v_newest timestamptz;
  v_with_call int;
  v_by_actor jsonb;
  v_pending_cti int;
  v_fp text;
  v_preview jsonb;
  v_closed int;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;
  -- A fresh attempt is legitimately pending: refuse windows shorter than a day.
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'INVALID_INPUT: older-than must be at least 1 day' using errcode = 'P0001';
  end if;
  -- The preview reports the cutoff it used; apply must be handed that same timestamp, never recompute it.
  if p_apply and p_cutoff is null then
    raise exception 'CUTOFF_REQUIRED: apply needs the cutoff from the preview' using errcode = 'P0001';
  end if;
  v_cutoff := coalesce(p_cutoff, statement_timestamp() - p_older_than);
  if v_cutoff > statement_timestamp() - interval '1 day' then
    raise exception 'INVALID_INPUT: cutoff must be at least 1 day old' using errcode = 'P0001';
  end if;
  if p_apply then
    if p_fingerprint is null then
      raise exception 'FINGERPRINT_REQUIRED: apply needs the fingerprint from the preview' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    perform 1 from public.acquisition_attempts a
    where a.org_id = p_org_id and a.outcome is null and a.source = 'sandra' and a.occurred_at < v_cutoff
    order by a.id for update;
  end if;

  -- Fingerprint: every candidate id plus the values the apply changes or depends on, and the cutoff.
  select count(*)::int, min(a.occurred_at), max(a.occurred_at),
         count(*) filter (where a.call_activity_id is not null)::int,
         encode(sha256(convert_to('close_attempts|' || v_cutoff::text || '|' || coalesce(string_agg(
           a.id::text || ':' || coalesce(a.outcome, '') || ':' || a.occurred_at::text || ':' ||
           coalesce(a.call_activity_id::text, '') || ':' || a.actor_user_id::text,
           ',' order by a.id), ''), 'utf8')), 'hex')
  into v_count, v_oldest, v_newest, v_with_call, v_fp
  from public.acquisition_attempts a
  where a.org_id = p_org_id and a.outcome is null and a.source = 'sandra' and a.occurred_at < v_cutoff;

  select coalesce(jsonb_agg(jsonb_build_object('actor', s.actor_user_id, 'count', s.n) order by s.actor_user_id), '[]'::jsonb)
  into v_by_actor
  from (
    select a.actor_user_id, count(*) as n
    from public.acquisition_attempts a
    where a.org_id = p_org_id and a.outcome is null and a.source = 'sandra' and a.occurred_at < v_cutoff
    group by a.actor_user_id
  ) s;

  -- Visibility only: pending Dialpad CTI attempts are never touched here.
  select count(*)::int into v_pending_cti
  from public.acquisition_attempts a
  where a.org_id = p_org_id and a.outcome is null and a.source = 'dialpad';

  v_preview := jsonb_build_object(
    'kind', 'close_attempts',
    'olderThan', p_older_than::text,
    'cutoff', v_cutoff,
    'count', v_count,
    'oldest', v_oldest,
    'newest', v_newest,
    'withCallActivity', v_with_call,
    'byActor', v_by_actor,
    'pendingDialpadCti', v_pending_cti,
    'fingerprint', v_fp);

  if not p_apply then
    return v_preview;
  end if;
  if p_fingerprint is distinct from v_fp then
    raise exception 'FINGERPRINT_MISMATCH: the cohort changed since the preview; run a new preview' using errcode = 'P0001';
  end if;
  if v_count = 0 then
    return v_preview || jsonb_build_object('noop', true, 'runId', null);
  end if;

  insert into public.my_leads_housekeeping_runs (org_id, kind, params, created_at)
  values (p_org_id, 'close_attempts', jsonb_build_object(
    'olderThan', p_older_than::text, 'cutoff', v_cutoff, 'fingerprint', v_fp), clock_timestamp())
  returning id into v_run;

  -- Before-images first; only rows that have one are closed.
  insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
  select v_run, 'acquisition_attempts', a.id, jsonb_build_object('op', 'updated', 'outcome', a.outcome)
  from public.acquisition_attempts a
  where a.org_id = p_org_id and a.outcome is null and a.source = 'sandra' and a.occurred_at < v_cutoff;

  update public.acquisition_attempts a
  set outcome = 'not_logged'
  where a.org_id = p_org_id and a.outcome is null and a.source = 'sandra'
    and a.id in (select b.row_id from public.my_leads_housekeeping_before_images b
                 where b.run_id = v_run and b.table_name = 'acquisition_attempts');
  get diagnostics v_closed = row_count;

  update public.my_leads_housekeeping_runs
  set summary = jsonb_build_object('closed', v_closed)
  where id = v_run and org_id = p_org_id;
  return v_preview || jsonb_build_object('runId', v_run, 'closed', v_closed);
end $$;

-- Internal: sha256 of a run's before-images plus the current state of the rows a rollback
-- would touch. This is the rollback preview fence.
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
            from public.tasks t where t.id = b.row_id and t.org_id = p_org_id)
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

-- Internal: has anything happened on this lead since the run that a rollback must not erase?
create or replace function public.my_leads_housekeeping_work_since(
  p_org_id uuid, p_property uuid, p_episode uuid, p_since timestamptz
) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.acquisition_assignment_episodes e
             where e.id = p_episode and e.org_id = p_org_id and e.first_call_started_at is not null) then
    return 'first_call_recorded';
  end if;
  if exists (select 1 from public.acquisition_attempts a
             where a.org_id = p_org_id and a.property_id = p_property
               and (a.assignment_episode_id = p_episode or a.recorded_at >= p_since)) then
    return 'attempt_recorded';
  end if;
  if exists (select 1 from public.acquisition_offers o
             where o.org_id = p_org_id and o.property_id = p_property
               and (o.assignment_episode_id = p_episode or o.created_at >= p_since)) then
    return 'offer_recorded';
  end if;
  if exists (select 1 from public.lead_notes n
             where n.org_id = p_org_id and n.property_id = p_property and n.created_at >= p_since) then
    return 'note_recorded';
  end if;
  if exists (select 1 from public.tasks tk
             where tk.org_id = p_org_id and tk.related_property_id = p_property and tk.created_at >= p_since) then
    return 'task_created';
  end if;
  if exists (select 1 from public.messages m
             where m.org_id = p_org_id and m.property_id = p_property and m.direction = 'outbound'
               and m.created_at >= p_since) then
    return 'outbound_message_sent';
  end if;
  if exists (select 1 from public.rep_sms_obligations s
             where s.org_id = p_org_id and s.assignment_episode_id = p_episode) then
    return 'sms_obligation_recorded';
  end if;
  -- Dialpad intents are permanent: any intent for the lead since the run, or on the created
  -- episode, blocks restoring that lead.
  if exists (select 1 from public.dialpad_call_intents d
             where d.org_id = p_org_id and d.property_id = p_property
               and (d.assignment_episode_id = p_episode or d.prepared_at >= p_since)) then
    return 'dialpad_intent_reference';
  end if;
  if exists (select 1 from public.acquisition_launch_cohort_items c
             where c.org_id = p_org_id and (c.launch_episode_id = p_episode or c.expected_episode_id = p_episode)) then
    return 'launch_cohort_reference';
  end if;
  return null;
end $$;

-- Read-only description of a run, used as the rollback preview by the operator script.
create or replace function public.fn_my_leads_housekeeping_run_info(p_run uuid, p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.my_leads_housekeeping_runs%rowtype;
begin
  perform public.my_leads_housekeeping_require_service();
  select * into v_run from public.my_leads_housekeeping_runs where id = p_run and org_id = p_org_id;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'kind', 'rollback',
    'run', jsonb_build_object(
      'id', v_run.id, 'orgId', v_run.org_id, 'kind', v_run.kind, 'status', v_run.status,
      'params', v_run.params, 'summary', v_run.summary, 'createdAt', v_run.created_at),
    'beforeImages', coalesce((
      select jsonb_agg(jsonb_build_object('table', s.table_name, 'op', s.op, 'count', s.n) order by s.table_name, s.op)
      from (
        select b.table_name, b.before ->> 'op' as op, count(*) as n
        from public.my_leads_housekeeping_before_images b
        where b.run_id = p_run group by 1, 2
      ) s), '[]'::jsonb),
    'fingerprint', public.my_leads_housekeeping_rollback_fingerprint(p_run, p_org_id));
end $$;

-- One rollback entry point for every housekeeping kind. Later phases copy-replace this
-- function to add their branch; a kind without a branch is refused, never guessed.
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

revoke all on function public.my_leads_housekeeping_reassign_scope(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_housekeeping_reassign_fingerprint(uuid, uuid, uuid, boolean, uuid[], uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_housekeeping_reassign_task_ids(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_housekeeping_rollback_fingerprint(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_housekeeping_work_since(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_my_leads_housekeeping_reassign(uuid, uuid, uuid, boolean, boolean, text)
  from public, anon, authenticated;
revoke all on function public.fn_my_leads_housekeeping_close_attempts(uuid, interval, boolean, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.fn_my_leads_housekeeping_run_info(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fn_my_leads_housekeeping_rollback(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_my_leads_housekeeping_reassign(uuid, uuid, uuid, boolean, boolean, text) to service_role;
grant execute on function public.fn_my_leads_housekeeping_close_attempts(uuid, interval, boolean, text, timestamptz) to service_role;
grant execute on function public.fn_my_leads_housekeeping_run_info(uuid, uuid) to service_role;
grant execute on function public.fn_my_leads_housekeeping_rollback(uuid, uuid, text) to service_role;

commit;
