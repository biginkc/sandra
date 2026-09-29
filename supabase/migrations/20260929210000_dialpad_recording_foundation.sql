-- Dialpad CTI R1: private recording capture ledger, durable single-use ingest
-- grants, service-only capture/seal RPCs, private bucket, and a narrow
-- call_recordings write restriction for Dialpad rows.
--
-- Depends on A1 (20260929034021), A3 (20260929120000) and A2 (20260929180000).
--
--   * dialpad_recording_captures binds one capture to an immutable matched
--     intent, org, rep and call activity. Frozen at open; only lifecycle
--     columns move, forward only: open > closing > sealing > sealed | partial |
--     failed. A capture is 'sealed' only when BOTH tracks of epoch 1 carry
--     complete, ledger-verified evidence and no later epoch exists.
--   * dialpad_recording_segments / _chunks record the immutable chunk ledger
--     per (track, epoch). A later epoch is a separate segment; it is never
--     stitched into epoch 1 and can only make a capture 'partial'.
--   * dialpad_recording_track_finals hold the trusted per-track seal result.
--     completeness is a database-derived value (decode + EOF + contiguity), and
--     a CHECK forbids 'complete' without all three. A capture is sealed only
--     after the actual signed call end; a rep/service early stop stays partial.
--   * dialpad_recording_ingest_grants store only SHA-256 token hashes. A grant
--     is consumed atomically once, bound to capture and rep; an epoch can be
--     authorized at most once per capture.
--   * Every mutation is a service-role-only SECURITY DEFINER function. Storage
--     paths are derived here, never accepted from a caller.
--   * Closing starts a bounded operational drain window (30 seconds). A seal
--     claim is ready immediately only after both expected tracks have ledger
--     EOF and contiguous chunks for every consumed epoch; the deadline is a
--     crash/abandonment bound, never a measurement tolerance or completeness
--     assertion. Deadline claims remain partial unless the ledger proves the
--     complete signed call.
--
-- Capacity note: the bucket and final-object CHECKs allow 512 MiB per track
-- object. A 600 s sample remuxed to about 9.2 MiB (tab) and 5.6 MiB (mic)
-- extrapolates to roughly 165 MiB and 101 MiB for 10,800 s. That is arithmetic,
-- not proof; a three-hour call is not yet demonstrated. Supabase Storage also
-- caps any bucket at the project's global file size limit (Free 50 MB, Pro and
-- up to 500 GB), so the global limit must be raised to at least 512 MiB.

begin;

-- ----------------------------------------------------------------------------
-- Server-derived storage paths
-- ----------------------------------------------------------------------------

create or replace function public.dialpad_recording_capture_prefix(p_org uuid, p_capture uuid)
returns text language sql immutable set search_path = '' as $$
  select p_org::text || '/' || p_capture::text;
$$;

create or replace function public.dialpad_recording_chunk_path(p_org uuid, p_capture uuid, p_epoch integer, p_track text, p_seq integer)
returns text language sql immutable set search_path = '' as $$
  select p_org::text || '/' || p_capture::text || '/chunks/' || p_epoch::text || '/' || p_track || '/' || lpad(p_seq::text, 8, '0');
$$;

create or replace function public.dialpad_recording_final_path(p_org uuid, p_capture uuid, p_epoch integer, p_track text)
returns text language sql immutable set search_path = '' as $$
  select p_org::text || '/' || p_capture::text || '/final/' || p_epoch::text || '/' || p_track;
$$;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists public.dialpad_recording_captures (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  intent_id uuid not null,
  rep_user_id uuid not null references auth.users(id) on delete restrict,
  call_activity_id uuid not null references public.call_activities(id) on delete restrict,
  provider_call_id text not null check (provider_call_id ~ '^[0-9]{1,20}$'),
  status text not null default 'open' check (status in ('open', 'closing', 'sealing', 'sealed', 'partial', 'failed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text check (close_reason in ('rep_closed', 'call_ended', 'service_closed')),
  claim_token uuid,
  claimed_by text check (claimed_by is null or length(claimed_by) between 1 and 200),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  -- Operational MediaRecorder flush/drain deadline. This is intentionally
  -- separate from provider timing and never upgrades incomplete evidence.
  drain_deadline_at timestamptz,
  seal_attempts integer not null default 0 check (seal_attempts between 0 and 100),
  result_at timestamptz,
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_]{1,64}$'),
  -- Canonical submitted seal input, including a JSON null failureCode. This
  -- makes an explicit derived-looking failure distinct from omitted input and
  -- prevents terminal replay from masking a missing or duplicated track.
  result_identity jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('closing', 'sealing', 'sealed', 'partial') or (closed_at is not null and close_reason is not null and drain_deadline_at is not null)),
  check (status <> 'sealing' or (claim_token is not null and claimed_by is not null and claimed_at is not null and lease_expires_at is not null)),
  check (status not in ('sealed', 'partial', 'failed') or result_at is not null),
  check (status <> 'failed' or failure_code is not null),
  check (status <> 'sealed' or failure_code is null),
  unique (intent_id),
  unique (call_activity_id),
  unique (id, org_id),
  unique (id, org_id, rep_user_id),
  foreign key (intent_id, org_id) references public.dialpad_call_intents (id, org_id)
);

-- The R1 migration was unmerged while this repair was reviewed. Keep reruns
-- safe for a scratch database that already has the first candidate applied.
alter table public.dialpad_recording_captures
  add column if not exists drain_deadline_at timestamptz,
  add column if not exists result_identity jsonb;

create index if not exists dialpad_recording_captures_work_idx
  on public.dialpad_recording_captures (status, closed_at) where status in ('open', 'closing', 'sealing');

comment on table public.dialpad_recording_captures is
  'One private recording capture per matched Dialpad call. Org, rep, intent and call activity are frozen when the capture is opened; only lifecycle columns move, forward only. sealed requires both tracks of epoch 1 with complete decode/EOF/contiguity evidence, no later epoch, and the signed call end; a rep/service early stop is partial. Service role only.';

create table if not exists public.dialpad_recording_segments (
  capture_id uuid not null,
  org_id uuid not null,
  track text not null check (track in ('tab', 'mic')),
  epoch smallint not null check (epoch between 1 and 16),
  chunk_count integer not null default 0 check (chunk_count between 0 and 100000),
  total_bytes bigint not null default 0 check (total_bytes between 0 and 536870912),
  max_seq integer check (max_seq between 0 and 99999),
  eof_seq integer check (eof_seq between 0 and 99999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (capture_id, track, epoch),
  check (eof_seq is null or eof_seq = max_seq),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id)
);

comment on table public.dialpad_recording_segments is
  'Running per-(track, epoch) counters for the chunk ledger. Each epoch is its own segment; epochs are never stitched.';

