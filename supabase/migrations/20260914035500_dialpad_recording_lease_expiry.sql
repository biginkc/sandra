begin;
-- Evaluate on the locked row at execution time, not client or statement start.
-- Reclaim to a fresh processing lease remains allowed; expired workers cannot
-- publish success/failure or release their lease before another worker reclaims.
create function public.dialpad_recording_require_live_lease() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status='processing' and new.status is distinct from 'processing'
 and old.lease_expires_at<=clock_timestamp() then
 raise exception 'DIALPAD_RECORDING_LEASE_EXPIRED' using errcode='23514'; end if;
 return new;
end $$;
create trigger dialpad_recording_live_lease before update on public.dialpad_recording_artifacts for each row execute function public.dialpad_recording_require_live_lease();
commit;
