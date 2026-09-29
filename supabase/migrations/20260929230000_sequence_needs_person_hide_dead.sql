-- A lead marked Dead no longer needs human drip triage. Keep the RPC tenant-scoped.
create index if not exists idx_sequence_enrollments_latest_per_property
  on public.sequence_enrollments(org_id, property_id, enrolled_at desc, id desc);

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
  with latest_enrollments as (
    select distinct on (e.property_id) e.*
    from public.sequence_enrollments e
    where e.org_id = p_org
    order by e.property_id, e.enrolled_at desc, e.id desc
  ), candidates as (
    select e.property_id, e.sequence_id, 'finished_no_reply'::text as bucket,
      'Finished, no reply'::text as reason, 1 as priority
    from latest_enrollments e
    where e.status = 'completed'
      and not exists (select 1 from public.lead_events le where le.org_id = p_org
        and le.property_id = e.property_id and le.event_type = 'sequence_canceled'
        and le.source_id = e.id)
      and not exists (select 1 from public.messages msg where msg.org_id = p_org
        and msg.property_id = e.property_id and msg.direction = 'inbound'
        and msg.created_at > coalesce((select max(sr.run_at) from public.sequence_step_runs sr
          where sr.enrollment_id = e.id and sr.message_id is not null), e.enrolled_at))
    union all
    select e.property_id, e.sequence_id, 'couldnt_send'::text, 'Couldn''t send'::text, 2
    from latest_enrollments e where e.status = 'paused'
      and e.pause_reason in ('provider_failed','reconciliation_required')
    union all
    select p.id, null::uuid, 'needs_sequence'::text, 'Needs a sequence'::text, 3
    from public.properties p where p.org_id = p_org and p.outreach_dispo = 'needs_sequence'
      and p.deleted_at is null
      and not exists (select 1 from latest_enrollments e
        where e.property_id = p.id and e.status in ('active','paused'))
  )
  select distinct on (c.property_id) c.property_id, c.sequence_id, c.bucket, c.reason, s.created_by
  from candidates c join public.properties p on p.id = c.property_id and p.org_id = p_org
  left join public.sequences s on s.id = c.sequence_id and s.org_id = p_org
  where p.deleted_at is null and p.status <> 'dead'
  order by c.property_id, c.priority;
end;
$$;
revoke all on function public.sequence_needs_person(uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person(uuid) to authenticated;

create or replace function public.sequence_needs_person_counts(p_org uuid, p_exclude_created_by uuid default null)
returns table (finished_no_reply bigint, couldnt_send bigint, needs_sequence bigint)
language sql security invoker set search_path = '' set statement_timeout = '5s'
as $$
  select count(*) filter (where n.bucket = 'finished_no_reply'),
    count(*) filter (where n.bucket = 'couldnt_send'),
    count(*) filter (where n.bucket = 'needs_sequence')
  from public.sequence_needs_person(p_org) n
  where p_exclude_created_by is null or n.sequence_created_by is distinct from p_exclude_created_by;
$$;
revoke all on function public.sequence_needs_person_counts(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person_counts(uuid, uuid) to authenticated;

create or replace function public.sequence_needs_person_page(
  p_org uuid, p_bucket text, p_offset integer, p_limit integer, p_exclude_created_by uuid default null
)
returns table (property_id uuid, sequence_id uuid, bucket text, reason text, sequence_created_by uuid)
language plpgsql security invoker set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_bucket not in ('finished_no_reply', 'couldnt_send', 'needs_sequence')
    or p_bucket is null or p_offset is null or p_offset < 0
    or p_limit is null or p_limit < 1 or p_limit > 100
  then raise exception 'Invalid needs-person page' using errcode = '22023'; end if;
  return query
    select n.property_id, n.sequence_id, n.bucket, n.reason, n.sequence_created_by
    from public.sequence_needs_person(p_org) n
    where n.bucket = p_bucket
      and (p_exclude_created_by is null or n.sequence_created_by is distinct from p_exclude_created_by)
    order by n.property_id
    limit p_limit offset p_offset;
end;
$$;
revoke all on function public.sequence_needs_person_page(uuid, text, integer, integer, uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person_page(uuid, text, integer, integer, uuid) to authenticated;
