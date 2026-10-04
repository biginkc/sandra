-- Roll back 20261005122500: restore the 20261005122000 reassign scope (queue predicates plus an open
-- episode) and apply loop exactly. Same signatures; data changes already made by a run are not
-- undone here (use fn_my_leads_housekeeping_rollback first).
begin;


-- Internal: the exact "queue leads" in scope for the reassign (D10): the leads currently assigned to
-- one of the explicitly named source members that sit in that member's queue (open episode for
-- that assignee, not deleted, not DNC-locked, status not closed/dead/dnc, not archived: the same
-- predicates as my_leads_queue_rows_for). The source member's access_status and acquisitions flag
-- are deliberately ignored: a suspended or acquisitions-disabled member's leads still move.
create or replace function public.my_leads_housekeeping_reassign_scope(
  p_org_id uuid, p_target uuid, p_sources uuid[], p_at timestamptz
) returns table (property_id uuid, old_assignee uuid)
language sql stable security definer set search_path = '' as $$
  select p.id, p.assigned_user_id
  from public.properties p
  join public.acquisition_assignment_episodes e
    on e.property_id = p.id and e.org_id = p.org_id and e.ended_at is null
   and e.assignee_user_id = p.assigned_user_id
  left join public.acquisition_queue_states q on q.property_id = p.id and q.org_id = p.org_id
  where p.org_id = p_org_id
    and p.assigned_user_id = any(p_sources)
    and p.assigned_user_id <> p_target
    and p.deleted_at is null and not p.is_dnc_locked
    and p.status not in ('closed', 'dead', 'dnc')
    and q.archived_at is null
$$;

create or replace function public.my_leads_housekeeping_reassign_fingerprint(
  p_org_id uuid, p_target uuid, p_sources uuid[], p_owner uuid, p_keep_clock boolean,
  p_prop_ids uuid[], p_task_ids uuid[]
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_props text;
  v_eps text;
  v_tasks text;
  v_sources text;
begin
  select coalesce(string_agg(s::text, ',' order by s), '') into v_sources from unnest(p_sources) as u(s);

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
    'reassign|' || p_target::text || '|' || v_sources || '|' || p_owner::text || '|' || p_keep_clock::text ||
    '|' || v_props || '|' || v_eps || '|' || v_tasks, 'utf8')), 'hex');
end $$;

create or replace function public.my_leads_housekeeping_reassign_task_ids(
  p_org_id uuid, p_target uuid, p_sources uuid[], p_at timestamptz
) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(tk.id order by tk.id), '{}'::uuid[])
  from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, p_sources, p_at) sc
  join public.tasks tk on tk.org_id = p_org_id and tk.related_property_id = sc.property_id
    and tk.assignee_id = sc.old_assignee
  where ((tk.type <> 'appointment' and tk.status in ('open', 'snoozed'))
      or (tk.type = 'appointment' and tk.status = 'open'))
$$;

create or replace function public.fn_my_leads_housekeeping_reassign(
  p_org_id uuid,
  p_target uuid,
  p_sources uuid[],
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
  if p_sources is null or coalesce(cardinality(p_sources), 0) = 0
     or array_position(p_sources, null) is not null then
    raise exception 'INVALID_SOURCES: name at least one source member (no nulls)' using errcode = 'P0001';
  end if;
  if p_target = any(p_sources) then
    raise exception 'INVALID_SOURCES: the target cannot be a source' using errcode = 'P0001';
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
      select sc.property_id from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, p_sources, v_now) sc)
    order by p.id for update;
    perform 1 from public.tasks tk
    where tk.org_id = p_org_id
      and tk.id = any(public.my_leads_housekeeping_reassign_task_ids(p_org_id, p_target, p_sources, v_now))
    order by tk.id for update;
  end if;

  select coalesce(array_agg(sc.property_id order by sc.property_id), '{}'::uuid[])
  into v_prop_ids
  from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, p_sources, v_now) sc;
  v_task_ids := public.my_leads_housekeeping_reassign_task_ids(p_org_id, p_target, p_sources, v_now);
  v_lead_count := coalesce(array_length(v_prop_ids, 1), 0);

  select coalesce(jsonb_agg(jsonb_build_object('from', s.old_assignee, 'count', s.n) order by s.old_assignee), '[]'::jsonb)
  into v_leads
  from (
    select sc.old_assignee, count(*) as n
    from public.my_leads_housekeeping_reassign_scope(p_org_id, p_target, p_sources, v_now) sc
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

  v_fp := public.my_leads_housekeeping_reassign_fingerprint(p_org_id, p_target, p_sources, p_owner, p_keep_clock, v_prop_ids, v_task_ids);
  v_preview := jsonb_build_object(
    'kind', 'reassign',
    'target', p_target,
    'sources', (select coalesce(jsonb_agg(s order by s), '[]'::jsonb) from (select distinct x as s from unnest(p_sources) as u(x)) d),
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
    'target', p_target, 'sources', (select coalesce(jsonb_agg(s order by s), '[]'::jsonb) from (select distinct x as s from unnest(p_sources) as u(x)) d),
    'owner', p_owner, 'keepClock', p_keep_clock, 'fingerprint', v_fp),
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

revoke all on function public.my_leads_housekeeping_reassign_scope(uuid, uuid, uuid[], timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_housekeeping_reassign_fingerprint(uuid, uuid, uuid[], uuid, boolean, uuid[], uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.my_leads_housekeeping_reassign_task_ids(uuid, uuid, uuid[], timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_my_leads_housekeeping_reassign(uuid, uuid, uuid[], uuid, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.fn_my_leads_housekeeping_reassign(uuid, uuid, uuid[], uuid, boolean, boolean, text) to service_role;

commit;
