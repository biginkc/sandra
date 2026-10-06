-- Rollback for 20261008130000_dialpad_call_audio. Remove the cron entry and route first (or leave them: the route
-- answers `disabled` once these functions are gone). Stored audio objects in the private `dialpad-call-audio`
-- bucket are left in place on purpose (Storage objects cannot be dropped from SQL); the bucket row stays too.
-- Any unresolved Dialpad share links recorded in dialpad_share_link_attempts are dropped with the table: before
-- rolling back, check that none is `live`, `downloaded` or `ambiguous` (they would remain in Dialpad).
begin;
drop trigger if exists dialpad_call_audio_enqueue_trg on public.call_activities;
drop function if exists public.dialpad_call_audio_enqueue();
drop function if exists public.fn_dialpad_audio_for_service(uuid, uuid, text);
drop function if exists public.fn_dialpad_audio_authorize(uuid, uuid, uuid);
drop function if exists public.fn_dpa_register_stored(uuid, uuid, text, bigint, text, bigint);
drop function if exists public.fn_dpa_mark_uploading(uuid, uuid, text, bigint, bigint);
drop function if exists public.fn_dpa_audio_fail(uuid, uuid, text, text, text);
drop function if exists public.fn_dpa_resolve_ambiguous(uuid, text);
drop function if exists public.fn_dpa_attempt_set(uuid, uuid, text, text, text, text, text, text);
drop function if exists public.fn_dpa_attempt_begin(uuid, uuid);
drop function if exists public.fn_dpa_requeue_denied(uuid, uuid, text);
drop function if exists public.fn_dpa_discovery_result(uuid, uuid, text, text, bigint, text, text);
drop function if exists public.fn_dpa_queue(uuid, integer);
drop function if exists public.fn_dpa_worker_block(uuid, timestamptz);
drop function if exists public.fn_dpa_worker_release(uuid, timestamptz, timestamptz);
drop function if exists public.fn_dpa_worker_take(uuid);
drop function if exists public.dpa_assert_holder(uuid);
drop table if exists public.dialpad_audio_access_log;
drop table if exists public.dialpad_recording_worker;
drop table if exists public.dialpad_share_link_attempts;
drop table if exists public.dialpad_call_audio;
drop function if exists public.dialpad_call_audio_path(uuid, uuid, text);
alter table public.my_leads_feature_flags
  drop constraint if exists my_leads_feature_flags_audio_consumers_check,
  drop column if exists audio_consumers,
  drop column if exists recording_download_canary_call_ids,
  drop column if exists recording_download;
commit;
