-- Transport contract for the R1 Dialpad recording capture ledger.
--
-- This migration deliberately stays below final KPI projection. It records
-- authoritative lifecycle/EOF evidence, claim-fenced seal inputs, and exact
-- server-derived VAD ranges. The later finalizer owns provider-window
-- evidence and any final confidence decision.

begin;

alter table public.dialpad_recording_segments
  add column if not exists eof_sha256 text,
  add column if not exists eof_marked_at timestamptz;

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
        'maxSeq', s.max_seq, 'eofSeq', s.eof_seq, 'eofSha256', s.eof_sha256, 'eofMarkedAt', s.eof_marked_at,
        'final', (select jsonb_build_object('completeness', f.completeness, 'storagePath', f.storage_path,
                                            'sizeBytes', f.size_bytes, 'decodedDurationMs', f.decoded_duration_ms)
                    from public.dialpad_recording_track_finals f
                   where f.capture_id = s.capture_id and f.track = s.track and f.epoch = s.epoch))
        order by s.epoch, s.track)
      from public.dialpad_recording_segments s where s.capture_id = c.id), '[]'::jsonb))
  from public.dialpad_recording_captures c where c.id = p_capture_id;
$$;

-- Backfill the hash for R1 rows created with the legacy is_eof flag before the
-- stronger explicit EOF contract was installed.
update public.dialpad_recording_segments s
   set eof_sha256 = c.sha256,
       eof_marked_at = coalesce(s.eof_marked_at, c.recorded_at)
  from public.dialpad_recording_chunks c
 where c.capture_id = s.capture_id
   and c.track = s.track
   and c.epoch = s.epoch
   and c.seq = s.eof_seq
   and s.eof_seq is not null
   and s.eof_sha256 is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.dialpad_recording_segments'::regclass
       and conname = 'dialpad_recording_segments_eof_identity_check'
  ) then
    alter table public.dialpad_recording_segments
      add constraint dialpad_recording_segments_eof_identity_check
      check ((eof_seq is null and eof_sha256 is null and eof_marked_at is null)
          or (eof_seq is not null and eof_sha256 ~ '^[0-9a-f]{64}$' and eof_marked_at is not null));
  end if;
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
  if tg_op = 'UPDATE' and old.eof_seq is not null and (
       new.eof_seq is distinct from old.eof_seq
       or new.eof_sha256 is distinct from old.eof_sha256
       or new.eof_marked_at is distinct from old.eof_marked_at
  ) then
    raise exception 'recording segment end of file is set once' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.eof_seq is null and new.eof_seq is not null
     and (new.eof_sha256 is null or new.eof_marked_at is null) then
    raise exception 'recording segment end of file requires acknowledged chunk identity' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.eof_seq is not null
     and (new.eof_sha256 is null or new.eof_marked_at is null) then
    raise exception 'recording segment end of file identity is incomplete' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.chunk_count < old.chunk_count or new.total_bytes < old.total_bytes) then
    raise exception 'recording segment counters only grow' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Keep the R1 chunk RPC compatible while recording the hash and timestamp of
-- an EOF attached to the final acknowledged chunk. Explicit EOF is also
-- available below for MediaRecorder implementations that acknowledge the
-- final blob before sending the EOF marker.
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
     set chunk_count = chunk_count + 1,
         total_bytes = total_bytes + p_size_bytes,
         max_seq = greatest(coalesce(max_seq, -1), p_seq),
         eof_seq = case when p_is_eof then p_seq else eof_seq end,
         eof_sha256 = case when p_is_eof then p_sha256 else eof_sha256 end,
         eof_marked_at = case when p_is_eof then now() else eof_marked_at end,
         updated_at = now()
   where capture_id = p_capture_id and track = p_track and epoch = p_epoch;
  return jsonb_build_object('status', 'recorded', 'storagePath', v_path);
end;
$$;

