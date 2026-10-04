-- Roll back 20261005121500_next_step_relabel_functions.
-- Drops the four new functions and restores the 20261005100100 bodies of the rollback entry
-- point and its fingerprint verbatim. Run the relabel data rollback for every applied 'relabel'
-- run BEFORE this: afterwards a relabel run can no longer be rolled back (ROLLBACK_UNSUPPORTED).
begin;

drop function if exists public.fn_my_leads_relabel_open_next_steps(uuid, uuid, boolean, text, timestamptz);
drop function if exists public.fn_set_next_step_mode(uuid, text, text);
drop function if exists public.fn_my_leads_next_step_retire_preflight(uuid);
drop function if exists public.my_leads_relabel_candidate_ids(uuid, timestamptz);

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

commit;
