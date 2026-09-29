-- Read-only per-step outcomes and atomic copy into a new, empty drip.
create or replace function public.sequence_step_stats(p_org uuid, p_sequence uuid)
returns table (step_id uuid, sent bigint, replied bigint, waiting bigint)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or p_sequence is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.sequences s where s.id = p_sequence and s.org_id = p_org)
  then raise exception 'SEQUENCE_NOT_FOUND' using errcode = 'P0002'; end if;

  return query
  select st.id,
    count(distinct sr.enrollment_id) filter (where sr.message_id is not null and msg.sent_at is not null)::bigint,
    count(distinct sr.enrollment_id) filter (where sr.message_id is not null and msg.sent_at is not null and exists (
      select 1 from public.messages inbound
      where inbound.org_id = p_org and inbound.property_id = e.property_id
        and inbound.direction = 'inbound' and inbound.created_at > msg.sent_at
        and not exists (
          select 1 from public.sequence_step_runs later_run
          join public.messages later_msg on later_msg.id = later_run.message_id
          where later_run.enrollment_id = e.id and later_msg.sent_at is not null
            and later_msg.sent_at > msg.sent_at and later_msg.sent_at <= inbound.created_at
        )
    ))::bigint,
    count(distinct e.id) filter (where e.status = 'active'
      and e.current_step_index = st.step_index + 1 and sr.message_id is not null
      and msg.sent_at is not null)::bigint
  from public.sequence_steps st
  left join public.sequence_enrollments e on e.sequence_id = p_sequence and e.org_id = p_org
  left join public.sequence_step_runs sr on sr.enrollment_id = e.id and sr.step_id = st.id
  left join public.messages msg on msg.id = sr.message_id and msg.org_id = p_org
  where st.sequence_id = p_sequence
  group by st.id, st.step_index
  order by st.step_index;
end;
$$;
revoke all on function public.sequence_step_stats(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_step_stats(uuid, uuid) to authenticated;

create or replace function public.sequence_copy_steps(p_target uuid, p_source uuid)
returns integer
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
declare
  target_org uuid;
  copied integer;
begin
  if p_target is null or p_source is null or p_target = p_source or auth.uid() is null
  then raise exception 'INVALID_SEQUENCE' using errcode = '22023'; end if;
  -- The target row lock serializes concurrent copy attempts.
  select s.org_id into target_org from public.sequences s where s.id = p_target for update;
  if target_org is null or not exists (
    select 1 from public.memberships m where m.org_id = target_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.sequences s where s.id = p_source and s.org_id = target_org)
  then raise exception 'SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.sequence_steps where sequence_id = p_target
  ) then raise exception 'TARGET_NOT_EMPTY' using errcode = '23514'; end if;
  if not exists (select 1 from public.sequence_steps where sequence_id = p_source)
  then raise exception 'SOURCE_EMPTY' using errcode = '23514'; end if;

  insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes,
    action_type, template_body, template_id, target_status)
  select p_target, st.step_index, st.delay_after_previous_minutes,
    st.action_type, st.template_body, st.template_id, st.target_status
  from public.sequence_steps st where st.sequence_id = p_source order by st.step_index;
  get diagnostics copied = row_count;
  return copied;
end;
$$;
revoke all on function public.sequence_copy_steps(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_copy_steps(uuid, uuid) to authenticated;


-- Keep overview and needs-person reply buckets aligned with per-step send timestamps.
create or replace function public.sequence_overview_stats(p_org uuid)
returns table (
  id uuid, name text, description text, active boolean, append_opt_out boolean,
  archived_at timestamptz, created_at timestamptz, created_by uuid,
  step_count bigint, active_enrollment_count bigint,
  waiting bigint, replied bigint, finished_no_reply bigint,
  couldnt_send bigint, stopped bigint, last_sent timestamptz
)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  select s.id, s.name, s.description, s.active, s.append_opt_out, s.archived_at,
    s.created_at, s.created_by,
    (select count(*) from public.sequence_steps ss where ss.sequence_id = s.id),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status in ('active','paused')),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'active'),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'paused'
      and e.pause_reason in ('inbound_reply','rep_sms_human_takeover')),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'completed'
      and not exists (select 1 from public.lead_events le where le.org_id = p_org
        and le.property_id = e.property_id and le.event_type = 'sequence_canceled'
        and le.source_id = e.id)
      and not exists (select 1 from public.messages msg where msg.org_id = p_org
        and msg.property_id = e.property_id and msg.direction = 'inbound'
        and msg.created_at > coalesce((select max(sent.sent_at) from public.sequence_step_runs sr
          join public.messages sent on sent.id = sr.message_id and sent.org_id = p_org
          where sr.enrollment_id = e.id), e.enrolled_at))),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'paused'
      and e.pause_reason in ('provider_failed','reconciliation_required')),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and (e.status = 'opted_out' or
        (e.status = 'completed' and exists (select 1 from public.lead_events le
          where le.org_id = p_org and le.property_id = e.property_id
            and le.event_type = 'sequence_canceled' and le.source_id = e.id)))),
    (select max(sr.run_at) from public.sequence_enrollments e
      join public.sequence_step_runs sr on sr.enrollment_id = e.id
      where e.sequence_id = s.id and e.org_id = p_org and sr.message_id is not null)
  from public.sequences s where s.org_id = p_org
  order by s.created_at desc, s.id desc limit 500;
end;
$$;
revoke all on function public.sequence_overview_stats(uuid) from public, anon, service_role;
grant execute on function public.sequence_overview_stats(uuid) to authenticated;

create or replace function public.sequence_needs_person(p_org uuid)
returns table (property_id uuid, sequence_id uuid, bucket text, reason text, sequence_created_by uuid)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  with candidates as (
    select e.property_id, e.sequence_id, 'finished_no_reply'::text as bucket,
      'Finished, no reply'::text as reason, 1 as priority
    from public.sequence_enrollments e
    where e.org_id = p_org and e.status = 'completed'
      and not exists (select 1 from public.lead_events le where le.org_id = p_org
        and le.property_id = e.property_id and le.event_type = 'sequence_canceled'
        and le.source_id = e.id)
      and not exists (select 1 from public.messages msg where msg.org_id = p_org
        and msg.property_id = e.property_id and msg.direction = 'inbound'
        and msg.created_at > coalesce((select max(sent.sent_at) from public.sequence_step_runs sr
          join public.messages sent on sent.id = sr.message_id and sent.org_id = p_org
          where sr.enrollment_id = e.id), e.enrolled_at))
    union all
    select e.property_id, e.sequence_id, 'couldnt_send'::text, 'Couldn''t send'::text, 2
    from public.sequence_enrollments e where e.org_id = p_org and e.status = 'paused'
      and e.pause_reason in ('provider_failed','reconciliation_required')
    union all
    select p.id, null::uuid, 'needs_sequence'::text, 'Needs a sequence'::text, 3
    from public.properties p where p.org_id = p_org and p.outreach_dispo = 'needs_sequence'
      and p.deleted_at is null
      and not exists (select 1 from public.sequence_enrollments e
        where e.property_id = p.id and e.org_id = p_org and e.status in ('active','paused'))
  )
  select distinct on (c.property_id) c.property_id, c.sequence_id, c.bucket, c.reason, s.created_by
  from candidates c join public.properties p on p.id = c.property_id and p.org_id = p_org
  left join public.sequences s on s.id = c.sequence_id and s.org_id = p_org
  where p.deleted_at is null
  order by c.property_id, c.priority limit 500;
end;
$$;
revoke all on function public.sequence_needs_person(uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person(uuid) to authenticated;
