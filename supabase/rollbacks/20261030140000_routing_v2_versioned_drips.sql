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
-- Restore authorize_sequence_provider_attempt exactly as 20260919090000 defined it.
create or replace function public.authorize_sequence_provider_attempt(
  p_enrollment_id uuid,
  p_step_id uuid,
  p_claim_id uuid,
  p_contact_id uuid,
  p_property_id uuid,
  p_phone text,
  p_message_id uuid
)
returns table (authorized boolean, reason text, attempt_outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  c public.contacts%rowtype;
  p public.properties%rowtype;
  latest_consent text;
  normalized_phone text;
begin
  -- Lock the enrollment before checking the expected step.  A committed
  -- cancel/pause before this point therefore wins and no provider call is
  -- authorized; a concurrent cancel waits until this transaction commits.
  select * into e
    from public.sequence_enrollments
   where id = p_enrollment_id
   for update;

  -- Lock and validate the claim before any rejection write. A replay with a
  -- mismatched step, or a second authorization after intent, must never
  -- downgrade an accepted/unknown claim or mutate an unrelated row.
  select * into r
    from public.sequence_step_runs
   where id = p_claim_id
     and enrollment_id = e.id
     and claim_active
   for update;
  if r.id is null then
    return query select false, 'sequence claim is not active', 'definitively_rejected';
    return;
  end if;
  if r.attempt_outcome <> 'not_attempted' then
    return query select false, 'sequence claim already has a provider outcome', r.attempt_outcome;
    return;
  end if;

  select * into s
    from public.sequence_steps
   where id = p_step_id
     and sequence_id = e.sequence_id;

  if e.id is null or s.id is null or e.status <> 'active'
     or e.current_step_index <> s.step_index
     or r.step_id <> s.id
     or not exists (
       select 1 from public.sequences seq
        where seq.id = e.sequence_id and seq.org_id = e.org_id
     ) then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'enrollment is no longer active at this step'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'enrollment is no longer active at this step', 'definitively_rejected';
    return;
  end if;

  select * into p
    from public.properties
   where id = p_property_id
     and org_id = e.org_id;
  select * into c
    from public.contacts
   where id = p_contact_id
     and org_id = e.org_id;

  if p.id is null or c.id is null or e.property_id <> p.id
     or e.contact_id <> c.id then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'sequence contact/property boundary no longer matches'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'sequence contact/property boundary no longer matches', 'definitively_rejected';
    return;
  end if;

  if p.is_dnc_locked
     or p.status in ('dead', 'closed', 'offer_sent', 'under_contract')
     or p.outreach_dispo in ('wrong_number', 'bad_number', 'dnc', 'opted_out',
                             'nurture', 'callback_requested', 'booked_appointment')
     or c.do_not_contact
     or c.sms_opted_out then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'current sequence suppression state blocks SMS'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'current sequence suppression state blocks SMS', 'definitively_rejected';
    return;
  end if;

  select ce.event_type into latest_consent
    from public.consent_events ce
   where ce.contact_id = c.id
     and ce.org_id = e.org_id
     and ce.channel = 'sms'
     and ce.event_type in (
       'opt_in_marketing_written', 'opt_in_confirmed',
       'opt_in_informational', 'opt_out', 'provider_auto_opt_out'
     )
   order by ce.occurred_at desc,
            (ce.event_type in ('opt_out', 'provider_auto_opt_out')) desc,
            ce.id desc
   limit 1;
  if latest_consent in ('opt_out', 'provider_auto_opt_out') then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'contact has opted out of SMS'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'contact has opted out of SMS', 'definitively_rejected';
    return;
  end if;

  normalized_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  -- Match the application's normalizePhone contract: US ten-digit values
  -- and their +1 eleven-digit form are equivalent; other country formats are
  -- rejected before the provider boundary.
  if length(normalized_phone) = 10 then
    normalized_phone := '1' || normalized_phone;
  elsif length(normalized_phone) <> 11 or left(normalized_phone, 1) <> '1' then
    normalized_phone := '';
  end if;
  if normalized_phone = '' or not exists (
    select 1 from (values (c.phone_1, c.phone_1_type), (c.phone_2, c.phone_2_type), (c.phone_3, c.phone_3_type)) phones(phone, phone_type)
     where case
       when length(regexp_replace(coalesce(phones.phone, ''), '[^0-9]', '', 'g')) = 10
         then '1' || regexp_replace(coalesce(phones.phone, ''), '[^0-9]', '', 'g')
       else regexp_replace(coalesce(phones.phone, ''), '[^0-9]', '', 'g')
     end = normalized_phone
       and coalesce(phones.phone_type, '') <> 'landline'
  ) then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'selected phone is no longer saved on contact'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'selected phone is no longer saved on contact', 'definitively_rejected';
    return;
  end if;

  if exists (
    select 1 from public.sms_phone_suppressions ps
     where ps.org_id = e.org_id
       and ps.channel = 'sms'
       and case
         when length(regexp_replace(coalesce(ps.phone_e164, ''), '[^0-9]', '', 'g')) = 10
           then '1' || regexp_replace(coalesce(ps.phone_e164, ''), '[^0-9]', '', 'g')
         else regexp_replace(coalesce(ps.phone_e164, ''), '[^0-9]', '', 'g')
       end = normalized_phone
  ) then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'phone number is suppressed from SMS'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'phone number is suppressed from SMS', 'definitively_rejected';
    return;
  end if;

  update public.sequence_step_runs as sr
     set message_id = p_message_id,
         attempt_outcome = 'unknown',
         attempt_started_at = now(),
         attempt_count = sr.attempt_count + 1,
         failure_reason = null
   where sr.id = r.id
     and sr.enrollment_id = e.id
     and sr.step_id = s.id
     and sr.claim_active
     and sr.attempt_outcome = 'not_attempted';
  if not found then
    return query select false, 'sequence claim changed before provider intent', 'definitively_rejected';
    return;
  end if;

  return query select true, null::text, 'unknown';
end;
$$;

revoke all on function public.authorize_sequence_provider_attempt(uuid, uuid, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.authorize_sequence_provider_attempt(uuid, uuid, uuid, uuid, uuid, text, uuid) to service_role;

-- Restore resume_sequence_enrollment exactly as 20261008143600 defined it.
create or replace function public.resume_sequence_enrollment(
  p_enrollment_id uuid,
  p_actor_user_id uuid default null,
  p_expected_pause_reason text default null
)
returns table (outcome text, next_run_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  next_at timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id for update;
  if e.id is null then
    return query select 'not_found', null::timestamptz;
    return;
  end if;
  if (coalesce(auth.role(), '') = 'service_role' and p_actor_user_id is not null)
     or (coalesce(auth.role(), '') <> 'service_role' and (
       auth.uid() is null
       or (p_actor_user_id is not null and p_actor_user_id <> auth.uid())
       or not exists (
         select 1 from public.memberships m
          where m.org_id = e.org_id and m.user_id = auth.uid()
       )
     )) then
    return query select 'not_authorized', null::timestamptz;
    return;
  end if;
  if e.status <> 'paused' then
    return query select 'not_paused', e.next_run_at;
    return;
  end if;
  -- [I1] The caller decided to resume based on a read of the pause reason. A
  -- reply, takeover or Norma conversion may have changed it since.
  if p_expected_pause_reason is not null
     and e.pause_reason is distinct from p_expected_pause_reason then
    return query select 'pause_reason_changed', e.next_run_at;
    return;
  end if;
  -- [G2] An open Norma request holds every enrollment on the property.
  if public.fn_norma_hold_active(e.property_id) then
    return query select 'norma_hold', e.next_run_at;
    return;
  end if;
  -- consent_unavailable is deliberately NOT in this list: the tick retired the
  -- claim as not_attempted before pausing (no text was attempted), so a plain
  -- resume is the correct and only recovery.
  if coalesce(e.pause_reason, '') in ('reconciliation_required', 'provider_failed') then
    return query select 'retry_required', e.next_run_at;
    return;
  end if;

  select * into s from public.sequence_steps
   where sequence_id = e.sequence_id and step_index = e.current_step_index;
  if s.id is not null then
    select * into r from public.sequence_step_runs
     where enrollment_id = e.id and step_id = s.id and claim_active
     order by created_at desc limit 1
     for update;
    if r.id is not null then
      if r.attempt_outcome not in ('not_attempted', 'definitively_rejected') then
        return query select 'reconciliation_required', e.next_run_at;
        return;
      end if;
      update public.sequence_step_runs
         set claim_active = false,
             recovery_actor_user_id = coalesce(p_actor_user_id, auth.uid()),
             recovery_action = 'resume',
             recovery_evidence = 'paused enrollment resumed with a proven no-attempt claim'
       where id = r.id and claim_active;
    end if;
    next_at := now() + make_interval(mins => s.delay_after_previous_minutes);
  else
    next_at := now();
  end if;

  -- A new consent-check budget starts at every resume: relabel this
  -- enrollment's deferred consent_unavailable rows so the tick's consecutive
  -- count (which counts only 'consent_unavailable_deferred') ignores them.
  update public.sequence_step_runs
     set recovery_action = 'consent_unavailable_resumed'
   where enrollment_id = e.id
     and recovery_action = 'consent_unavailable_deferred';

  update public.sequence_enrollments
     set status = 'active', pause_reason = null, next_run_at = next_at, updated_at = now()
   where id = e.id and status = 'paused';
  return query select 'resumed', next_at;
end;
$$;

revoke all on function public.resume_sequence_enrollment(uuid, uuid, text) from public, anon;
grant execute on function public.resume_sequence_enrollment(uuid, uuid, text) to authenticated, service_role;

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
drop function if exists public.routing_v2_record_provider_outcome(uuid, text, uuid);
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
