-- A lead marked Dead no longer needs human drip triage. Keep the RPC tenant-scoped.
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
          where sr.enrollment_id = e.id and sr.message_id is not null), e.enrolled_at))
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
  where p.deleted_at is null and p.status <> 'dead'
  order by c.property_id, c.priority limit 500;
end;
$$;
revoke all on function public.sequence_needs_person(uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person(uuid) to authenticated;
