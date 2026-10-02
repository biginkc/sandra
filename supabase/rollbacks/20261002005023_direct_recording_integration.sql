-- Whole-feature rollback for 20261002005023_direct_recording_integration.
begin;
drop table if exists public.direct_call_recordings;
drop index if exists public.call_recordings_provider_recording_unique_idx;
alter table public.call_recordings
  drop column if exists provider_recording_id,
  drop column if exists provider_call_control_id,
  drop column if exists provider_call_leg_id,
  drop column if exists provider_call_session_id,
  drop column if exists storage_bucket;
drop index if exists public.call_activities_direct_call_unique_idx;
alter table public.call_activities drop column if exists direct_call_id;
-- Supabase protects storage metadata from direct SQL deletion. The private
-- empty bucket is intentionally retained; remove it through the Storage API
-- only after confirming all objects have been deleted.
commit;
