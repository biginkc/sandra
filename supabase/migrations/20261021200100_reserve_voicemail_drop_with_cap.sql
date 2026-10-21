-- 20261021200100_reserve_voicemail_drop_with_cap.sql
-- Voicemail drop PR 3: count today's drops and insert the new voicemail_drops
-- row in ONE transaction under a per-org advisory lock, so two parallel ticks
-- cannot both read "one slot left" and overshoot VOICEMAIL_DROP_DAILY_CAP.
-- Same pattern as hold_alert_claim_with_cap (20261016010000).
--
-- Returns the new row id, or null when the org is at the cap (nothing
-- inserted). Additive: one new function, no table change. Rollback:
-- supabase/rollbacks/20261021200100_reserve_voicemail_drop_with_cap.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.reserve_voicemail_drop_with_cap(
  p_org_id uuid,
  p_cap integer,
  p_since timestamptz,
  p_enrollment_id uuid,
  p_step_run_id uuid,
  p_contact_id uuid,
  p_property_id uuid,
  p_to_phone text,
  p_provider text,
  p_audio_kind text,
  p_rendered_script text
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('voicemail_drop_cap:' || p_org_id::text, 0));

  select count(*)
    into v_count
    from public.voicemail_drops d
   where d.org_id = p_org_id
     and d.created_at >= p_since
     and d.attempt_outcome in ('queued', 'unknown');

  if v_count >= p_cap then
    return null;
  end if;

  insert into public.voicemail_drops (
    org_id, enrollment_id, step_run_id, idempotency_key, contact_id, property_id,
    to_phone, provider, audio_kind, rendered_script, status, attempt_outcome
  ) values (
    p_org_id, p_enrollment_id, p_step_run_id, p_step_run_id::text, p_contact_id, p_property_id,
    p_to_phone, p_provider, p_audio_kind, p_rendered_script, 'queued', 'unknown'
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.reserve_voicemail_drop_with_cap(uuid, integer, timestamptz, uuid, uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_voicemail_drop_with_cap(uuid, integer, timestamptz, uuid, uuid, uuid, uuid, text, text, text, text)
  to service_role;

commit;