-- EOF is an explicit, idempotent acknowledgement after the final chunk has
-- been accepted. It is claimable only for an acknowledged chunk at the
-- segment high-water mark; gaps remain visible to the seal classifier.
create or replace function public.fn_mark_dialpad_recording_eof(
  p_org_id uuid, p_capture_id uuid, p_track text, p_epoch integer,
  p_eof_seq integer, p_eof_sha256 text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_segment public.dialpad_recording_segments%rowtype;
  v_chunk public.dialpad_recording_chunks%rowtype;
begin
  if p_org_id is null or p_capture_id is null or p_track not in ('tab', 'mic')
     or p_epoch is null or p_epoch not between 1 and 16
     or p_eof_seq is null or p_eof_seq not between 0 and 99999
     or p_eof_sha256 is null or p_eof_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into v_capture
    from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id
   for share;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_capture.status not in ('open', 'closing') then
    raise exception 'CAPTURE_NOT_ACCEPTING' using errcode = '55000', detail = v_capture.status;
  end if;
  if not exists (select 1 from public.dialpad_recording_ingest_grants g
                  where g.capture_id = p_capture_id and g.epoch = p_epoch and g.consumed_at is not null) then
    raise exception 'EPOCH_NOT_AUTHORIZED' using errcode = '42501', detail = 'epoch_not_authorized';
  end if;

  select * into v_segment
    from public.dialpad_recording_segments
   where capture_id = p_capture_id and track = p_track and epoch = p_epoch
   for update;
  if not found then raise exception 'EOF_CHUNK_MISSING' using errcode = '55000', detail = 'eof_chunk_missing'; end if;

  if v_segment.eof_seq is not null then
    if v_segment.eof_seq = p_eof_seq and v_segment.eof_sha256 = p_eof_sha256 then
      return jsonb_build_object('status', 'replayed', 'captureId', p_capture_id,
        'track', p_track, 'epoch', p_epoch, 'seq', p_eof_seq, 'sha256', p_eof_sha256);
    end if;
    raise exception 'EOF_CONFLICT' using errcode = '40001', detail = 'eof_conflict';
  end if;
  if v_segment.max_seq is distinct from p_eof_seq then
    raise exception 'EOF_NOT_LAST_ACKNOWLEDGED_CHUNK' using errcode = '40001', detail = 'eof_not_last_acknowledged_chunk';
  end if;

  select * into v_chunk
    from public.dialpad_recording_chunks
   where capture_id = p_capture_id and track = p_track and epoch = p_epoch and seq = p_eof_seq;
  if not found then raise exception 'EOF_CHUNK_MISSING' using errcode = '55000', detail = 'eof_chunk_missing'; end if;
  if v_chunk.sha256 <> p_eof_sha256 then
    raise exception 'EOF_HASH_CONFLICT' using errcode = '40001', detail = 'eof_hash_conflict';
  end if;

  update public.dialpad_recording_segments
     set eof_seq = p_eof_seq, eof_sha256 = p_eof_sha256, eof_marked_at = now(), updated_at = now()
   where capture_id = p_capture_id and track = p_track and epoch = p_epoch;
  return jsonb_build_object('status', 'recorded', 'captureId', p_capture_id,
    'track', p_track, 'epoch', p_epoch, 'seq', p_eof_seq, 'sha256', p_eof_sha256);
end;
$$;

-- This is the authoritative lifecycle read for capture workers. A provider
-- signed event is read through the existing call-status projection; local
-- capture status only controls transport acceptance and bounded drain.
create or replace function public.fn_get_dialpad_recording_lifecycle(
  p_org_id uuid, p_capture_id uuid
) returns jsonb
language plpgsql security definer stable set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_call jsonb;
  v_call_state text;
  v_live boolean;
  v_drain boolean;
begin
  if p_org_id is null or p_capture_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_capture
    from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  v_call := public.fn_get_dialpad_call_status(v_capture.org_id, v_capture.rep_user_id, v_capture.intent_id);
  v_call_state := v_call->>'state';
  v_live := v_capture.status = 'open' and v_call_state = 'connected';
  v_drain := v_capture.status in ('open', 'closing', 'sealing')
             and v_call_state in ('connected', 'ended');
  return jsonb_build_object(
    'captureId', v_capture.id,
    'orgId', v_capture.org_id,
    'repUserId', v_capture.rep_user_id,
    'intentId', v_capture.intent_id,
    'callActivityId', v_capture.call_activity_id,
    'providerCallId', v_capture.provider_call_id,
    'captureStatus', v_capture.status,
    'callStatus', v_call,
    'callState', v_call_state,
    'connected', coalesce((v_call->>'connected')::boolean, false),
    'ended', v_call_state = 'ended',
    'acceptsLivePcm', v_live,
    'allowsRetentionDrain', v_drain,
    'closedAt', v_capture.closed_at,
    'closeReason', v_capture.close_reason,
    'drainDeadlineAt', v_capture.drain_deadline_at
  );
end;
$$;

-- Seal workers must fetch the exact immutable chunk ledger only while their
-- current lease is valid. Ordering is epoch, track (tab before mic), seq.
create or replace function public.fn_get_dialpad_recording_seal_inputs(
  p_capture_id uuid, p_claim_token uuid
) returns jsonb
language plpgsql security definer stable set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
begin
  if p_capture_id is null or p_claim_token is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_capture
    from public.dialpad_recording_captures
   where id = p_capture_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_capture.status <> 'sealing'
     or v_capture.claim_token is distinct from p_claim_token
     or v_capture.lease_expires_at is null
     or v_capture.lease_expires_at <= now() then
    raise exception 'SEAL_LEASE_LOST' using errcode = '42501', detail = 'seal_lease_lost';
  end if;
  return jsonb_build_object(
    'status', 'ready',
    'captureId', v_capture.id,
    'claimToken', v_capture.claim_token,
    'inputs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'captureId', c.capture_id, 'orgId', c.org_id, 'track', c.track, 'epoch', c.epoch,
        'seq', c.seq, 'sizeBytes', c.size_bytes, 'sha256', c.sha256,
        'storagePath', c.storage_path, 'isEof', c.is_eof
      ) order by c.epoch, case when c.track = 'tab' then 0 else 1 end, c.seq)
        from public.dialpad_recording_chunks c where c.capture_id = v_capture.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Durable, server-derived VAD evidence. Each batch is immutable and replay