create table if not exists public.dialpad_recording_chunks (
  capture_id uuid not null,
  org_id uuid not null,
  track text not null check (track in ('tab', 'mic')),
  epoch smallint not null check (epoch between 1 and 16),
  seq integer not null check (seq between 0 and 99999),
  size_bytes integer not null check (size_bytes between 1 and 1048576),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  is_eof boolean not null default false,
  storage_path text not null,
  recorded_at timestamptz not null default now(),
  primary key (capture_id, track, epoch, seq),
  check (storage_path = public.dialpad_recording_chunk_path(org_id, capture_id, epoch, track, seq)),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id),
  foreign key (capture_id, track, epoch) references public.dialpad_recording_segments (capture_id, track, epoch)
);

comment on table public.dialpad_recording_chunks is
  'Immutable chunk metadata (at most 1 MiB per chunk). Identity is (capture, track, epoch, seq); an exact replay is idempotent and a different size, hash or EOF flag under the same key is a conflict.';

create table if not exists public.dialpad_recording_track_finals (
  capture_id uuid not null,
  org_id uuid not null,
  track text not null check (track in ('tab', 'mic')),
  epoch smallint not null check (epoch between 1 and 16),
  completeness text not null check (completeness in ('complete', 'partial', 'unusable')),
  decode_ok boolean not null,
  eof_verified boolean not null,
  contiguous boolean not null,
  source_chunk_count integer not null check (source_chunk_count >= 1),
  source_bytes bigint not null check (source_bytes between 1 and 536870912),
  source_last_seq integer not null check (source_last_seq between 0 and 99999),
  storage_path text,
  size_bytes bigint check (size_bytes between 1 and 536870912),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  codec text check (codec ~ '^[a-z0-9_.-]{1,64}$'),
  sample_rate_hz integer check (sample_rate_hz between 8000 and 192000),
  channels smallint check (channels between 1 and 2),
  decoded_duration_ms integer check (decoded_duration_ms between 1 and 14400000),
  partial_reason text check (partial_reason in ('missing_eof', 'chunk_gap', 'missing_eof_and_gap')),
  registered_by text not null check (length(registered_by) between 1 and 200),
  registered_at timestamptz not null default now(),
  primary key (capture_id, track, epoch),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id),
  foreign key (capture_id, track, epoch) references public.dialpad_recording_segments (capture_id, track, epoch),
  check (completeness = case
    when not decode_ok then 'unusable'
    when eof_verified and contiguous then 'complete'
    else 'partial' end),
  check (completeness <> 'partial' or partial_reason is not null),
  check (completeness = 'partial' or partial_reason is null),
  check (decode_ok = (storage_path is not null and size_bytes is not null and sha256 is not null and codec is not null
                       and sample_rate_hz is not null and channels is not null and decoded_duration_ms is not null)),
  check (storage_path is null or storage_path = public.dialpad_recording_final_path(org_id, capture_id, epoch, track))
);

comment on table public.dialpad_recording_track_finals is
  'Trusted per-(track, epoch) seal result. completeness is derived in the database from the chunk ledger (EOF at the last sequence, contiguous sequences) plus decode evidence; complete is impossible without all three.';

create table if not exists public.dialpad_recording_ingest_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null,
  capture_id uuid not null,
  rep_user_id uuid not null,
  epoch smallint not null check (epoch between 1 and 16),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_by text check (consumed_by is null or length(consumed_by) between 1 and 200),
  check (expires_at > created_at and expires_at <= created_at + interval '5 minutes'),
  check ((consumed_at is null) = (consumed_by is null)),
  check (consumed_at is null or revoked_at is null),
  foreign key (capture_id, org_id, rep_user_id) references public.dialpad_recording_captures (id, org_id, rep_user_id)
);

create unique index if not exists dialpad_recording_ingest_grants_one_consumed_per_epoch
  on public.dialpad_recording_ingest_grants (capture_id, epoch) where consumed_at is not null;
create index if not exists dialpad_recording_ingest_grants_capture_idx
  on public.dialpad_recording_ingest_grants (capture_id, created_at);

comment on table public.dialpad_recording_ingest_grants is
  'Short-lived (at most five minutes), single-use ingest authorizations. Only the SHA-256 of the token is stored; the raw token never reaches the database or logs. Consumption is one atomic update bound to capture and rep, and an epoch can be authorized once.';

-- ----------------------------------------------------------------------------
-- Immutability and forward-only triggers (apply to every role)
-- ----------------------------------------------------------------------------

create or replace function public.dialpad_recording_guard_capture()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mutable constant text[] := array['status', 'closed_at', 'close_reason', 'claim_token', 'claimed_by', 'claimed_at',
                                     'lease_expires_at', 'drain_deadline_at', 'seal_attempts', 'result_at', 'failure_code',
                                     'result_identity', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad recording captures are immutable evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.closed_at is not null or new.close_reason is not null or new.claim_token is not null
       or new.claimed_by is not null or new.claimed_at is not null or new.lease_expires_at is not null
       or new.drain_deadline_at is not null or new.seal_attempts <> 0 or new.result_at is not null
       or new.failure_code is not null or new.result_identity is not null then
      raise exception 'a recording capture must be opened in the open state' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
    raise exception 'recording capture attribution is immutable' using errcode = '42501';
  end if;
  if old.status in ('sealed', 'partial', 'failed') then
    raise exception 'a % capture is terminal', old.status using errcode = '42501';
  end if;
  if old.status <> 'open' and new.drain_deadline_at is distinct from old.drain_deadline_at then
    raise exception 'recording drain deadline is immutable after close' using errcode = '42501';
  end if;
  if old.status = 'open' and new.status = 'closing' and new.drain_deadline_at is null then
    raise exception 'a closing capture must have an operational drain deadline' using errcode = '42501';
  end if;
  if not (
    (old.status = 'open' and new.status in ('closing', 'failed'))
    or (old.status = 'closing' and new.status in ('sealing', 'failed'))
    or (old.status = 'sealing' and new.status in ('sealed', 'partial', 'failed'))
    or (old.status = 'sealing' and new.status = 'sealing' and old.lease_expires_at <= now())
  ) then
    raise exception 'illegal recording capture transition % to %', old.status, new.status using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.dialpad_recording_guard_segment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad recording segments are immutable evidence' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.capture_id, new.org_id, new.track, new.epoch) is distinct from (old.capture_id, old.org_id, old.track, old.epoch) then
    raise exception 'recording segment identity is immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.eof_seq is not null and new.eof_seq is distinct from old.eof_seq) then
    raise exception 'recording segment end of file is set once' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.chunk_count < old.chunk_count or new.total_bytes < old.total_bytes) then
    raise exception 'recording segment counters only grow' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.dialpad_recording_guard_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% rows are immutable evidence', tg_table_name using errcode = '42501';
end;
$$;

