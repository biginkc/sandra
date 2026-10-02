-- Make direct recording capture monotonic and durably retryable.
-- This migration follows 20261002005023_direct_recording_integration.sql.
begin;

alter table public.direct_call_recordings
  add column if not exists next_attempt_at timestamptz;

update public.direct_call_recordings
   set next_attempt_at = coalesce(next_attempt_at, now())
 where next_attempt_at is null
   and status in ('pending', 'failed');

create index if not exists direct_call_recordings_retry_idx
  on public.direct_call_recordings (next_attempt_at, updated_at)
  where status in ('pending', 'failed') and attempt_count < 8;

-- Claims one capture attempt under a row lock. A pending/failed row is leased
-- until next_attempt_at, so duplicate webhooks cannot start concurrent downloads.
-- Eight attempts are the durable retry cap; the table's 100-attempt check remains
-- a storage invariant for older/manual rows.
create or replace function public.direct_call_recording_claim(
  p_direct_call_id uuid,
  p_provider_recording_id text,
  p_provider_call_control_id text,
  p_provider_call_leg_id text,
  p_provider_call_session_id text,
  p_now timestamptz,
  p_attempt_cap integer default 8,
  p_lease_secs integer default 900
) returns table(should_capture boolean, status text, storage_bucket text, storage_path text, attempt_count integer)
language plpgsql security invoker set search_path = public as $$
declare
  v_row public.direct_call_recordings%rowtype;
begin
  if p_direct_call_id is null or nullif(btrim(p_provider_recording_id), '') is null
     or nullif(btrim(p_provider_call_control_id), '') is null or p_now is null
     or p_attempt_cap < 1 or p_attempt_cap > 100 or p_lease_secs < 1 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into v_row
    from public.direct_call_recordings
   where provider_recording_id = p_provider_recording_id
   for update;

  if found then
    if v_row.direct_call_id <> p_direct_call_id
       or v_row.provider_call_control_id <> p_provider_call_control_id then
      raise exception 'RECORDING_IDENTITY_MISMATCH' using errcode = '22023';
    end if;
    if v_row.status = 'available' and nullif(btrim(v_row.storage_path), '') is not null then
      return query select false, v_row.status, v_row.storage_bucket, v_row.storage_path, v_row.attempt_count;
      return;
    end if;
    if v_row.attempt_count >= p_attempt_cap
       or (v_row.next_attempt_at is not null and v_row.next_attempt_at > p_now) then
      return query select false, v_row.status, v_row.storage_bucket, v_row.storage_path, v_row.attempt_count;
      return;
    end if;

    update public.direct_call_recordings
       set provider_call_leg_id = coalesce(p_provider_call_leg_id, provider_call_leg_id),
           provider_call_session_id = coalesce(p_provider_call_session_id, provider_call_session_id),
           status = 'pending',
           error_code = null,
           error_message = null,
           attempt_count = attempt_count + 1,
           last_attempt_at = p_now,
           next_attempt_at = p_now + make_interval(secs => p_lease_secs),
           updated_at = p_now
     where id = v_row.id
     returning * into v_row;
  else
    insert into public.direct_call_recordings (
      direct_call_id, provider_recording_id, provider_call_control_id,
      provider_call_leg_id, provider_call_session_id, status, attempt_count,
      last_attempt_at, next_attempt_at, updated_at
    ) values (
      p_direct_call_id, p_provider_recording_id, p_provider_call_control_id,
      p_provider_call_leg_id, p_provider_call_session_id, 'pending', 1,
      p_now, p_now + make_interval(secs => p_lease_secs), p_now
    ) returning * into v_row;
  end if;

  return query select true, v_row.status, v_row.storage_bucket, v_row.storage_path, v_row.attempt_count;
end;
$$;

-- Completion wins over any concurrent failure. Calling this on an already
-- available row is harmless and repairs metadata without making it pending.
create or replace function public.direct_call_recording_mark_available(
  p_provider_recording_id text,
  p_direct_call_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_duration_seconds integer,
  p_now timestamptz
) returns boolean
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer;
begin
  if nullif(btrim(p_provider_recording_id), '') is null
     or p_direct_call_id is null or nullif(btrim(p_storage_bucket), '') is null
     or nullif(btrim(p_storage_path), '') is null or p_duration_seconds is null
     or p_duration_seconds < 0 or p_now is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.direct_call_recordings
     set status = 'available', storage_bucket = p_storage_bucket, storage_path = p_storage_path,
         duration_seconds = p_duration_seconds, error_code = null, error_message = null,
         next_attempt_at = null, updated_at = p_now
   where provider_recording_id = p_provider_recording_id
     and direct_call_id = p_direct_call_id;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- A capture failure is retryable, but never downgrades an available row. The
-- backoff is bounded so cron can make progress without hot-looping provider URLs.
create or replace function public.direct_call_recording_mark_failed(
  p_provider_recording_id text,
  p_direct_call_id uuid,
  p_error_code text,
  p_error_message text,
  p_now timestamptz
) returns boolean
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer;
begin
  if nullif(btrim(p_provider_recording_id), '') is null or p_direct_call_id is null or p_now is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.direct_call_recordings
     set status = 'failed', error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'capture_failed'), 100),
         error_message = left(coalesce(p_error_message, 'recording_capture_failed'), 500),
         next_attempt_at = p_now + make_interval(secs => least(3600, 30 * power(2::numeric, least(attempt_count - 1, 6))::integer)),
         updated_at = p_now
   where provider_recording_id = p_provider_recording_id
     and direct_call_id = p_direct_call_id
     and status <> 'available';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- Copies the service-only ledger into the existing activity child table. The
-- conflict update is monotonic: an available activity row can be enriched, but
-- never overwritten by pending/failed state from a stale wrap-up or webhook.
create or replace function public.direct_call_recording_sync_activity(
  p_direct_call_id uuid,
  p_call_activity_id uuid,
  p_provider_recording_id text
) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_stage public.direct_call_recordings%rowtype;
begin
  if p_direct_call_id is null or p_call_activity_id is null or nullif(btrim(p_provider_recording_id), '') is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_stage
    from public.direct_call_recordings
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
  )
  on conflict (provider_recording_id) do update set
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

revoke all on function public.direct_call_recording_claim(uuid,text,text,text,text,timestamptz,integer,integer) from public, anon, authenticated;
grant execute on function public.direct_call_recording_claim(uuid,text,text,text,text,timestamptz,integer,integer) to service_role;
revoke all on function public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz) to service_role;
revoke all on function public.direct_call_recording_mark_failed(text,uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.direct_call_recording_mark_failed(text,uuid,text,text,timestamptz) to service_role;
revoke all on function public.direct_call_recording_sync_activity(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.direct_call_recording_sync_activity(uuid,uuid,text) to service_role;

commit;
