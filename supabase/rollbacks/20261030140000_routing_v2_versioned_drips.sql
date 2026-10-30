-- Roll back 20261030140000_routing_v2_versioned_drips.
-- Refuses while any v2 enrollment exists (stop them first: flags.drips = false, then let
-- sequence-tick stop them, or set them completed). Legacy rows are never touched.
begin;
set local routing_v2.allow_drip_edit = 'on';


do $$
begin
  if exists (select 1 from public.sequence_enrollments where routing_v2_engine = 'v2') then
    raise exception 'routing v2 enrollments exist; stop and remove them before rolling back';
  end if;
  if exists (select 1 from public.sequence_enrollments e join public.sequences s on s.id = e.sequence_id
             where s.routing_v2_key is not null) then
    raise exception 'enrollments point at routing v2 drips; remove them before rolling back';
  end if;
end $$;

drop trigger if exists routing_v2_reject_drip_step_edit on public.sequence_steps;
drop trigger if exists routing_v2_reject_drip_edit on public.sequences;
drop function if exists public.routing_v2_reject_drip_edit();
-- Restore sequence_needs_person exactly as 20260929239000 defined it.
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
        and msg.created_at > coalesce((select max(coalesce(sent.sent_at, sr.run_at)) from public.sequence_step_runs sr
          left join public.messages sent on sent.id = sr.message_id and sent.org_id = p_org
          where sr.enrollment_id = e.id and sr.message_id is not null), e.enrolled_at))
    union all
    select e.property_id, e.sequence_id, 'couldnt_send'::text, 'Couldn''t send'::text, 2
    from latest_enrollments e where e.status = 'paused'
      and e.pause_reason in ('provider_failed','reconciliation_required','template_missing','step_misconfigured','no_phone','no_approved_sender','no approved sender for first-touch sequence send')
    union all
    select p.id, null::uuid, 'needs_sequence'::text, 'Needs a sequence'::text, 3
    from public.properties p where p.org_id = p_org and p.outreach_dispo = 'needs_sequence'
      and p.deleted_at is null and p.is_dnc_locked is not true
      and exists (select 1 from public.messages inbound where inbound.org_id = p_org
        and inbound.property_id = p.id and inbound.direction = 'inbound')
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

-- Restore sequence_copy_steps exactly as 20261021200400 defined it.
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
    action_type, template_body, template_id, template_category, target_status,
    vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id, vm_template_category)
  select p_target, st.step_index, st.delay_after_previous_minutes,
    st.action_type, st.template_body, st.template_id, st.template_category, st.target_status,
    st.vm_media_id, st.vm_tts_body, st.vm_voice_id, st.vm_phone_line_id, st.vm_template_category
  from public.sequence_steps st where st.sequence_id = p_source order by st.step_index;
  get diagnostics copied = row_count;
  return copied;
end;
$$;
revoke all on function public.sequence_copy_steps(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_copy_steps(uuid, uuid) to authenticated;

-- Restore pause_enrollments_for_inbound_call exactly as 20261021200300 defined it.
create or replace function public.pause_enrollments_for_inbound_call(p_contact_ids uuid[])
returns table (id uuid, property_id uuid, sequence_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.sequence_enrollments e
     set status = 'paused', pause_reason = 'inbound_call', updated_at = now()
   where e.property_id in (
           select pr.id from public.properties pr where pr.homeowner_contact_id = any(p_contact_ids)
         )
     and (e.status = 'active'
          or (e.status = 'paused'
              and e.pause_reason in ('reconciliation_required', 'call_in_progress', 'norma_call')))
  returning e.id, e.property_id, e.sequence_id;
end;
$$;
revoke all on function public.pause_enrollments_for_inbound_call(uuid[]) from public, anon, authenticated;
grant execute on function public.pause_enrollments_for_inbound_call(uuid[]) to service_role;
drop trigger if exists routing_v2_reject_foreign_enrollment on public.sequence_enrollments;
drop function if exists public.routing_v2_reject_foreign_enrollment();
drop function if exists public.routing_v2_mark_drip_claim_sent(uuid, text);
drop function if exists public.routing_v2_advance_after_send(uuid, integer, uuid);
drop function if exists public.routing_v2_stop_disabled();
drop function if exists public.routing_v2_reconcile_claims(interval);
drop function if exists public.routing_v2_chain_after_completion(uuid);
drop function if exists public.routing_v2_claim_drip_send(uuid, uuid);
drop function if exists public.routing_v2_enrollment_send_check(uuid);
drop function if exists public.routing_v2_claim_outbox(uuid);
drop function if exists public.routing_v2_cancel_for_takeover(uuid);
drop function if exists public.route_reply_transition(uuid, uuid, jsonb);
drop function if exists public.routing_v2_enroll(uuid, uuid, uuid, uuid, uuid);
drop function if exists public.routing_v2_sequence_for(uuid, text);
drop function if exists public.routing_v2_contact_suppressed(uuid, uuid);
drop function if exists public.routing_v2_slice_enabled(uuid, text);
drop function if exists public.routing_v2_canary_eligible(jsonb, uuid);
drop table if exists public.routing_v2_drip_send_claims;
drop table if exists public.routing_v2_outbox;
drop table if exists public.routing_v2_reply_transitions;

-- The seeded drips have no enrollments (checked above); steps cascade.
delete from public.sequences where routing_v2_key is not null;

drop index if exists public.idx_enrollments_routing_v2_one_active;
alter table public.sequence_enrollments drop constraint if exists sequence_enrollments_routing_v2_engine_check;
alter table public.sequence_enrollments
  drop column if exists routing_v2_inbound_id,
  drop column if exists retired_by_inbound_id,
  drop column if exists ended_reason,
  drop column if exists routing_v2_engine;
alter table public.sequence_steps drop constraint if exists sequence_steps_slot_window_check;
alter table public.sequence_steps drop column if exists slot_window;
drop index if exists public.idx_sequences_routing_v2_key_version;
alter table public.sequences drop constraint if exists sequences_routing_v2_key_check;
alter table public.sequences
  drop column if exists routing_v2_then_key,
  drop column if exists routing_v2_version,
  drop column if exists routing_v2_key;

commit;