create or replace function public.dialpad_recording_guard_grant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad recording ingest grants are immutable evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.consumed_at is not null or new.consumed_by is not null or new.revoked_at is not null then
      raise exception 'an ingest grant must be minted unused' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['consumed_at', 'consumed_by', 'revoked_at']) <> (to_jsonb(old) - array['consumed_at', 'consumed_by', 'revoked_at']) then
    raise exception 'ingest grant identity and token hash are immutable' using errcode = '42501';
  end if;
  if new.consumed_at is distinct from old.consumed_at or new.consumed_by is distinct from old.consumed_by then
    if old.consumed_at is not null or old.revoked_at is not null or new.consumed_at is null then
      raise exception 'an ingest grant is single-use and cannot be consumed once revoked' using errcode = '42501';
    end if;
    if new.consumed_at >= new.expires_at then
      raise exception 'an expired ingest grant cannot be consumed' using errcode = '42501';
    end if;
    if not exists (select 1 from public.dialpad_recording_captures c where c.id = new.capture_id and c.status = 'open') then
      raise exception 'an ingest grant can be consumed only for an open capture' using errcode = '42501';
    end if;
  end if;
  if new.revoked_at is distinct from old.revoked_at and (old.revoked_at is not null or new.revoked_at is null or old.consumed_at is not null) then
    raise exception 'an ingest grant is revoked once, before it is consumed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists dialpad_recording_captures_guard on public.dialpad_recording_captures;
create trigger dialpad_recording_captures_guard
  before insert or update or delete on public.dialpad_recording_captures
  for each row execute function public.dialpad_recording_guard_capture();

drop trigger if exists dialpad_recording_segments_guard on public.dialpad_recording_segments;
create trigger dialpad_recording_segments_guard
  before update or delete on public.dialpad_recording_segments
  for each row execute function public.dialpad_recording_guard_segment();

drop trigger if exists dialpad_recording_chunks_guard on public.dialpad_recording_chunks;
create trigger dialpad_recording_chunks_guard
  before update or delete on public.dialpad_recording_chunks
  for each row execute function public.dialpad_recording_guard_append_only();

drop trigger if exists dialpad_recording_track_finals_guard on public.dialpad_recording_track_finals;
create trigger dialpad_recording_track_finals_guard
  before update or delete on public.dialpad_recording_track_finals
  for each row execute function public.dialpad_recording_guard_append_only();

drop trigger if exists dialpad_recording_ingest_grants_guard on public.dialpad_recording_ingest_grants;
create trigger dialpad_recording_ingest_grants_guard
  before insert or update or delete on public.dialpad_recording_ingest_grants
  for each row execute function public.dialpad_recording_guard_grant();

-- ----------------------------------------------------------------------------
-- Internal helpers
-- ----------------------------------------------------------------------------

create or replace function public.dialpad_recording_capture_json(p_capture_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'captureId', c.id, 'orgId', c.org_id, 'repUserId', c.rep_user_id, 'intentId', c.intent_id,
    'callActivityId', c.call_activity_id, 'providerCallId', c.provider_call_id,
    'status', c.status, 'openedAt', c.opened_at, 'closedAt', c.closed_at, 'closeReason', c.close_reason,
    'drainDeadlineAt', c.drain_deadline_at,
    'resultAt', c.result_at, 'failureCode', c.failure_code, 'sealAttempts', c.seal_attempts,
    'segments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'track', s.track, 'epoch', s.epoch, 'chunkCount', s.chunk_count, 'totalBytes', s.total_bytes,
        'maxSeq', s.max_seq, 'eofSeq', s.eof_seq,
        'final', (select jsonb_build_object('completeness', f.completeness, 'storagePath', f.storage_path,
                                            'sizeBytes', f.size_bytes, 'decodedDurationMs', f.decoded_duration_ms)
                    from public.dialpad_recording_track_finals f
                   where f.capture_id = s.capture_id and f.track = s.track and f.epoch = s.epoch))
        order by s.epoch, s.track)
      from public.dialpad_recording_segments s where s.capture_id = c.id), '[]'::jsonb))
  from public.dialpad_recording_captures c where c.id = p_capture_id;
$$;

