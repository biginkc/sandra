-- Whole-feature rollback for 20261002011737_direct_recording_monotonic_retry.
-- Run only immediately before rolling back the preceding direct-recording feature.
begin;
revoke all on function public.direct_call_recording_sync_activity(uuid,uuid,text) from public, anon, authenticated, service_role;
drop function if exists public.direct_call_recording_sync_activity(uuid,uuid,text);
revoke all on function public.direct_call_recording_mark_failed(text,uuid,text,text,timestamptz) from public, anon, authenticated, service_role;
drop function if exists public.direct_call_recording_mark_failed(text,uuid,text,text,timestamptz);
revoke all on function public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz) from public, anon, authenticated, service_role;
drop function if exists public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz);
revoke all on function public.direct_call_recording_claim(uuid,text,text,text,text,timestamptz,integer,integer) from public, anon, authenticated, service_role;
drop function if exists public.direct_call_recording_claim(uuid,text,text,text,text,timestamptz,integer,integer);
drop index if exists public.direct_call_recordings_retry_idx;
alter table public.direct_call_recordings drop column if exists next_attempt_at;
commit;
