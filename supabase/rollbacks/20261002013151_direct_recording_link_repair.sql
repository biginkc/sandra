-- Whole-feature rollback for 20261002013151_direct_recording_link_repair.
begin;
drop function if exists public.direct_call_recording_sync_activity(uuid,uuid,text,timestamptz);
drop function if exists public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz);

-- Restore the immediately preceding feature's three-argument sync helper and
-- completion function so this migration can be rolled back independently.
create or replace function public.direct_call_recording_sync_activity(
  p_direct_call_id uuid, p_call_activity_id uuid, p_provider_recording_id text
) returns void language plpgsql security invoker set search_path = public as $$
declare
  v_stage public.direct_call_recordings%rowtype;
begin
  if p_direct_call_id is null or p_call_activity_id is null or nullif(btrim(p_provider_recording_id), '') is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_stage from public.direct_call_recordings
   where direct_call_id = p_direct_call_id and provider_recording_id = p_provider_recording_id;
  if not found then return; end if;
  insert into public.call_recordings (
    call_activity_id, status, provider_recording_id, provider_call_control_id,
    provider_call_leg_id, provider_call_session_id, storage_bucket, storage_path,
    duration_seconds, error_code, error_message
  ) values (
    p_call_activity_id, v_stage.status, v_stage.provider_recording_id, v_stage.provider_call_control_id,
    v_stage.provider_call_leg_id, v_stage.provider_call_session_id, v_stage.storage_bucket, v_stage.storage_path,
    v_stage.duration_seconds, v_stage.error_code, v_stage.error_message
  ) on conflict (provider_recording_id) do update set
    call_activity_id = excluded.call_activity_id,
    status = case when public.call_recordings.status = 'available' then 'available' else excluded.status end,
    provider_call_control_id = excluded.provider_call_control_id,
    provider_call_leg_id = excluded.provider_call_leg_id,
    provider_call_session_id = excluded.provider_call_session_id,
    storage_bucket = case when public.call_recordings.status = 'available' and public.call_recordings.storage_bucket is not null then public.call_recordings.storage_bucket else excluded.storage_bucket end,
    storage_path = case when public.call_recordings.status = 'available' and public.call_recordings.storage_path is not null then public.call_recordings.storage_path else excluded.storage_path end,
    duration_seconds = case when public.call_recordings.status = 'available' and public.call_recordings.duration_seconds is not null then public.call_recordings.duration_seconds else excluded.duration_seconds end,
    error_code = case when public.call_recordings.status = 'available' then null else excluded.error_code end,
    error_message = case when public.call_recordings.status = 'available' then null else excluded.error_message end;
end;
$$;
revoke all on function public.direct_call_recording_sync_activity(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.direct_call_recording_sync_activity(uuid,uuid,text) to service_role;

create or replace function public.direct_call_recording_mark_available(
  p_provider_recording_id text, p_direct_call_id uuid, p_storage_bucket text,
  p_storage_path text, p_duration_seconds integer, p_now timestamptz
) returns boolean language plpgsql security invoker set search_path = public as $$
declare v_count integer;
begin
  update public.direct_call_recordings
     set status = 'available', storage_bucket = p_storage_bucket, storage_path = p_storage_path,
         duration_seconds = p_duration_seconds, error_code = null, error_message = null,
         next_attempt_at = null, updated_at = p_now
   where provider_recording_id = p_provider_recording_id and direct_call_id = p_direct_call_id;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;
revoke all on function public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz) to service_role;
alter table public.direct_call_recordings drop constraint if exists direct_call_recordings_link_attempt_count_check;
 drop index if exists public.direct_call_recordings_link_retry_idx;
alter table public.direct_call_recordings
  drop column if exists link_attempt_count,
  drop column if exists link_next_attempt_at,
  drop column if exists linked_at;
commit;