-- The only writer of Dialpad call_recordings rows. Nothing is 'available' until
-- a trusted seal result is registered; a partial or failed capture is recorded
-- as failed so it is never counted or offered as a complete recording.
create or replace function public.dialpad_recording_publish_call_row(
  p_call_activity_id uuid, p_status text, p_storage_path text, p_duration_seconds integer, p_error_code text, p_error_message text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.call_recordings (call_activity_id, status, storage_path, duration_seconds, error_code, error_message)
  values (p_call_activity_id, p_status, p_storage_path, p_duration_seconds, p_error_code, p_error_message)
  on conflict (call_activity_id) do update
    set status = excluded.status, storage_path = excluded.storage_path, duration_seconds = excluded.duration_seconds,
        error_code = excluded.error_code, error_message = excluded.error_message;
end;
$$;

-- ----------------------------------------------------------------------------
-- Open / replay / read / close
-- ----------------------------------------------------------------------------
-- Opening requires the rep's CURRENT active membership and signed connected,
-- non-ended call status. Status comes from fn_get_dialpad_call_status, which
-- ignores the dispatch-intent TTL once an intent is matched, so a long call is
-- never invalidated by that TTL. Attribution is copied from the frozen intent.
create or replace function public.fn_open_dialpad_recording_capture(
  p_org_id uuid, p_rep_user_id uuid, p_intent_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.dialpad_call_intents%rowtype;
  v_call jsonb;
  v_activity public.call_activities%rowtype;
  v_existing uuid;
  v_capture_id uuid;
begin
  if p_org_id is null or p_rep_user_id is null or p_intent_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_intent from public.dialpad_call_intents
    where id = p_intent_id and org_id = p_org_id and rep_user_id = p_rep_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  if not public.dialpad_cti_member_is_active(p_org_id, p_rep_user_id)
     or not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_rep_user_id and m.acquisitions_enabled) then
    return jsonb_build_object('status', 'denied', 'reason', 'rep_not_active');
  end if;

  select id into v_existing from public.dialpad_recording_captures where intent_id = v_intent.id;
  if found then
    return jsonb_build_object('status', 'replayed', 'capture', public.dialpad_recording_capture_json(v_existing));
  end if;

  v_call := public.fn_get_dialpad_call_status(p_org_id, p_rep_user_id, p_intent_id);
  if v_call->>'state' = 'ended' then
    return jsonb_build_object('status', 'denied', 'reason', 'call_ended');
  elsif v_call->>'state' is distinct from 'connected' then
    return jsonb_build_object('status', 'denied', 'reason', 'call_not_connected', 'callState', v_call->>'state');
  end if;

  select * into v_activity from public.call_activities
    where id = nullif(v_call->>'callActivityId', '')::uuid and org_id = p_org_id and provider = 'dialpad';
  if not found or v_activity.operator_user_id is distinct from p_rep_user_id
     or v_activity.jitter_attempt_id <> 'dialpad-cti:' || v_intent.id::text or v_activity.ended_at is not null
     or v_intent.matched_provider_call_id is null then
    return jsonb_build_object('status', 'denied', 'reason', 'call_not_projected');
  end if;

  insert into public.dialpad_recording_captures (org_id, intent_id, rep_user_id, call_activity_id, provider_call_id)
  values (p_org_id, v_intent.id, p_rep_user_id, v_activity.id, v_intent.matched_provider_call_id)
  on conflict (intent_id) do nothing
  returning id into v_capture_id;
  if v_capture_id is null then
    select id into v_capture_id from public.dialpad_recording_captures where intent_id = v_intent.id;
    return jsonb_build_object('status', 'replayed', 'capture', public.dialpad_recording_capture_json(v_capture_id));
  end if;
  return jsonb_build_object('status', 'opened', 'capture', public.dialpad_recording_capture_json(v_capture_id));
end;
$$;

create or replace function public.fn_get_dialpad_recording_capture(
  p_org_id uuid, p_rep_user_id uuid, p_capture_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_org_id is null or p_rep_user_id is null or p_capture_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.dialpad_recording_captures where id = p_capture_id and org_id = p_org_id and rep_user_id = p_rep_user_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return public.dialpad_recording_capture_json(p_capture_id);
end;
$$;

-- p_rep_user_id set: a session-owned close by that rep (must own the capture).
-- p_rep_user_id null: a trusted service close (worker or reaper). Idempotent.
create or replace function public.fn_close_dialpad_recording_capture(
  p_org_id uuid, p_capture_id uuid, p_rep_user_id uuid default null, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_reason text;
  v_call_ended boolean;
begin
  if p_org_id is null or p_capture_id is null or (p_reason is not null and p_reason not in ('call_ended', 'service_closed'))
     or (p_rep_user_id is not null and p_reason is not null) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_capture from public.dialpad_recording_captures
    where id = p_capture_id and org_id = p_org_id and (p_rep_user_id is null or rep_user_id = p_rep_user_id) for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_capture.status <> 'open' then
    return jsonb_build_object('status', 'replayed', 'capture', public.dialpad_recording_capture_json(v_capture.id));
  end if;
  -- A session close after the provider's signed hangup is still a normal
  -- call-ended close. If the signed end is not projected yet, preserve the
  -- caller's early-stop reason permanently; a later hangup cannot upgrade it.
  select exists (
    select 1 from public.call_activities a
     where a.id = v_capture.call_activity_id and a.ended_at is not null
  ) into v_call_ended;
  v_reason := case
    when v_call_ended then 'call_ended'
    when p_rep_user_id is not null then 'rep_closed'
    else coalesce(p_reason, 'service_closed')
  end;
  -- This deadline is an operational bound for an abandoned/incomplete
  -- MediaRecorder flush. It is not a timing tolerance and cannot establish
  -- stream completeness or provider-call duration.
  update public.dialpad_recording_captures
     set status = 'closing', closed_at = now(), close_reason = v_reason,
         drain_deadline_at = now() + interval '30 seconds'
   where id = v_capture.id;
  return jsonb_build_object('status', 'closed', 'capture', public.dialpad_recording_capture_json(v_capture.id));
end;
$$;

-- ----------------------------------------------------------------------------
-- Ingest grants
-- ----------------------------------------------------------------------------
-- The caller mints the random token and passes only its SHA-256 (hex). Epochs
-- are authorized in order and at most once each: a consumed epoch can never be
-- authorized again, so a reconnect is always a new, separate, partial segment.
create or replace function public.fn_mint_dialpad_recording_ingest_grant(
  p_org_id uuid, p_rep_user_id uuid, p_capture_id uuid, p_epoch integer, p_token_hash text, p_ttl_seconds integer default 60
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_grant public.dialpad_recording_ingest_grants%rowtype;
  v_max_consumed integer;
begin
  if p_org_id is null or p_rep_user_id is null or p_capture_id is null or p_epoch is null or p_epoch not between 1 and 16
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_ttl_seconds is null or p_ttl_seconds not between 10 and 300 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_capture from public.dialpad_recording_captures
    where id = p_capture_id and org_id = p_org_id and rep_user_id = p_rep_user_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_grant from public.dialpad_recording_ingest_grants where token_hash = p_token_hash;
  if found then
    if v_grant.capture_id = p_capture_id and v_grant.rep_user_id = p_rep_user_id and v_grant.epoch = p_epoch then
      return jsonb_build_object('status', 'replayed', 'grantId', v_grant.id, 'captureId', p_capture_id, 'epoch', p_epoch, 'expiresAt', v_grant.expires_at);
    end if;
    raise exception 'GRANT_CONFLICT' using errcode = '40001';
  end if;

  if v_capture.status <> 'open' then
    return jsonb_build_object('status', 'denied', 'reason', 'capture_not_open');
  end if;
  if not public.dialpad_cti_member_is_active(p_org_id, p_rep_user_id)
     or not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_rep_user_id and m.acquisitions_enabled) then
    return jsonb_build_object('status', 'denied', 'reason', 'rep_not_active');
  end if;
  if exists (select 1 from public.call_activities a where a.id = v_capture.call_activity_id and a.ended_at is not null) then
    return jsonb_build_object('status', 'denied', 'reason', 'call_ended');
  end if;
  select coalesce(max(epoch), 0) into v_max_consumed from public.dialpad_recording_ingest_grants
    where capture_id = p_capture_id and consumed_at is not null;
  if p_epoch <= v_max_consumed then
    return jsonb_build_object('status', 'denied', 'reason', 'epoch_already_authorized');
  elsif p_epoch > v_max_consumed + 1 then
    return jsonb_build_object('status', 'denied', 'reason', 'epoch_out_of_order');
  end if;
  if (select count(*) from public.dialpad_recording_ingest_grants where capture_id = p_capture_id) >= 64 then
    return jsonb_build_object('status', 'denied', 'reason', 'grant_limit');
  end if;

  update public.dialpad_recording_ingest_grants set revoked_at = now()
    where capture_id = p_capture_id and consumed_at is null and revoked_at is null;
  insert into public.dialpad_recording_ingest_grants (org_id, capture_id, rep_user_id, epoch, token_hash, expires_at)
  values (p_org_id, p_capture_id, p_rep_user_id, p_epoch, p_token_hash, now() + make_interval(secs => p_ttl_seconds))
  returning * into v_grant;
  return jsonb_build_object('status', 'minted', 'grantId', v_grant.id, 'captureId', p_capture_id, 'epoch', p_epoch, 'expiresAt', v_grant.expires_at);
end;
$$;

-- Lock order matches mint and close: the capture first, then the grant.
create or replace function public.fn_consume_dialpad_recording_ingest_grant(
  p_token_hash text, p_worker_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture_id uuid;
  v_capture public.dialpad_recording_captures%rowtype;
  v_grant public.dialpad_recording_ingest_grants%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_worker_id is null or length(p_worker_id) not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select capture_id into v_capture_id from public.dialpad_recording_ingest_grants where token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'denied', 'reason', 'unknown'); end if;

  select * into v_capture from public.dialpad_recording_captures where id = v_capture_id for share;
  select * into v_grant from public.dialpad_recording_ingest_grants where token_hash = p_token_hash for update;

  if v_grant.revoked_at is not null then return jsonb_build_object('status', 'denied', 'reason', 'revoked'); end if;
  if v_grant.consumed_at is not null then return jsonb_build_object('status', 'denied', 'reason', 'consumed'); end if;
  if v_grant.expires_at <= now() then return jsonb_build_object('status', 'denied', 'reason', 'expired'); end if;
  if v_capture.status <> 'open' then return jsonb_build_object('status', 'denied', 'reason', 'capture_not_open'); end if;
  if not public.dialpad_cti_member_is_active(v_capture.org_id, v_capture.rep_user_id)
     or not exists (select 1 from public.memberships m where m.org_id = v_capture.org_id and m.user_id = v_capture.rep_user_id and m.acquisitions_enabled) then
    return jsonb_build_object('status', 'denied', 'reason', 'rep_not_active');
  end if;
  if exists (select 1 from public.call_activities a where a.id = v_capture.call_activity_id and a.ended_at is not null) then
    return jsonb_build_object('status', 'denied', 'reason', 'call_ended');
  end if;

  begin
    update public.dialpad_recording_ingest_grants set consumed_at = now(), consumed_by = p_worker_id where id = v_grant.id;
  exception when unique_violation then
    return jsonb_build_object('status', 'denied', 'reason', 'epoch_already_authorized');
  end;
  return jsonb_build_object('status', 'consumed', 'grantId', v_grant.id, 'captureId', v_capture.id, 'orgId', v_capture.org_id,
    'repUserId', v_capture.rep_user_id, 'epoch', v_grant.epoch, 'intentId', v_capture.intent_id,
    'callActivityId', v_capture.call_activity_id, 'providerCallId', v_capture.provider_call_id);
end;
$$;

-- ----------------------------------------------------------------------------
-- Chunk ledger
-- ----------------------------------------------------------------------------
create or replace function public.fn_record_dialpad_recording_chunk(
  p_org_id uuid, p_capture_id uuid, p_track text, p_epoch integer, p_seq integer,
  p_size_bytes integer, p_sha256 text, p_is_eof boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_chunk public.dialpad_recording_chunks%rowtype;
  v_segment public.dialpad_recording_segments%rowtype;
  v_path text;
begin
  if p_org_id is null or p_capture_id is null or p_track is null or p_track not in ('tab', 'mic')
     or p_epoch is null or p_epoch not between 1 and 16 or p_seq is null or p_seq not between 0 and 99999
     or p_size_bytes is null or p_size_bytes not between 1 and 1048576
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_is_eof is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_capture from public.dialpad_recording_captures where id = p_capture_id and org_id = p_org_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_path := public.dialpad_recording_chunk_path(p_org_id, p_capture_id, p_epoch, p_track, p_seq);

  select * into v_chunk from public.dialpad_recording_chunks
    where capture_id = p_capture_id and track = p_track and epoch = p_epoch and seq = p_seq;
  if found then
    if v_chunk.size_bytes = p_size_bytes and v_chunk.sha256 = p_sha256 and v_chunk.is_eof = p_is_eof then
      return jsonb_build_object('status', 'replayed', 'storagePath', v_path);
    end if;
    raise exception 'CHUNK_CONFLICT' using errcode = '40001', detail = 'chunk_conflict';
  end if;

  select * into v_capture from public.dialpad_recording_captures where id = p_capture_id for share;
  if v_capture.status not in ('open', 'closing') then
    raise exception 'CAPTURE_NOT_ACCEPTING' using errcode = '55000', detail = v_capture.status;
  end if;
  if not exists (select 1 from public.dialpad_recording_ingest_grants g
                  where g.capture_id = p_capture_id and g.epoch = p_epoch and g.consumed_at is not null) then
    raise exception 'EPOCH_NOT_AUTHORIZED' using errcode = '42501', detail = 'epoch_not_authorized';
  end if;

  insert into public.dialpad_recording_segments (capture_id, org_id, track, epoch)
  values (p_capture_id, p_org_id, p_track, p_epoch) on conflict do nothing;
  select * into v_segment from public.dialpad_recording_segments
    where capture_id = p_capture_id and track = p_track and epoch = p_epoch for update;

  select * into v_chunk from public.dialpad_recording_chunks
    where capture_id = p_capture_id and track = p_track and epoch = p_epoch and seq = p_seq;
  if found then
    if v_chunk.size_bytes = p_size_bytes and v_chunk.sha256 = p_sha256 and v_chunk.is_eof = p_is_eof then
      return jsonb_build_object('status', 'replayed', 'storagePath', v_path);
    end if;
    raise exception 'CHUNK_CONFLICT' using errcode = '40001', detail = 'chunk_conflict';
  end if;

  if v_segment.eof_seq is not null and p_seq > v_segment.eof_seq then
    raise exception 'CHUNK_AFTER_EOF' using errcode = '40001', detail = 'chunk_after_eof';
  end if;
  if p_is_eof then
    if v_segment.eof_seq is not null then
      raise exception 'EOF_CONFLICT' using errcode = '40001', detail = 'eof_conflict';
    end if;
    if p_seq < coalesce(v_segment.max_seq, -1) then
      raise exception 'EOF_BEFORE_LATER_CHUNK' using errcode = '40001', detail = 'eof_before_later_chunk';
    end if;
  end if;
  if v_segment.total_bytes + p_size_bytes > 536870912 then
    raise exception 'TRACK_TOO_LARGE' using errcode = '22023', detail = 'track_too_large';
  end if;

  insert into public.dialpad_recording_chunks (capture_id, org_id, track, epoch, seq, size_bytes, sha256, is_eof, storage_path)
  values (p_capture_id, p_org_id, p_track, p_epoch, p_seq, p_size_bytes, p_sha256, p_is_eof, v_path);
  update public.dialpad_recording_segments
    set chunk_count = chunk_count + 1, total_bytes = total_bytes + p_size_bytes,
        max_seq = greatest(coalesce(max_seq, -1), p_seq),
        eof_seq = case when p_is_eof then p_seq else eof_seq end,
        updated_at = now()
    where capture_id = p_capture_id and track = p_track and epoch = p_epoch;
  return jsonb_build_object('status', 'recorded', 'storagePath', v_path);
end;
$$;

-- ----------------------------------------------------------------------------
-- Sealing work: claim and recovery
-- ----------------------------------------------------------------------------
-- Open captures whose call activity has ended are moved to closing first.
-- Closing captures are claimable immediately only when both expected tracks
-- have ledger EOF and contiguous chunks for every consumed epoch. Otherwise
-- the bounded operational drain deadline (30 seconds after close) allows a
-- worker to classify the incomplete evidence. The deadline is never a
-- measurement tolerance and never makes incomplete streams complete.
-- A sealing capture whose lease expired is also claimable with a fresh token.
-- After five claims a capture that still has not registered a result is failed.
create or replace function public.fn_claim_dialpad_recording_seal_work(
  p_worker_id text, p_lease_seconds integer default 300
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_token uuid := extensions.gen_random_uuid();
  v_guard integer := 0;
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 200 or p_lease_seconds is null or p_lease_seconds not between 30 and 1800 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.dialpad_recording_captures c
    set status = 'closing', closed_at = now(), close_reason = 'call_ended',
        drain_deadline_at = now() + interval '30 seconds'
    where c.status = 'open'
      and exists (select 1 from public.call_activities a where a.id = c.call_activity_id and a.ended_at is not null);

  loop
    v_guard := v_guard + 1;
    exit when v_guard > 25;
    select * into v_capture from public.dialpad_recording_captures c
      where (
        c.status = 'closing'
        and (
          coalesce(c.drain_deadline_at, c.closed_at + interval '30 seconds') <= now()
          or (
            exists (
              select 1 from public.dialpad_recording_ingest_grants g
               where g.capture_id = c.id and g.consumed_at is not null
            )
            and not exists (
              select 1
                from (
                  select distinct g.epoch
                    from public.dialpad_recording_ingest_grants g
                   where g.capture_id = c.id and g.consumed_at is not null
                ) epochs
                cross join (values ('tab'::text), ('mic'::text)) expected(track)
                left join public.dialpad_recording_segments s
                  on s.capture_id = c.id and s.epoch = epochs.epoch and s.track = expected.track
               where s.capture_id is null
                  or s.chunk_count < 1
                  or s.max_seq is null
                  or s.eof_seq is null
                  or s.eof_seq <> s.max_seq
                  or s.chunk_count <> s.max_seq + 1
            )
          )
        )
      )
      or (c.status = 'sealing' and c.lease_expires_at <= now())
      order by coalesce(closed_at, opened_at), id
      for update skip locked limit 1;
    if not found then return jsonb_build_object('status', 'none'); end if;

    if v_capture.seal_attempts >= 5 then
      update public.dialpad_recording_captures
        set status = 'failed', result_at = now(), failure_code = 'seal_attempts_exhausted' where id = v_capture.id;
      perform public.dialpad_recording_publish_call_row(v_capture.call_activity_id, 'failed', null, null, 'seal_attempts_exhausted',
        'The recording could not be sealed and was not made available.');
      continue;
    end if;

    update public.dialpad_recording_captures
      set status = 'sealing', claim_token = v_token, claimed_by = p_worker_id, claimed_at = now(),
          lease_expires_at = now() + make_interval(secs => p_lease_seconds), seal_attempts = seal_attempts + 1
      where id = v_capture.id;
    return jsonb_build_object(
      'status', 'claimed', 'claimToken', v_token, 'attempt', v_capture.seal_attempts + 1,
      'leaseExpiresAt', now() + make_interval(secs => p_lease_seconds),
      'capture', public.dialpad_recording_capture_json(v_capture.id),
      'finalPaths', coalesce((
        select jsonb_agg(jsonb_build_object('track', s.track, 'epoch', s.epoch,
          'finalPath', public.dialpad_recording_final_path(s.org_id, s.capture_id, s.epoch, s.track)) order by s.epoch, s.track)
        from public.dialpad_recording_segments s where s.capture_id = v_capture.id), '[]'::jsonb));
  end loop;
  return jsonb_build_object('status', 'none');
end;
$$;

-- ----------------------------------------------------------------------------
-- Trusted seal result
-- ----------------------------------------------------------------------------
-- p_tracks is a JSON array of per-(track, epoch) reports:
--   {track, epoch, decodeOk, sizeBytes, sha256, codec, sampleRateHz, channels, decodedDurationMs}
-- (only track, epoch and decodeOk are required when decodeOk is false). Ledger
-- facts (chunk count, bytes, EOF at the last sequence, contiguity) are read from
-- the database, never trusted from the caller, and completeness is derived from
-- them. The consumed-grant inventory is also authoritative: any consumed later
-- epoch or missing expected track keeps the capture partial. Registered
-- atomically under the claim's fencing token; an exact replay is idempotent and
-- a different result is a conflict.
create or replace function public.fn_register_dialpad_recording_result(
  p_capture_id uuid, p_claim_token uuid, p_tracks jsonb, p_failure_code text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_el jsonb;
  v_track text;
  v_epoch integer;
  v_decode_ok boolean;
  v_size bigint;
  v_sha text;
  v_codec text;
  v_rate integer;
  v_channels integer;
  v_duration integer;
  v_count integer;
  v_sum bigint;
  v_max integer;
  v_eof_any boolean;
  v_eof_seq integer;
  v_eof boolean;
  v_contig boolean;
  v_completeness text;
  v_reason text;
  v_segments integer;
  v_reported integer := 0;
  v_complete_first integer;
  v_complete_expected integer;
  v_expected_segments integer;
  v_later_consumed_epochs integer;
  v_usable integer;
  v_outcome text;
  v_fcode text;
  v_duration_seconds integer;
  v_call_end_confirmed boolean;
  v_result_identity jsonb;
begin
  if p_capture_id is null or p_claim_token is null or p_tracks is null or jsonb_typeof(p_tracks) <> 'array'
     or jsonb_array_length(p_tracks) > 32 or (p_failure_code is not null and p_failure_code !~ '^[a-z0-9_]{1,64}$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into v_capture from public.dialpad_recording_captures where id = p_capture_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_capture.claim_token is distinct from p_claim_token then
    raise exception 'LEASE_LOST' using errcode = '42501', detail = 'lease_lost';
  end if;

  for v_el in select value from jsonb_array_elements(p_tracks) loop
    if jsonb_typeof(v_el) is distinct from 'object'
       or coalesce(v_el->>'track', '') not in ('tab', 'mic')
       or jsonb_typeof(v_el->'epoch') is distinct from 'number'
       or jsonb_typeof(v_el->'decodeOk') is distinct from 'boolean' then
      raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'invalid_track_report';
    end if;
    if (v_el->>'epoch')::numeric <> trunc((v_el->>'epoch')::numeric) or (v_el->>'epoch')::numeric not between 1 and 16 then
      raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'invalid_track_report';
    end if;
    if (v_el->>'decodeOk')::boolean then
      if jsonb_typeof(v_el->'sizeBytes') is distinct from 'number' or jsonb_typeof(v_el->'sampleRateHz') is distinct from 'number'
         or jsonb_typeof(v_el->'channels') is distinct from 'number' or jsonb_typeof(v_el->'decodedDurationMs') is distinct from 'number'
         or jsonb_typeof(v_el->'sha256') is distinct from 'string' or jsonb_typeof(v_el->'codec') is distinct from 'string' then
        raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'invalid_decode_evidence';
      end if;
      if (v_el->>'sha256') !~ '^[0-9a-f]{64}$' or (v_el->>'codec') !~ '^[a-z0-9_.-]{1,64}$'
         or (v_el->>'sizeBytes')::numeric not between 1 and 536870912 or (v_el->>'sizeBytes')::numeric <> trunc((v_el->>'sizeBytes')::numeric)
         or (v_el->>'sampleRateHz')::numeric not between 8000 and 192000 or (v_el->>'sampleRateHz')::numeric <> trunc((v_el->>'sampleRateHz')::numeric)
         or (v_el->>'channels')::numeric not between 1 and 2 or (v_el->>'channels')::numeric <> trunc((v_el->>'channels')::numeric)
         or (v_el->>'decodedDurationMs')::numeric not between 1 and 14400000 or (v_el->>'decodedDurationMs')::numeric <> trunc((v_el->>'decodedDurationMs')::numeric) then
        raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'invalid_decode_evidence';
      end if;
    end if;
  end loop;

  -- A submitted result is a set of unique (track, epoch) reports. Validate
  -- uniqueness before any insert and retain a canonical, order-independent
  -- identity so terminal replay cannot replace a missing track with a
  -- duplicate report. The failure input is part of the identity, including
  -- the distinction between SQL NULL and an explicit derived-looking code.
  if exists (
    select 1
      from (
        select value ->> 'track' as track, (value ->> 'epoch')::integer as epoch, count(*) as n
          from jsonb_array_elements(p_tracks)
         group by value ->> 'track', (value ->> 'epoch')::integer
        having count(*) > 1
      ) duplicates
  ) then
    raise exception 'DUPLICATE_TRACK_REPORT' using errcode = '22023', detail = 'duplicate_track_report';
  end if;

  select jsonb_build_object(
           'failureCode', p_failure_code,
           'tracks', coalesce(jsonb_agg(report order by track, epoch), '[]'::jsonb)
         )
    into v_result_identity
    from (
      select value ->> 'track' as track,
             (value ->> 'epoch')::integer as epoch,
             case when (value ->> 'decodeOk')::boolean then
               jsonb_build_object(
                 'track', value ->> 'track',
                 'epoch', (value ->> 'epoch')::integer,
                 'decodeOk', true,
                 'sizeBytes', (value ->> 'sizeBytes')::bigint,
                 'sha256', value ->> 'sha256',
                 'codec', value ->> 'codec',
                 'sampleRateHz', (value ->> 'sampleRateHz')::integer,
                 'channels', (value ->> 'channels')::integer,
                 'decodedDurationMs', (value ->> 'decodedDurationMs')::integer
               )
             else
               jsonb_build_object(
                 'track', value ->> 'track',
                 'epoch', (value ->> 'epoch')::integer,
                 'decodeOk', false
               )
             end as report
        from jsonb_array_elements(p_tracks)
    ) reports;

  if v_capture.status in ('sealed', 'partial', 'failed') then
    if v_capture.result_identity is null or v_capture.result_identity is distinct from v_result_identity then
      raise exception 'RESULT_CONFLICT' using errcode = '40001', detail = 'result_conflict';
    end if;
    return jsonb_build_object('status', 'replayed', 'outcome', v_capture.status, 'capture', public.dialpad_recording_capture_json(p_capture_id));
  end if;

  if v_capture.status <> 'sealing' then
    raise exception 'CAPTURE_NOT_SEALING' using errcode = '55000', detail = v_capture.status;
  end if;
  if v_capture.lease_expires_at <= now() then
    raise exception 'LEASE_LOST' using errcode = '42501', detail = 'lease_lost';
  end if;

  select count(*) into v_segments from public.dialpad_recording_segments where capture_id = p_capture_id;

  for v_el in select value from jsonb_array_elements(p_tracks) loop
    v_track := v_el->>'track';
    v_epoch := (v_el->>'epoch')::integer;
    v_decode_ok := (v_el->>'decodeOk')::boolean;
    if not exists (select 1 from public.dialpad_recording_segments where capture_id = p_capture_id and track = v_track and epoch = v_epoch) then
      raise exception 'UNKNOWN_SEGMENT' using errcode = '22023', detail = 'unknown_segment';
    end if;
    if exists (select 1 from public.dialpad_recording_track_finals where capture_id = p_capture_id and track = v_track and epoch = v_epoch) then
      raise exception 'DUPLICATE_TRACK_REPORT' using errcode = '22023', detail = 'duplicate_track_report';
    end if;

    select count(*), coalesce(sum(size_bytes), 0), coalesce(max(seq), -1), bool_or(is_eof), max(seq) filter (where is_eof)
      into v_count, v_sum, v_max, v_eof_any, v_eof_seq
      from public.dialpad_recording_chunks where capture_id = p_capture_id and track = v_track and epoch = v_epoch;
    v_eof := coalesce(v_eof_any, false) and v_eof_seq = v_max;
    v_contig := v_count > 0 and v_count = v_max + 1;
    v_completeness := case when not v_decode_ok then 'unusable' when v_eof and v_contig then 'complete' else 'partial' end;
    v_reason := case when v_completeness <> 'partial' then null
                     when not v_eof and not v_contig then 'missing_eof_and_gap'
                     when not v_eof then 'missing_eof' else 'chunk_gap' end;

    insert into public.dialpad_recording_track_finals (
      capture_id, org_id, track, epoch, completeness, decode_ok, eof_verified, contiguous,
      source_chunk_count, source_bytes, source_last_seq, storage_path, size_bytes, sha256, codec,
      sample_rate_hz, channels, decoded_duration_ms, partial_reason, registered_by)
    values (
      p_capture_id, v_capture.org_id, v_track, v_epoch, v_completeness, v_decode_ok, v_eof, v_contig,
      v_count, v_sum, v_max,
      case when v_decode_ok then public.dialpad_recording_final_path(v_capture.org_id, p_capture_id, v_epoch, v_track) end,
      case when v_decode_ok then (v_el->>'sizeBytes')::bigint end,
      case when v_decode_ok then v_el->>'sha256' end,
      case when v_decode_ok then v_el->>'codec' end,
      case when v_decode_ok then (v_el->>'sampleRateHz')::integer end,
      case when v_decode_ok then (v_el->>'channels')::smallint end,
      case when v_decode_ok then (v_el->>'decodedDurationMs')::integer end,
      v_reason, v_capture.claimed_by);
    v_reported := v_reported + 1;
  end loop;

  if p_failure_code is null and v_reported <> v_segments then
    raise exception 'SEGMENT_NOT_REPORTED' using errcode = '22023', detail = 'segment_not_reported';
  end if;

  select count(*) into v_complete_first from public.dialpad_recording_track_finals
    where capture_id = p_capture_id and epoch = 1 and completeness = 'complete';
  -- The expected inventory is driven by consumed grants, not by whichever
  -- segment rows happened to receive chunks. A consumed reconnect epoch is a
  -- separate segment and conservatively prevents a complete seal, even when
  -- epoch 1 is fully decodable.
  select coalesce(sum(case when g.epoch > 1 then 1 else 0 end), 0)::integer,
         (count(*) * 2)::integer
    into v_later_consumed_epochs, v_expected_segments
    from public.dialpad_recording_ingest_grants g
   where g.capture_id = p_capture_id and g.consumed_at is not null;
  select count(*)::integer into v_complete_expected
    from public.dialpad_recording_ingest_grants g
    cross join (values ('tab'::text), ('mic'::text)) expected(track)
    join public.dialpad_recording_track_finals f
      on f.capture_id = g.capture_id and f.epoch = g.epoch and f.track = expected.track
     and f.completeness = 'complete'
   where g.capture_id = p_capture_id and g.consumed_at is not null;
  select count(*) into v_usable from public.dialpad_recording_track_finals
    where capture_id = p_capture_id and decode_ok;

  select exists (
    select 1 from public.call_activities a
     where a.id = v_capture.call_activity_id and a.ended_at is not null
  ) into v_call_end_confirmed;

  -- Stream completeness is necessary but not sufficient for a complete
  -- recording: a rep/service close while the provider call is still connected
  -- is an explicit early stop, even if both streams have EOF. A signed call
  -- end must already be projected, and later hangup events cannot rewrite a
  -- terminal partial result.
  if p_failure_code is null and v_expected_segments = 2 and v_segments = v_expected_segments
     and v_complete_expected = v_expected_segments and v_complete_first = 2
     and v_later_consumed_epochs = 0
     and v_capture.close_reason = 'call_ended' and v_call_end_confirmed then
    v_outcome := 'sealed';
  elsif v_usable > 0 then
    v_outcome := 'partial';
  else
    v_outcome := 'failed';
  end if;
  v_fcode := case
    when v_outcome = 'sealed' then null
    when v_outcome = 'failed' then coalesce(
      p_failure_code,
      case
        when v_segments = 0 then 'no_audio_captured'
        when v_capture.close_reason <> 'call_ended' then 'capture_stopped_before_call_end'
        when not v_call_end_confirmed then 'call_end_not_confirmed'
        else 'no_usable_audio'
      end
    )
    else coalesce(
      p_failure_code,
      case
        when v_capture.close_reason <> 'call_ended' then 'capture_stopped_before_call_end'
        when not v_call_end_confirmed then 'call_end_not_confirmed'
      end
    )
  end;

  update public.dialpad_recording_captures
     set status = v_outcome, result_at = now(), failure_code = v_fcode,
         result_identity = v_result_identity
   where id = p_capture_id;

  if v_outcome = 'sealed' then
    select round(decoded_duration_ms / 1000.0)::integer into v_duration_seconds from public.dialpad_recording_track_finals
      where capture_id = p_capture_id and epoch = 1 and track = 'tab';
    perform public.dialpad_recording_publish_call_row(v_capture.call_activity_id, 'available',
      public.dialpad_recording_capture_prefix(v_capture.org_id, p_capture_id), greatest(v_duration_seconds, 0), null, null);
  elsif v_outcome = 'partial' then
    perform public.dialpad_recording_publish_call_row(v_capture.call_activity_id, 'failed', null, null, 'partial_capture',
      'Only part of this call was captured. It is not a complete recording.');
  else
    perform public.dialpad_recording_publish_call_row(v_capture.call_activity_id, 'failed', null, null, v_fcode,
      'No usable recording was captured for this call.');
  end if;

  return jsonb_build_object('status', 'registered', 'outcome', v_outcome, 'capture', public.dialpad_recording_capture_json(p_capture_id));
end;
$$;

-- ----------------------------------------------------------------------------
-- call_recordings: Dialpad rows are written only by the trusted seal RPC
-- ----------------------------------------------------------------------------
-- The org-member write policies stay for every other provider. Dialpad rows are
-- excluded from insert, update and delete so an authenticated user cannot forge
-- an 'available' row (which the acquisition KPIs would count as a recording).
drop policy if exists call_recordings_org_insert on public.call_recordings;
create policy call_recordings_org_insert on public.call_recordings for insert to authenticated with check (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.provider <> 'dialpad'
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);

drop policy if exists call_recordings_org_update on public.call_recordings;
create policy call_recordings_org_update on public.call_recordings for update to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.provider <> 'dialpad'
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
) with check (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.provider <> 'dialpad'
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);

drop policy if exists call_recordings_org_delete on public.call_recordings;
create policy call_recordings_org_delete on public.call_recordings for delete to authenticated using (
  exists (
    select 1 from public.call_activities a
    where a.id = call_recordings.call_activity_id
      and a.provider <> 'dialpad'
      and a.org_id in (select org_id from public.memberships where user_id = auth.uid())
  )
);

-- ----------------------------------------------------------------------------
-- Private bucket
-- ----------------------------------------------------------------------------
-- No storage.objects policy is created for this bucket, so anon and
-- authenticated roles have no read or write path to it; only the service role
-- (which bypasses RLS) reaches objects. file_size_limit bounds one final track
-- object; chunks are bounded to 1 MiB by the ledger, not the bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dialpad-recordings', 'dialpad-recordings', false, 536870912,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'application/octet-stream']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- Row level security and grants
-- ----------------------------------------------------------------------------
alter table public.dialpad_recording_captures enable row level security;
alter table public.dialpad_recording_segments enable row level security;
alter table public.dialpad_recording_chunks enable row level security;
alter table public.dialpad_recording_track_finals enable row level security;
alter table public.dialpad_recording_ingest_grants enable row level security;

revoke all on table public.dialpad_recording_captures from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_segments from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_chunks from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_track_finals from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_ingest_grants from public, anon, authenticated, service_role;

grant select on public.dialpad_recording_captures to service_role;
grant select on public.dialpad_recording_segments to service_role;
grant select on public.dialpad_recording_chunks to service_role;
grant select on public.dialpad_recording_track_finals to service_role;

revoke all on function public.dialpad_recording_capture_prefix(uuid, uuid) from public, anon, authenticated;
revoke all on function public.dialpad_recording_chunk_path(uuid, uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.dialpad_recording_final_path(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.dialpad_recording_guard_capture() from public, anon, authenticated, service_role;
revoke all on function public.dialpad_recording_guard_segment() from public, anon, authenticated, service_role;
revoke all on function public.dialpad_recording_guard_append_only() from public, anon, authenticated, service_role;
revoke all on function public.dialpad_recording_guard_grant() from public, anon, authenticated, service_role;
revoke all on function public.dialpad_recording_capture_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.dialpad_recording_publish_call_row(uuid, text, text, integer, text, text) from public, anon, authenticated, service_role;

revoke all on function public.fn_open_dialpad_recording_capture(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_recording_capture(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_close_dialpad_recording_capture(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_mint_dialpad_recording_ingest_grant(uuid, uuid, uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.fn_consume_dialpad_recording_ingest_grant(text, text) from public, anon, authenticated;
revoke all on function public.fn_record_dialpad_recording_chunk(uuid, uuid, text, integer, integer, integer, text, boolean) from public, anon, authenticated;
revoke all on function public.fn_claim_dialpad_recording_seal_work(text, integer) from public, anon, authenticated;
revoke all on function public.fn_register_dialpad_recording_result(uuid, uuid, jsonb, text) from public, anon, authenticated;

grant execute on function public.fn_open_dialpad_recording_capture(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_get_dialpad_recording_capture(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_close_dialpad_recording_capture(uuid, uuid, uuid, text) to service_role;
grant execute on function public.fn_mint_dialpad_recording_ingest_grant(uuid, uuid, uuid, integer, text, integer) to service_role;
grant execute on function public.fn_consume_dialpad_recording_ingest_grant(text, text) to service_role;
grant execute on function public.fn_record_dialpad_recording_chunk(uuid, uuid, text, integer, integer, integer, text, boolean) to service_role;
grant execute on function public.fn_claim_dialpad_recording_seal_work(text, integer) to service_role;
grant execute on function public.fn_register_dialpad_recording_result(uuid, uuid, jsonb, text) to service_role;

commit;
