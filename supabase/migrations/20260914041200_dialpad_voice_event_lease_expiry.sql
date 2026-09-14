begin;
-- A worker may finish only while its processing lease is live at row-update time.
-- Reclaim to a fresh processing lease remains possible after expiration.
create function public.dialpad_voice_event_require_live_lease() returns trigger language plpgsql set search_path='' as $$
begin
 if old.status='processing' and new.status is distinct from 'processing'
 and old.lease_expires_at<=clock_timestamp() then
  raise exception 'DIALPAD_VOICE_EVENT_LEASE_EXPIRED' using errcode='23514';
 end if;
 return new;
end $$;
create trigger dialpad_voice_event_live_lease before update on public.dialpad_voice_event_inbox
 for each row execute function public.dialpad_voice_event_require_live_lease();
commit;