-- addressed; raw half-open sample ranges remain available to a later
-- finalizer instead of being reduced to a client-provided total.
create table if not exists public.dialpad_recording_vad_batches (
  batch_id uuid primary key,
  capture_id uuid not null,
  org_id uuid not null,
  track text not null check (track = 'tab'),
  epoch smallint not null check (epoch between 1 and 16),
  range_count integer not null check (range_count between 0 and 256),
  ranges_sha256 text not null check (ranges_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  unique (batch_id, capture_id, epoch, track),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id)
);

create table if not exists public.dialpad_recording_vad_ranges (
  capture_id uuid not null,
  org_id uuid not null,
  track text not null check (track = 'tab'),
  epoch smallint not null check (epoch between 1 and 16),
  batch_id uuid not null references public.dialpad_recording_vad_batches (batch_id),
  range_index smallint not null check (range_index between 0 and 255),
  start_sample bigint not null check (start_sample between 0 and 1000000000000),
  end_sample bigint not null check (end_sample between 1 and 1000000000000),
  evidence_ref text not null check (length(evidence_ref) between 1 and 256),
  recorded_at timestamptz not null default now(),
  primary key (capture_id, track, epoch, batch_id, range_index),
  check (end_sample > start_sample),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id),
  foreign key (batch_id) references public.dialpad_recording_vad_batches (batch_id)
);

create table if not exists public.dialpad_recording_vad_totals (
  capture_id uuid primary key,
  org_id uuid not null,
  voiced_samples bigint not null default 0 check (voiced_samples >= 0),
  high_water_epoch smallint check (high_water_epoch between 1 and 16),
  high_water_end_sample bigint check (high_water_end_sample is null or high_water_end_sample >= 0),
  measurement_status text not null default 'provisional'
    check (measurement_status in ('provisional', 'partial', 'finalized')),
  provider_window_evidence jsonb,
  finalized_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((measurement_status = 'finalized') = (finalized_at is not null)),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id)
);

