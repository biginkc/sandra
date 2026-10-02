-- Track the activity-link repair separately from provider capture retries.
-- Follows 20261002011737_direct_recording_monotonic_retry.sql.
begin;

alter table public.direct_call_recordings
  add column if not exists link_attempt_count integer not null default 0,
  add column if not exists link_next_attempt_at timestamptz,
  add column if not exists linked_at timestamptz;

alter table public.direct_call_recordings
  drop constraint if exists direct_call_recordings_link_attempt_count_check;
alter table public.direct_call_recordings
  add constraint direct_call_recordings_link_attempt_count_check check (link_attempt_count between 0 and 100);

-- Backfill rows that already have a durable activity child. Remaining
-- available rows get one bounded repair opportunity; the sync function applies
-- capped backoff when wrap-up has not created the activity yet.
update public.direct_call_recordings d
   set linked_at = coalesce(d.updated_at, now()), link_next_attempt_at = null
 where d.status = 'available'
   and d.storage_path is not null
   and d.linked_at is null
   and exists (
     select 1
       from public.call_activities a
       join public.call_recordings r on r.call_activity_id = a.id
                                     and r.provider_recording_id = d.provider_recording_id
      where a.direct_call_id = d.direct_call_id
   );

update public.direct_call_recordings
   set link_next_attempt_at = coalesce(link_next_attempt_at, now())
 where status = 'available'
   and storage_path is not null
   and linked_at is null;

create index if not exists direct_call_recordings_link_retry_idx
  on public.direct_call_recordings (link_next_attempt_at, updated_at)
  where status = 'available' and linked_at is null and link_attempt_count < 8;

-- Replace the three-argument helper with a nullable activity id. A null id is
-- a durable "not linked yet" observation from the webhook; it gets capped
-- backoff instead of being scanned on every cron invocation. A wrap-up passes
-- the activity id and repairs the row immediately, regardless of backoff.
drop function if exists public.direct_call_recording_sync_activity(uuid, uuid, text);
create or replace function public.direct_call_recording_sync_activity(
  p_direct_call_id uuid,
  p_call_activity_id uuid,
  p_provider_recording_id text,
  p_now timestamptz
) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_stage public.direct_call_recordings%rowtype;
  v_has_activity boolean;
  v_next_attempt integer;
begin
  if p_direct_call_id is null or nullif(btrim(p_provider_recording_id), '') is null or p_now is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_stage
    from public.direct_call_recordings
   where direct_call_id = p_direct_call_id and provider_recording_id = p_provider_recording_id
   for update;
  if not found then return; end if;

  v_has_activity := p_call_activity_id is not null and exists (
    select 1 from public.call_activities
     where id = p_call_activity_id and direct_call_id = p_direct_call_id
  );
  if not v_has_activity then
    v_next_attempt := least(v_stage.link_attempt_count + 1, 100);
    update public.direct_call_recordings
       set link_attempt_count = v_next_attempt,
           link_next_attempt_at = case when v_next_attempt >= 8 then null
             else p_now + make_interval(secs => least(900, 30 * power(2::numeric, least(v_next_attempt - 1, 5))::integer)) end,
           updated_at = p_now
     where id = v_stage.id;
    return;
  end if;

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

  update public.direct_call_recordings
     set linked_at = case when v_stage.status = 'available' then p_now else null end,
         link_next_attempt_at = case when v_stage.status = 'available' then null else link_next_attempt_at end,
         link_attempt_count = case when v_stage.status = 'available'
           then least(link_attempt_count + 1, 100) else link_attempt_count end,
         updated_at = p_now
   where id = v_stage.id;
end;
$$;

-- A repeated saved event must preserve a repaired link. A row that has not
-- linked yet is scheduled for bounded activity reconciliation.
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
         next_attempt_at = null,
         linked_at = case when status = 'available' then linked_at else null end,
         link_next_attempt_at = case when status = 'available' and linked_at is not null then null else p_now end,
         updated_at = p_now
   where provider_recording_id = p_provider_recording_id
     and direct_call_id = p_direct_call_id;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.direct_call_recording_sync_activity(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.direct_call_recording_sync_activity(uuid,uuid,text,timestamptz) to service_role;
revoke all on function public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.direct_call_recording_mark_available(text,uuid,text,text,integer,timestamptz) to service_role;

commit;
