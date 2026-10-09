-- Dialpad call audio v1: Sandra keeps its own copy of the Dialpad admin call recording (MP3).
--
-- Schema, functions, an enqueue trigger and one private Storage bucket. NO data step: nothing is backfilled,
-- no existing row is touched, and the worker singleton row is created by the first lease take (no seed).
-- Inert at deploy: every flag below defaults OFF, the canary list is empty, and the cron route only reaches
-- Dialpad when a flag is turned on for an org. The artifact sweep (dialpad_call_artifact_fetches and its
-- functions) is not touched.
--
-- Objects (all service role only: RLS on, no policies, anon/authenticated revoked):
--   my_leads_feature_flags.recording_download / recording_download_canary_call_ids / audio_consumers
--   dialpad_call_audio            one row per call: discovery, stability, download and upload state
--   dialpad_share_link_attempts   one row per share-link POST, never overwritten; blocks a new POST while unresolved
--   dialpad_recording_worker      singleton lease row (advisory-lock semantics; cron code has no direct Postgres session)
--   dialpad_audio_access_log      one row per machine (Jev / coach) authorization
--   bucket dialpad-call-audio     private, 32 MB, audio/mpeg only, no storage.objects policies
begin;

-- Flags. A missing row or column reads as OFF (the queue function checks them in SQL).
alter table public.my_leads_feature_flags
  add column recording_download boolean not null default false,
  add column recording_download_canary_call_ids text[] not null default '{}',
  add column audio_consumers text[] not null default '{}',
  add constraint my_leads_feature_flags_audio_consumers_check
    check (audio_consumers <@ array['jev', 'coach_review']::text[]);

-- Deterministic object path. The only path an audio row may carry.
create or replace function public.dialpad_call_audio_path(p_org_id uuid, p_call_activity_id uuid, p_recording_id text)
returns text language sql immutable set search_path = '' as $$
  select p_org_id::text || '/' || p_call_activity_id::text || '/' || p_recording_id || '.mp3'