create table if not exists public.dialpad_recording_vad_threshold_latches (
  capture_id uuid primary key,
  org_id uuid not null,
  threshold_samples bigint not null default 4800000 check (threshold_samples = 4800000),
  crossing_total_samples bigint not null check (crossing_total_samples > threshold_samples),
  crossing_epoch smallint not null check (crossing_epoch between 1 and 16),
  crossing_start_sample bigint not null check (crossing_start_sample >= 0),
  crossing_end_sample bigint not null check (crossing_end_sample > crossing_start_sample),
  evidence_ref text not null check (length(evidence_ref) between 1 and 256),
  latched_at timestamptz not null default now(),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id)
);

comment on table public.dialpad_recording_vad_totals is
  'Provisional exact 16 kHz sample union. This is transport evidence only; a later server finalizer owns provider-window evidence, final timing, and KPI eligibility.';
comment on table public.dialpad_recording_vad_threshold_latches is
  'One once-only strict crossing latch for voiced samples > 4,800,000. It is not a final KPI projection.';

create or replace function public.fn_record_dialpad_recording_vad_ranges(
  p_org_id uuid, p_capture_id uuid, p_track text, p_epoch integer,
  p_batch_id uuid, p_ranges jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_batch public.dialpad_recording_vad_batches%rowtype;
  v_total public.dialpad_recording_vad_totals%rowtype;
  v_item jsonb;
  v_start numeric;
  v_end numeric;
  v_count integer;
  v_hash text;
  v_status text;
  v_latch public.dialpad_recording_vad_threshold_latches%rowtype;
  v_cross_epoch smallint;
  v_cross_start bigint;
  v_cross_end bigint;
  v_cross_evidence text;
  v_high_epoch smallint;
  v_high_end bigint;
begin
  if p_org_id is null or p_capture_id is null or p_track <> 'tab'
     or p_epoch is null or p_epoch not between 1 and 16 or p_batch_id is null
     or p_ranges is null or jsonb_typeof(p_ranges) <> 'array' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_ranges);
  if v_count > 256 then raise exception 'TOO_MANY_VAD_RANGES' using errcode = '22023'; end if;
  for v_item in select value from jsonb_array_elements(p_ranges) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'startSample') <> 'number'
       or jsonb_typeof(v_item->'endSample') <> 'number'
       or jsonb_typeof(v_item->'evidenceRef') <> 'string' then
      raise exception 'INVALID_VAD_RANGE' using errcode = '22023';
    end if;
    v_start := (v_item->>'startSample')::numeric;
    v_end := (v_item->>'endSample')::numeric;
    if v_start <> trunc(v_start) or v_end <> trunc(v_end)
       or v_start < 0 or v_end <= v_start or v_end > 1000000000000
       or length(v_item->>'evidenceRef') not between 1 and 256 then
      raise exception 'INVALID_VAD_RANGE' using errcode = '22023';
    end if;
  end loop;

  select * into v_capture from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id for share;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_capture.status not in ('open', 'closing', 'sealing') then
    raise exception 'CAPTURE_NOT_ACCEPTING' using errcode = '55000', detail = v_capture.status;
  end if;
  if not exists (select 1 from public.dialpad_recording_ingest_grants g
                  where g.capture_id = p_capture_id and g.epoch = p_epoch and g.consumed_at is not null) then
    raise exception 'EPOCH_NOT_AUTHORIZED' using errcode = '42501', detail = 'epoch_not_authorized';
  end if;

  v_hash := encode(extensions.digest(convert_to(p_ranges::text, 'utf8'), 'sha256'), 'hex');
  select * into v_batch from public.dialpad_recording_vad_batches where batch_id = p_batch_id for update;
  if found then
    if v_batch.capture_id <> p_capture_id or v_batch.org_id <> p_org_id or v_batch.track <> p_track
       or v_batch.epoch <> p_epoch or v_batch.range_count <> v_count or v_batch.ranges_sha256 <> v_hash then
      raise exception 'VAD_BATCH_CONFLICT' using errcode = '40001', detail = 'vad_batch_conflict';
    end if;
    v_status := 'replayed';
  else
    insert into public.dialpad_recording_vad_batches
      (batch_id, capture_id, org_id, track, epoch, range_count, ranges_sha256)
    values (p_batch_id, p_capture_id, p_org_id, p_track, p_epoch, v_count, v_hash);
    insert into public.dialpad_recording_vad_ranges
      (capture_id, org_id, track, epoch, batch_id, range_index, start_sample, end_sample, evidence_ref)
    select p_capture_id, p_org_id, p_track, p_epoch, p_batch_id, (value.ordinality - 1)::smallint,
           (value.item->>'startSample')::bigint, (value.item->>'endSample')::bigint,
           value.item->>'evidenceRef'
      from jsonb_array_elements(p_ranges) with ordinality as value(item, ordinality);
    v_status := 'recorded';
  end if;

  insert into public.dialpad_recording_vad_totals (capture_id, org_id)
  values (p_capture_id, p_org_id) on conflict (capture_id) do nothing;
  select * into v_total from public.dialpad_recording_vad_totals where capture_id = p_capture_id for update;

  select coalesce(sum(upper(u.r) - lower(u.r)), 0)::bigint
    into v_total.voiced_samples
    from (
      select unnest(range_agg(int8range(r.start_sample, r.end_sample, '[)'))) as r
        from public.dialpad_recording_vad_ranges r
       where r.capture_id = p_capture_id and r.track = 'tab'
       group by r.epoch
    ) as u;

  with canonical as (
    select r.epoch, unnest(range_agg(int8range(r.start_sample, r.end_sample, '[)'))) as sample_range
      from public.dialpad_recording_vad_ranges r
     where r.capture_id = p_capture_id and r.track = 'tab'
     group by r.epoch
  ), ordered as (
    select epoch, lower(sample_range)::bigint as start_sample, upper(sample_range)::bigint as end_sample,
           sum((upper(sample_range) - lower(sample_range))::bigint)
             over (order by epoch, lower(sample_range), upper(sample_range)) as cumulative_samples
      from canonical
  )
  select epoch, start_sample, end_sample
    into v_cross_epoch, v_cross_start, v_cross_end
    from ordered
   where cumulative_samples > 4800000
     and cumulative_samples - (end_sample - start_sample) <= 4800000
   order by epoch, start_sample, end_sample
   limit 1;

  select latest.epoch, latest.end_sample
    into v_high_epoch, v_high_end
    from (
      select r.epoch, max(r.end_sample)::bigint as end_sample
        from public.dialpad_recording_vad_ranges r
       where r.capture_id = p_capture_id and r.track = 'tab'
       group by r.epoch
    ) latest
   order by latest.epoch desc
   limit 1;

  if v_cross_epoch is not null then
    select vr.evidence_ref into v_cross_evidence
      from public.dialpad_recording_vad_ranges vr
     where vr.capture_id = p_capture_id and vr.track = 'tab'
       and vr.epoch = v_cross_epoch
       and vr.start_sample <= v_cross_start and vr.end_sample > v_cross_start
     order by vr.start_sample, vr.end_sample, vr.recorded_at
     limit 1;
  end if;

  update public.dialpad_recording_vad_totals
     set voiced_samples = v_total.voiced_samples,
         high_water_epoch = v_high_epoch,
         high_water_end_sample = v_high_end,
         updated_at = now()
   where capture_id = p_capture_id;
  v_total.high_water_epoch := v_high_epoch;
  v_total.high_water_end_sample := v_high_end;

  if v_cross_epoch is not null then
    insert into public.dialpad_recording_vad_threshold_latches
      (capture_id, org_id, crossing_total_samples, crossing_epoch, crossing_start_sample,
       crossing_end_sample, evidence_ref)
    values (p_capture_id, p_org_id, 4800001, v_cross_epoch, v_cross_start, v_cross_end,
            coalesce(v_cross_evidence, 'vad:union'))
    on conflict (capture_id) do nothing;
  end if;
  select * into v_latch from public.dialpad_recording_vad_threshold_latches where capture_id = p_capture_id;

  return jsonb_build_object(
    'status', v_status, 'captureId', p_capture_id, 'track', p_track, 'epoch', p_epoch,
    'batchId', p_batch_id, 'rangeCount', v_count, 'voicedSamples', v_total.voiced_samples,
    'measurementStatus', v_total.measurement_status,
    'highWaterEpoch', v_total.high_water_epoch, 'highWaterEndSample', v_total.high_water_end_sample,
    'threshold', case when v_latch.capture_id is null then
      jsonb_build_object('status', 'not_latched', 'thresholdSamples', 4800000)
      else jsonb_build_object('status', 'latched', 'thresholdSamples', v_latch.threshold_samples,
        'crossingTotalSamples', v_latch.crossing_total_samples, 'crossingEpoch', v_latch.crossing_epoch,
        'crossingStartSample', v_latch.crossing_start_sample, 'crossingEndSample', v_latch.crossing_end_sample,
        'evidenceRef', v_latch.evidence_ref, 'latchedAt', v_latch.latched_at) end
  );
