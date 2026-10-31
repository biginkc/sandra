-- Rollback of 20261030410000: restore routing_v2_enrollment_send_check exactly as in
-- 20261030181000 (no held-for-person clause). Drips already paused by the clause stay paused
-- (pause_reason inbound_reply), the same state the webhook leaves; nothing else changes.
begin;
set local lock_timeout = '5s';

create or replace function public.routing_v2_enrollment_send_check(p_enrollment_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments;
  v_takeover timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if not found then return 'missing'; end if;
  if e.routing_v2_engine is distinct from 'v2' then
    -- Legacy enrollment: untouched, unless it points at a v2 drip (only routing v2 may enroll
    -- there; anything else would send approved texts with no flag/canary/takeover check).
    if not exists (select 1 from public.sequences s where s.id = e.sequence_id and s.routing_v2_key is not null) then
      return 'ok';
    end if;
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
    select * into e from public.sequence_enrollments where id = p_enrollment_id;
    if e.status <> 'active' then return 'not_active'; end if;
    if coalesce((select is_dnc_locked from public.properties where id = e.property_id), false) then
      update public.sequence_enrollments
      set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
      where id = e.id and status = 'active';
      return 'suppressed';
    end if;
    update public.sequence_enrollments
    set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
    where id = e.id and status = 'active';
    return 'flag_off';
  end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if e.status <> 'active' then return 'not_active'; end if;

  -- DNC lock first: the only write the lock trigger allows is the compliance opt-out.
  if coalesce((select is_dnc_locked from public.properties where id = e.property_id), false) then
    update public.sequence_enrollments
    set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'suppressed';
  end if;

  if not public.routing_v2_slice_enabled(e.property_id, 'drips') then
    update public.sequence_enrollments
    set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
    where id = e.id and status = 'active';
    return 'flag_off';
  end if;
  select last_person_takeover_at into v_takeover from public.properties where id = e.property_id;
  if v_takeover is not null and v_takeover >= e.enrolled_at then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'person_took_over', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'person_took_over';
  end if;
  if public.routing_v2_contact_suppressed(e.property_id, e.contact_id) then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'consent_revoked', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'suppressed';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.routing_v2_enrollment_send_check(uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_enrollment_send_check(uuid) to service_role;
commit;