$$;
revoke all on function public.dialpad_call_audio_path(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.dialpad_call_audio_path(uuid, uuid, text) to service_role;

create table public.dialpad_call_audio (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  call_activity_id uuid not null references public.call_activities(id) on delete cascade,
  connection_id uuid,
  company_id text check (company_id is null or company_id ~ '^[0-9]{1,20}$'),
  provider_call_id text not null check (provider_call_id ~ '^[0-9]{1,20}$'),
  state text not null default 'discovering' check (state in (
    'discovering', 'discovered', 'uploading', 'stored',
    'none_found', 'multi_segment_unsupported', 'denied', 'too_large', 'invalid_media', 'decode_timeout', 'unavailable')),
  ended_at timestamptz not null,
  deadline_at timestamptz not null,
  next_attempt_at timestamptz not null,
  attempts smallint not null default 0 check (attempts between 0 and 100),
  seen_recording_id text check (seen_recording_id is null or seen_recording_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  seen_duration_ms bigint check (seen_duration_ms is null or seen_duration_ms > 0),
  seen_at timestamptz,
  provider_recording_id text check (provider_recording_id is null or provider_recording_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  provider_duration_ms bigint check (provider_duration_ms is null or provider_duration_ms > 0),
  denied_key_fp text check (denied_key_fp is null or denied_key_fp ~ '^[0-9a-f]{16}$'),
  storage_path text,
  size_bytes bigint check (size_bytes is null or size_bytes > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  decoded_ms bigint check (decoded_ms is null or decoded_ms >= 0),
  upload_expected_sha256 text check (upload_expected_sha256 is null or upload_expected_sha256 ~ '^[0-9a-f]{64}$'),
  upload_expected_size bigint check (upload_expected_size is null or upload_expected_size > 0),
  stored_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 64),
  -- A hostname only (never a path or query): the redirect host Dialpad sent that the allowlist refused.
  warning text check (warning is null or (length(warning) <= 200 and warning ~ '^[A-Za-z0-9.-]+$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_activity_id),
  unique (id, org_id),
  foreign key (connection_id, org_id) references public.dialpad_org_connections(id, org_id),
  check (storage_path is null or (provider_recording_id is not null
    and storage_path = public.dialpad_call_audio_path(org_id, call_activity_id, provider_recording_id))),
  check (state <> 'stored' or (storage_path is not null and size_bytes is not null and sha256 is not null and stored_at is not null)),
  check (state <> 'uploading' or (upload_expected_sha256 is not null and upload_expected_size is not null and storage_path is not null))
);
create index dialpad_call_audio_due_idx on public.dialpad_call_audio (next_attempt_at) where state in ('discovering', 'discovered');
create index dialpad_call_audio_uploading_idx on public.dialpad_call_audio (updated_at) where state = 'uploading';
create index dialpad_call_audio_denied_idx on public.dialpad_call_audio (org_id) where state = 'denied';
alter table public.dialpad_call_audio enable row level security;
revoke all on table public.dialpad_call_audio from public, anon, authenticated, service_role;
grant select on table public.dialpad_call_audio to service_role;

create table public.dialpad_share_link_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  audio_id uuid not null references public.dialpad_call_audio(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  company_id text,
  provider_call_id text not null,
  provider_recording_id text not null,
  holder uuid not null,
  state text not null default 'requested' check (state in (
    'requested', 'live', 'downloaded', 'deleted', 'not_sent', 'not_created', 'ambiguous', 'resolved_by_owner')),
  -- An identity mismatch is `ambiguous` with a reason, so it stays inside the blocking index below.
  reason text check (reason in ('unknown_outcome', 'mismatch', 'post_mismatch')),
  share_link_id text check (share_link_id is null or share_link_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  item_id text check (item_id is null or item_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_by_id text check (created_by_id is null or created_by_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  call_id text check (call_id is null or call_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_note text check (resolved_note is null or length(resolved_note) between 1 and 500),
  check (state <> 'ambiguous' or reason is not null),
  check (state not in ('live', 'downloaded') or (share_link_id is not null and item_id is not null
    and created_by_id is not null and call_id is not null)),
  check (state <> 'resolved_by_owner' or (resolved_at is not null and resolved_note is not null))
);
-- At most one unresolved link per recording: a new POST is impossible while any link is unresolved.
create unique index dialpad_share_link_attempts_unresolved_idx on public.dialpad_share_link_attempts (audio_id)
  where state in ('requested', 'live', 'downloaded', 'ambiguous');
create index dialpad_share_link_attempts_cleanup_idx on public.dialpad_share_link_attempts (updated_at)
  where state in ('live', 'downloaded');
alter table public.dialpad_share_link_attempts enable row level security;
revoke all on table public.dialpad_share_link_attempts from public, anon, authenticated, service_role;
grant select on table public.dialpad_share_link_attempts to service_role;

create table public.dialpad_recording_worker (
  id smallint primary key check (id = 1),
  holder uuid,
  until timestamptz not null default 'epoch',
  last_request_at timestamptz,
  last_call_get_at timestamptz,
  recording_blocked_until timestamptz
);
alter table public.dialpad_recording_worker enable row level security;
revoke all on table public.dialpad_recording_worker from public, anon, authenticated, service_role;
grant select on table public.dialpad_recording_worker to service_role;

create table public.dialpad_audio_access_log (
  id bigint generated always as identity primary key,
  consumer text not null check (consumer in ('jev', 'coach_review')),
  org_id uuid not null references public.organizations(id) on delete cascade,
  call_activity_id uuid not null references public.call_activities(id) on delete cascade,
  audio_id uuid not null references public.dialpad_call_audio(id) on delete cascade,
  at timestamptz not null default now()
);
create index dialpad_audio_access_log_org_idx on public.dialpad_audio_access_log (org_id, at desc);
alter table public.dialpad_audio_access_log enable row level security;
revoke all on table public.dialpad_audio_access_log from public, anon, authenticated, service_role;
grant select on table public.dialpad_audio_access_log to service_role;

-- Private bucket, service role only (no storage.objects policies). 32 MB, audio/mpeg only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dialpad-call-audio', 'dialpad-call-audio', false, 33554432, array['audio/mpeg']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Enqueue by trigger on the call activity. Same predicates as the artifact trigger (provider dialpad, ended,
-- customer purpose, connected or talk > 0), plus a digits check so a malformed provider id can never break the
-- call projection. No direction filter (inbound and outbound are both stored). No backfill.
create or replace function public.dialpad_call_audio_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dialpad_call_audio (org_id, call_activity_id, connection_id, company_id, provider_call_id,
                                         ended_at, deadline_at, next_attempt_at)
  select new.org_id, new.id, k.id, k.dialpad_company_id, new.provider_call_id,
         new.ended_at, new.ended_at + interval '24 hours', new.ended_at + interval '5 minutes'
  from (select 1) as one
  left join public.dialpad_org_connections k on k.org_id = new.org_id
  on conflict (call_activity_id) do nothing;
  return new;
end $$;
revoke all on function public.dialpad_call_audio_enqueue() from public, anon, authenticated, service_role;

create trigger dialpad_call_audio_enqueue_trg
  after insert or update of ended_at, talk_duration_seconds, outcome, provider_call_id, provider on public.call_activities
  for each row
  when (new.provider = 'dialpad' and new.ended_at is not null and new.provider_call_id ~ '^[0-9]{1,20}$'
        and new.call_purpose = 'customer'
        and (new.outcome in ('unknown', 'connected_human') or coalesce(new.talk_duration_seconds, 0) > 0))
  execute function public.dialpad_call_audio_enqueue();

-- Internal guard: the caller must be the live singleton holder. Not granted to anyone.
create or replace function public.dpa_assert_holder(p_holder uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_holder is null or not exists (
    select 1 from public.dialpad_recording_worker w where w.id = 1 and w.holder = p_holder and w.until > now()) then
    raise exception 'NOT_HOLDER' using errcode = '42501';
  end if;
end $$;
revoke all on function public.dpa_assert_holder(uuid) from public, anon, authenticated, service_role;

-- Singleton take: one atomic upsert. The seeded row is not required; an empty table works the same way.
-- Lease 90 s > the route's 60 s maxDuration, so a takeover only happens after the holder is dead.
create or replace function public.fn_dpa_worker_take(p_holder uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_recording_worker%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_holder is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  insert into public.dialpad_recording_worker as w (id, holder, until)
  values (1, p_holder, now() + interval '90 seconds')
  on conflict (id) do update set holder = excluded.holder, until = excluded.until
    where w.until < now()
  returning w.* into v;
  if not found then return jsonb_build_object('taken', false); end if;
  return jsonb_build_object('taken', true,
    'lastRequestAt', v.last_request_at, 'lastCallGetAt', v.last_call_get_at, 'blockedUntil', v.recording_blocked_until);
end $$;
revoke all on function public.fn_dpa_worker_take(uuid) from public, anon, authenticated;
grant execute on function public.fn_dpa_worker_take(uuid) to service_role;

create or replace function public.fn_dpa_worker_release(p_holder uuid, p_last_request_at timestamptz, p_last_call_get_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.dialpad_recording_worker w
    set until = now(),
        last_request_at = greatest(w.last_request_at, p_last_request_at),
        last_call_get_at = greatest(w.last_call_get_at, p_last_call_get_at)
    where w.id = 1 and w.holder = p_holder;
end $$;
revoke all on function public.fn_dpa_worker_release(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_dpa_worker_release(uuid, timestamptz, timestamptz) to service_role;

create or replace function public.fn_dpa_worker_block(p_holder uuid, p_until timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.dpa_assert_holder(p_holder);
  update public.dialpad_recording_worker w
    set recording_blocked_until = greatest(w.recording_blocked_until, p_until)
    where w.id = 1;
end $$;
revoke all on function public.fn_dpa_worker_block(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.fn_dpa_worker_block(uuid, timestamptz) to service_role;

-- The tick's whole queue read. Housekeeping first (a dead holder's `requested` POST becomes ambiguous, expired
-- rows end without a request), then: share-link cleanup set, ambiguous links to report, uploaded-but-unregistered
-- rows, at most one row ready to download, due discovery rows, and orgs with denied rows (credential repair).
-- Cleanup and upload recovery ignore flags; download and discovery require the org flag (and the canary list).
create or replace function public.fn_dpa_queue(p_holder uuid, p_discovery_limit integer default 4) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cleanup jsonb;
  v_ambiguous jsonb;
  v_uploading jsonb;
  v_download jsonb;
  v_discovery jsonb;
  v_denied jsonb;
begin
  perform public.dpa_assert_holder(p_holder);
  if p_discovery_limit not between 0 and 20 then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;

  update public.dialpad_share_link_attempts
    set state = 'ambiguous', reason = 'unknown_outcome', updated_at = now()
    where state = 'requested' and holder <> p_holder;

  update public.dialpad_call_audio a
    set connection_id = k.id, company_id = k.dialpad_company_id, updated_at = now()
    from public.dialpad_org_connections k
    where a.connection_id is null and k.org_id = a.org_id and a.state in ('discovering', 'discovered');

  update public.dialpad_call_audio
    set state = case when seen_recording_id is null then 'none_found' else 'unavailable' end,
        last_error = 'deadline', updated_at = now()
    where state in ('discovering', 'discovered') and deadline_at < now();

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'audioId', t.audio_id, 'orgId', t.org_id, 'state', t.state,
      'shareLinkId', t.share_link_id, 'itemId', t.item_id, 'createdById', t.created_by_id, 'callId', t.call_id,
      'keyRef', (select k.directory_api_key_ref from public.dialpad_org_connections k where k.org_id = t.org_id))
      order by t.updated_at, t.id), '[]'::jsonb) into v_cleanup
  from (select * from public.dialpad_share_link_attempts where state in ('live', 'downloaded')
        order by updated_at, id limit 5) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'audioId', t.audio_id, 'reason', t.reason,
      'shareLinkId', t.share_link_id) order by t.updated_at, t.id), '[]'::jsonb) into v_ambiguous
  from (select * from public.dialpad_share_link_attempts where state = 'ambiguous' order by updated_at, id limit 20) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'orgId', u.org_id, 'callActivityId', u.call_activity_id,
      'providerRecordingId', u.provider_recording_id, 'storagePath', u.storage_path,
      'expectedSha256', u.upload_expected_sha256, 'expectedSize', u.upload_expected_size,
      'providerDurationMs', u.provider_duration_ms) order by u.updated_at, u.id), '[]'::jsonb) into v_uploading
  from (select * from public.dialpad_call_audio where state = 'uploading' order by updated_at, id limit 3) u;

  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'orgId', d.org_id, 'callActivityId', d.call_activity_id,
      'providerCallId', d.provider_call_id, 'providerRecordingId', d.provider_recording_id,
      'providerDurationMs', d.provider_duration_ms, 'keyRef', d.key_ref)), '[]'::jsonb) -> 0 into v_download
  from (
    select a.*, k.directory_api_key_ref as key_ref from public.dialpad_call_audio a
    join public.dialpad_org_connections k on k.id = a.connection_id and k.org_id = a.org_id and k.status = 'active'
    join public.my_leads_feature_flags g on g.org_id = a.org_id and g.recording_download
      and (cardinality(g.recording_download_canary_call_ids) = 0 or a.provider_call_id = any (g.recording_download_canary_call_ids))
    where a.state = 'discovered' and a.next_attempt_at <= now()
      and not exists (select 1 from public.dialpad_share_link_attempts t where t.audio_id = a.id
                        and t.state in ('requested', 'live', 'downloaded', 'ambiguous'))
    order by a.next_attempt_at, a.id limit 1) d;

  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'orgId', d.org_id, 'providerCallId', d.provider_call_id,
      'endedAt', d.ended_at, 'attempts', d.attempts, 'keyRef', d.key_ref) order by d.next_attempt_at, d.id), '[]'::jsonb) into v_discovery
  from (
    select a.*, k.directory_api_key_ref as key_ref from public.dialpad_call_audio a
    join public.dialpad_org_connections k on k.id = a.connection_id and k.org_id = a.org_id and k.status = 'active'
    join public.my_leads_feature_flags g on g.org_id = a.org_id and g.recording_download
      and (cardinality(g.recording_download_canary_call_ids) = 0 or a.provider_call_id = any (g.recording_download_canary_call_ids))
    where a.state = 'discovering' and a.next_attempt_at <= now()
    order by a.next_attempt_at, a.id limit p_discovery_limit) d;

  select coalesce(jsonb_agg(jsonb_build_object('orgId', d.org_id, 'keyRef', k.directory_api_key_ref) order by d.org_id), '[]'::jsonb) into v_denied
  from (select distinct a.org_id from public.dialpad_call_audio a where a.state = 'denied') d
  left join public.dialpad_org_connections k on k.org_id = d.org_id;

  return jsonb_build_object('cleanup', v_cleanup, 'ambiguous', v_ambiguous, 'uploading', v_uploading,
    'download', v_download, 'discovery', v_discovery, 'deniedOrgs', v_denied);