end;
$$;

-- VAD batches/ranges/latches are append-only evidence. The totals row is
-- updated only inside the security-definer RPC, and its finalizer fields stay
-- available for a later server-owned timing decision.
create or replace function public.dialpad_recording_guard_vad_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% rows are immutable evidence', tg_table_name using errcode = '42501';
end;
$$;

drop trigger if exists dialpad_recording_vad_batches_guard on public.dialpad_recording_vad_batches;
create trigger dialpad_recording_vad_batches_guard
  before update or delete on public.dialpad_recording_vad_batches
  for each row execute function public.dialpad_recording_guard_vad_append_only();
drop trigger if exists dialpad_recording_vad_ranges_guard on public.dialpad_recording_vad_ranges;
create trigger dialpad_recording_vad_ranges_guard
  before update or delete on public.dialpad_recording_vad_ranges
  for each row execute function public.dialpad_recording_guard_vad_append_only();
drop trigger if exists dialpad_recording_vad_latches_guard on public.dialpad_recording_vad_threshold_latches;
create trigger dialpad_recording_vad_latches_guard
  before update or delete on public.dialpad_recording_vad_threshold_latches
  for each row execute function public.dialpad_recording_guard_vad_append_only();

alter table public.dialpad_recording_vad_batches enable row level security;
alter table public.dialpad_recording_vad_ranges enable row level security;
alter table public.dialpad_recording_vad_totals enable row level security;
alter table public.dialpad_recording_vad_threshold_latches enable row level security;
revoke all on table public.dialpad_recording_vad_batches from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_vad_ranges from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_vad_totals from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_vad_threshold_latches from public, anon, authenticated, service_role;
grant select on public.dialpad_recording_vad_batches to service_role;
grant select on public.dialpad_recording_vad_ranges to service_role;
grant select on public.dialpad_recording_vad_totals to service_role;
grant select on public.dialpad_recording_vad_threshold_latches to service_role;

revoke all on function public.fn_mark_dialpad_recording_eof(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_recording_lifecycle(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_recording_seal_inputs(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_record_dialpad_recording_vad_ranges(uuid, uuid, text, integer, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.dialpad_recording_guard_vad_append_only() from public, anon, authenticated, service_role;
grant execute on function public.fn_mark_dialpad_recording_eof(uuid, uuid, text, integer, integer, text) to service_role;
grant execute on function public.fn_get_dialpad_recording_lifecycle(uuid, uuid) to service_role;
grant execute on function public.fn_get_dialpad_recording_seal_inputs(uuid, uuid) to service_role;
grant execute on function public.fn_record_dialpad_recording_vad_ranges(uuid, uuid, text, integer, uuid, jsonb) to service_role;

commit;
