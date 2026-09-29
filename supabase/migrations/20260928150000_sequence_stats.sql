-- Bounded, tenant-scoped drip read models. Safe to reapply.
create index if not exists idx_enrollments_sequence_status
  on public.sequence_enrollments(sequence_id, status);
create index if not exists idx_step_runs_message
  on public.sequence_step_runs(message_id) where message_id is not null;

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
        and msg.created_at > coalesce((select max(sr.run_at) from public.sequence_step_runs sr
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
        and msg.created_at > coalesce((select max(sr.run_at) from public.sequence_step_runs sr
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