end $$;
revoke all on function public.fn_dpa_queue(uuid, integer) from public, anon, authenticated;
grant execute on function public.fn_dpa_queue(uuid, integer) to service_role;

-- Discovery result: one call GET. Stability rule: download only when two GETs at least 10 minutes apart returned
-- the same single admin recording id and duration.
create or replace function public.fn_dpa_discovery_result(
  p_holder uuid, p_audio_id uuid, p_outcome text,
  p_recording_id text default null, p_duration_ms bigint default null,
  p_key_fp text default null, p_error text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_call_audio%rowtype;
  v_offsets constant interval[] := array[interval '5 minutes', interval '15 minutes', interval '1 hour',
    interval '4 hours', interval '12 hours', interval '23 hours'];
  v_attempts smallint;
  v_seen_id text;
  v_seen_dur bigint;
  v_seen_at timestamptz;
  v_next timestamptz;
begin
  perform public.dpa_assert_holder(p_holder);
  if p_outcome not in ('not_ready', 'multi', 'one', 'denied', 'error', 'rate_limited') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v from public.dialpad_call_audio where id = p_audio_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state <> 'discovering' then
    return jsonb_build_object('state', v.state, 'replayed', true);
  end if;

  if p_outcome = 'rate_limited' then
    update public.dialpad_call_audio set next_attempt_at = now() + interval '1 minute', updated_at = now() where id = v.id;
    return jsonb_build_object('state', 'discovering', 'attempts', v.attempts);
  end if;
  if p_outcome = 'multi' then
    update public.dialpad_call_audio set state = 'multi_segment_unsupported', last_error = 'multi_segment', updated_at = now() where id = v.id;
    return jsonb_build_object('state', 'multi_segment_unsupported');
  end if;
  if p_outcome = 'denied' then
    update public.dialpad_call_audio
      set state = 'denied', denied_key_fp = p_key_fp, last_error = left(coalesce(p_error, 'denied'), 64), updated_at = now()
      where id = v.id;
    return jsonb_build_object('state', 'denied');
  end if;

  v_attempts := least(v.attempts + 1, 100);
  v_seen_id := v.seen_recording_id; v_seen_dur := v.seen_duration_ms; v_seen_at := v.seen_at;
  if p_outcome = 'one' then
    if p_recording_id is null or p_duration_ms is null or p_duration_ms <= 0 then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    if v.seen_recording_id = p_recording_id and v.seen_duration_ms = p_duration_ms and v.seen_at is not null then
      if v.seen_at <= now() - interval '10 minutes' then
        update public.dialpad_call_audio
          set state = 'discovered', provider_recording_id = p_recording_id, provider_duration_ms = p_duration_ms,
              attempts = 0, next_attempt_at = now(), last_error = null, updated_at = now()
          where id = v.id;
        return jsonb_build_object('state', 'discovered');
      end if;
    else
      v_seen_id := p_recording_id; v_seen_dur := p_duration_ms; v_seen_at := now();
    end if;
  end if;

  -- not_ready, error, or a first / unstable sighting: counted, scheduled on the discovery curve, and never
  -- earlier than 10 minutes after the sighting being confirmed.
  v_next := case when v_attempts + 1 <= 6 then v.ended_at + v_offsets[v_attempts + 1] else now() + interval '1 hour' end;
  v_next := greatest(v_next, now() + interval '1 minute');
  if v_seen_at is not null then v_next := greatest(v_next, v_seen_at + interval '10 minutes'); end if;
  update public.dialpad_call_audio
    set attempts = v_attempts, seen_recording_id = v_seen_id, seen_duration_ms = v_seen_dur, seen_at = v_seen_at,
        next_attempt_at = v_next, last_error = case when p_outcome = 'error' then left(coalesce(p_error, 'error'), 64) else null end,
        updated_at = now()
    where id = v.id;
  return jsonb_build_object('state', 'discovering', 'attempts', v_attempts);
end $$;
revoke all on function public.fn_dpa_discovery_result(uuid, uuid, text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.fn_dpa_discovery_result(uuid, uuid, text, text, bigint, text, text) to service_role;

-- Credential repair: a rotated key (different fingerprint of the key VALUE) requeues denied rows within 30 days.
create or replace function public.fn_dpa_requeue_denied(p_holder uuid, p_org_id uuid, p_key_fp text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform public.dpa_assert_holder(p_holder);
  if p_key_fp is null or p_key_fp !~ '^[0-9a-f]{16}$' then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  update public.dialpad_call_audio
    set state = 'discovering', attempts = 0, deadline_at = now() + interval '24 hours', next_attempt_at = now(),
        denied_key_fp = null, seen_recording_id = null, seen_duration_ms = null, seen_at = null,
        last_error = null, updated_at = now()
    where org_id = p_org_id and state = 'denied' and denied_key_fp is distinct from p_key_fp
      and ended_at > now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.fn_dpa_requeue_denied(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_dpa_requeue_denied(uuid, uuid, text) to service_role;

-- Share-link attempt row, inserted BEFORE the POST. The unresolved index rejects it while a link is unresolved.
create or replace function public.fn_dpa_attempt_begin(p_holder uuid, p_audio_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_call_audio%rowtype;
  v_id uuid;
begin
  perform public.dpa_assert_holder(p_holder);
  select * into v from public.dialpad_call_audio where id = p_audio_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state <> 'discovered' or v.provider_recording_id is null then
    raise exception 'NOT_DISCOVERED' using errcode = '22023';
  end if;
  begin
    insert into public.dialpad_share_link_attempts (audio_id, org_id, company_id, provider_call_id, provider_recording_id, holder)
    values (v.id, v.org_id, v.company_id, v.provider_call_id, v.provider_recording_id, p_holder)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('blocked', true);
  end;
  return jsonb_build_object('blocked', false, 'attemptId', v_id);
end $$;
revoke all on function public.fn_dpa_attempt_begin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_dpa_attempt_begin(uuid, uuid) to service_role;

-- Validated attempt transitions. A mismatch is `ambiguous`/`mismatch` (or `post_mismatch`), never deleted, and it
-- leaves the row inside the unresolved index until the owner resolves it.
create or replace function public.fn_dpa_attempt_set(
  p_holder uuid, p_attempt_id uuid, p_to text, p_reason text default null,
  p_share_link_id text default null, p_item_id text default null, p_created_by_id text default null, p_call_id text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_share_link_attempts%rowtype;
  v_ok boolean;
begin
  perform public.dpa_assert_holder(p_holder);
  select * into v from public.dialpad_share_link_attempts where id = p_attempt_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state = p_to and p_to in ('deleted', 'downloaded', 'live') then
    return jsonb_build_object('state', v.state, 'replayed', true);
  end if;
  v_ok := case v.state
    when 'requested' then p_to in ('not_sent', 'not_created', 'live', 'ambiguous')
    when 'live' then p_to in ('downloaded', 'deleted', 'ambiguous')
    when 'downloaded' then p_to in ('deleted', 'ambiguous')
    else false end;
  if not v_ok then raise exception 'INVALID_TRANSITION' using errcode = '22023'; end if;
  if p_to = 'ambiguous' and coalesce(p_reason, '') not in ('unknown_outcome', 'mismatch', 'post_mismatch') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_to = 'ambiguous' and v.state = 'requested' then
    update public.dialpad_share_link_attempts
      set state = 'ambiguous', reason = p_reason, share_link_id = coalesce(p_share_link_id, share_link_id),
          item_id = coalesce(p_item_id, item_id), created_by_id = coalesce(p_created_by_id, created_by_id),
          call_id = coalesce(p_call_id, call_id), updated_at = now()
      where id = v.id;
  elsif p_to = 'live' then
    update public.dialpad_share_link_attempts
      set state = 'live', share_link_id = p_share_link_id, item_id = p_item_id, created_by_id = p_created_by_id,
          call_id = p_call_id, updated_at = now()
      where id = v.id;
  elsif p_to = 'ambiguous' then
    update public.dialpad_share_link_attempts set state = 'ambiguous', reason = p_reason, updated_at = now() where id = v.id;
  else
    update public.dialpad_share_link_attempts set state = p_to, updated_at = now() where id = v.id;
  end if;
  return jsonb_build_object('state', p_to);
end $$;
revoke all on function public.fn_dpa_attempt_set(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_dpa_attempt_set(uuid, uuid, text, text, text, text, text, text) to service_role;

-- Owner resolution of an ambiguous link (the only way out of `ambiguous`). Service role only; needs a note.
create or replace function public.fn_dpa_resolve_ambiguous(p_attempt_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_share_link_attempts%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_note is null or length(btrim(p_note)) not between 1 and 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v from public.dialpad_share_link_attempts where id = p_attempt_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state <> 'ambiguous' then
    return jsonb_build_object('state', v.state, 'replayed', true);
  end if;
  update public.dialpad_share_link_attempts
    set state = 'resolved_by_owner', resolved_at = now(), resolved_note = btrim(p_note), updated_at = now()
    where id = v.id;
  return jsonb_build_object('state', 'resolved_by_owner');
end $$;
revoke all on function public.fn_dpa_resolve_ambiguous(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_dpa_resolve_ambiguous(uuid, text) to service_role;

-- Failure of the audio itself (never of the link; deleting a link never changes the audio row).
--   error: counted, back to `discovered` with a backoff, `unavailable` after 6        rate_limited: not counted
--   invalid_media: counted, terminal after 3                       too_large / decode_timeout / denied: terminal
--   recovery_reset: an `uploading` row whose object is missing or does not match; counted, back to `discovered`
create or replace function public.fn_dpa_audio_fail(
  p_holder uuid, p_audio_id uuid, p_kind text, p_error text default null, p_key_fp text default null,
  p_warning text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_call_audio%rowtype;
  v_attempts smallint;
begin
  perform public.dpa_assert_holder(p_holder);
  if p_kind not in ('error', 'rate_limited', 'invalid_media', 'too_large', 'decode_timeout', 'denied', 'recovery_reset') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v from public.dialpad_call_audio where id = p_audio_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state not in ('discovered', 'uploading') or (p_kind = 'recovery_reset' and v.state <> 'uploading') then
    return jsonb_build_object('state', v.state, 'replayed', true);
  end if;

  if p_warning is not null then
    update public.dialpad_call_audio set warning = left(p_warning, 200) where id = v.id;
  end if;

  if p_kind = 'rate_limited' then
    update public.dialpad_call_audio set state = 'discovered', next_attempt_at = now() + interval '1 minute',
      upload_expected_sha256 = null, upload_expected_size = null, storage_path = null, updated_at = now() where id = v.id;
    return jsonb_build_object('state', 'discovered', 'attempts', v.attempts);
  end if;
  if p_kind in ('too_large', 'decode_timeout', 'denied') then
    update public.dialpad_call_audio
      set state = p_kind, last_error = left(coalesce(p_error, p_kind), 64), denied_key_fp = case when p_kind = 'denied' then p_key_fp end,
          upload_expected_sha256 = null, upload_expected_size = null, storage_path = null, updated_at = now()
      where id = v.id;
    return jsonb_build_object('state', p_kind);
  end if;

  v_attempts := least(v.attempts + 1, 100);
  if v_attempts >= 6 or (p_kind = 'invalid_media' and v_attempts >= 3) then
    update public.dialpad_call_audio
      set state = case when p_kind = 'invalid_media' then 'invalid_media' else 'unavailable' end, attempts = v_attempts,
          last_error = left(coalesce(p_error, p_kind), 64),
          upload_expected_sha256 = null, upload_expected_size = null, storage_path = null, updated_at = now()
      where id = v.id;
    return jsonb_build_object('state', case when p_kind = 'invalid_media' then 'invalid_media' else 'unavailable' end, 'attempts', v_attempts);
  end if;
  update public.dialpad_call_audio
    set state = 'discovered', attempts = v_attempts, next_attempt_at = now() + make_interval(mins => least(v_attempts * 10, 120)),
        last_error = left(coalesce(p_error, p_kind), 64),
        upload_expected_sha256 = null, upload_expected_size = null, storage_path = null, updated_at = now()
    where id = v.id;
  return jsonb_build_object('state', 'discovered', 'attempts', v_attempts);
end $$;
revoke all on function public.fn_dpa_audio_fail(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_dpa_audio_fail(uuid, uuid, text, text, text, text) to service_role;

-- Before the upload: record what the object must be, so a crash after the upload is recoverable without Dialpad.
create or replace function public.fn_dpa_mark_uploading(p_holder uuid, p_audio_id uuid, p_sha256 text, p_size bigint, p_decoded_ms bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_call_audio%rowtype;
begin
  perform public.dpa_assert_holder(p_holder);
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size not between 1 and 33554432
     or p_decoded_ms is null or p_decoded_ms < 0 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v from public.dialpad_call_audio where id = p_audio_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state = 'uploading' and v.upload_expected_sha256 = p_sha256 then
    return jsonb_build_object('state', 'uploading', 'path', v.storage_path, 'replayed', true);
  end if;
  if v.state <> 'discovered' or v.provider_recording_id is null then
    raise exception 'INVALID_TRANSITION' using errcode = '22023';
  end if;
  update public.dialpad_call_audio
    set state = 'uploading', upload_expected_sha256 = p_sha256, upload_expected_size = p_size, decoded_ms = p_decoded_ms,
        storage_path = public.dialpad_call_audio_path(v.org_id, v.call_activity_id, v.provider_recording_id), updated_at = now()
    where id = v.id
    returning storage_path into v.storage_path;
  return jsonb_build_object('state', 'uploading', 'path', v.storage_path);
end $$;
revoke all on function public.fn_dpa_mark_uploading(uuid, uuid, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.fn_dpa_mark_uploading(uuid, uuid, text, bigint, bigint) to service_role;

create or replace function public.fn_dpa_register_stored(p_holder uuid, p_audio_id uuid, p_path text, p_size bigint, p_sha256 text, p_decoded_ms bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_call_audio%rowtype;
begin
  perform public.dpa_assert_holder(p_holder);
  select * into v from public.dialpad_call_audio where id = p_audio_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state = 'stored' and v.sha256 = p_sha256 then
    return jsonb_build_object('state', 'stored', 'replayed', true);
  end if;
  if v.state <> 'uploading' or v.upload_expected_sha256 is distinct from p_sha256 or v.upload_expected_size is distinct from p_size
     or v.storage_path is distinct from p_path
     or p_path <> public.dialpad_call_audio_path(v.org_id, v.call_activity_id, v.provider_recording_id) then
    raise exception 'REGISTER_MISMATCH' using errcode = '22023';
  end if;
  update public.dialpad_call_audio
    set state = 'stored', size_bytes = p_size, sha256 = p_sha256, decoded_ms = p_decoded_ms, stored_at = now(),
        last_error = null, updated_at = now()
    where id = v.id;
  return jsonb_build_object('state', 'stored');
end $$;
revoke all on function public.fn_dpa_register_stored(uuid, uuid, text, bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.fn_dpa_register_stored(uuid, uuid, text, bigint, text, bigint) to service_role;

-- Who can play it. People: owner (any direction) or the attributed rep (outbound, matched intent, own attempt).
-- Returns null when denied. The caller signs a 60 s URL only after this returns a value.
create or replace function public.fn_dialpad_audio_authorize(p_actor uuid, p_org_id uuid, p_call_activity_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text;
  v_acq boolean;
  v_row record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_actor is null or p_org_id is null or p_call_activity_id is null then return null; end if;
  select m.role, m.acquisitions_enabled into v_role, v_acq
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_actor and m.access_status = 'active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp());
  if not found then return null; end if;

  select a.id as audio_id, a.storage_path, a.sha256, a.decoded_ms, a.connection_id, a.provider_call_id,
         c.id as call_id, c.direction, c.operator_user_id
    into v_row
  from public.dialpad_call_audio a
  join public.call_activities c on c.id = a.call_activity_id and c.org_id = a.org_id
  join public.dialpad_org_connections k on k.id = a.connection_id and k.org_id = a.org_id
  where a.call_activity_id = p_call_activity_id and a.org_id = p_org_id and c.org_id = p_org_id and k.org_id = p_org_id
    and c.provider = 'dialpad' and c.call_purpose = 'customer' and c.provider_call_id = a.provider_call_id
    and a.state = 'stored' and a.provider_recording_id is not null
    and a.storage_path = public.dialpad_call_audio_path(a.org_id, a.call_activity_id, a.provider_recording_id);
  if not found then return null; end if;

  if v_role = 'owner' then
    return jsonb_build_object('audioId', v_row.audio_id, 'bucket', 'dialpad-call-audio', 'path', v_row.storage_path,
      'sha256', v_row.sha256, 'durationMs', v_row.decoded_ms, 'mode', 'owner');
  end if;

  if not coalesce(v_acq, false) or v_row.direction <> 'outbound' or v_row.operator_user_id is distinct from p_actor then
    return null;
  end if;
  if not exists (
    select 1 from public.dialpad_call_intents i
    where i.org_id = p_org_id and i.status = 'matched' and i.direction = 'outbound'
      and i.matched_provider_call_id = v_row.provider_call_id and i.rep_user_id = p_actor
      and i.connection_id = v_row.connection_id
      and not exists (select 1 from public.dialpad_call_events e where e.org_id = p_org_id
        and e.matched_intent_id = i.id and (e.disposition = 'conflict' or e.conflicts_with_event_id is not null)))
     or not exists (
    select 1 from public.acquisition_attempts t
    where t.org_id = p_org_id and t.call_activity_id = v_row.call_id and t.source = 'dialpad' and t.actor_user_id = p_actor) then
    return null;
  end if;
  return jsonb_build_object('audioId', v_row.audio_id, 'bucket', 'dialpad-call-audio', 'path', v_row.storage_path,
    'sha256', v_row.sha256, 'durationMs', v_row.decoded_ms, 'mode', 'rep');
end $$;
revoke all on function public.fn_dialpad_audio_authorize(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_dialpad_audio_authorize(uuid, uuid, uuid) to service_role;

-- Machines (Jev, coach): tenant-bound. The org must list the consumer; activity, audio row and connection must
-- all belong to p_org_id. Writes the access log. Returns null when denied.
create or replace function public.fn_dialpad_audio_for_service(p_org_id uuid, p_call_activity_id uuid, p_consumer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_org_id is null or p_call_activity_id is null or p_consumer is null or p_consumer not in ('jev', 'coach_review') then
    return null;
  end if;
  if not exists (select 1 from public.my_leads_feature_flags g where g.org_id = p_org_id and p_consumer = any (g.audio_consumers)) then
    return null;
  end if;
  select a.id as audio_id, a.storage_path, a.sha256, a.decoded_ms into v_row
  from public.dialpad_call_audio a
  join public.call_activities c on c.id = a.call_activity_id and c.org_id = a.org_id
  join public.dialpad_org_connections k on k.id = a.connection_id and k.org_id = a.org_id
  where a.call_activity_id = p_call_activity_id and a.org_id = p_org_id and c.org_id = p_org_id and k.org_id = p_org_id
    and c.provider = 'dialpad' and c.call_purpose = 'customer' and c.provider_call_id = a.provider_call_id
    and a.state = 'stored' and a.provider_recording_id is not null
    and a.storage_path = public.dialpad_call_audio_path(a.org_id, a.call_activity_id, a.provider_recording_id);
  if not found then return null; end if;
  insert into public.dialpad_audio_access_log (consumer, org_id, call_activity_id, audio_id)
  values (p_consumer, p_org_id, p_call_activity_id, v_row.audio_id);
  return jsonb_build_object('audioId', v_row.audio_id, 'id', 'dpa_' || v_row.audio_id::text, 'bucket', 'dialpad-call-audio',
    'path', v_row.storage_path, 'sha256', v_row.sha256, 'durationMs', v_row.decoded_ms);
end $$;
revoke all on function public.fn_dialpad_audio_for_service(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_dialpad_audio_for_service(uuid, uuid, text) to service_role;

commit;
