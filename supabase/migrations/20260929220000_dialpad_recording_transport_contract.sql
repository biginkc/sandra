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

-- Every transport writer reaches the same terminal observation boundary. A
-- signed call end therefore closes an otherwise-open capture before live or
-- drain acceptance is evaluated, while the foundation close RPC supplies the
-- single durable 30-second deadline.
create or replace function public.dialpad_recording_refresh_terminal_capture(
  p_org_id uuid, p_capture_id uuid
) returns public.dialpad_recording_captures
language plpgsql security definer volatile set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
begin
  select * into v_capture
    from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id
   for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_capture.status = 'open' and exists (
    select 1 from public.call_activities a
     where a.id = v_capture.call_activity_id and a.ended_at is not null
  ) then
    perform public.fn_close_dialpad_recording_capture(p_org_id, p_capture_id, null, 'call_ended');
    select * into v_capture from public.dialpad_recording_captures where id = p_capture_id and org_id = p_org_id;
  end if;
  return v_capture;
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

  v_capture := public.dialpad_recording_refresh_terminal_capture(p_org_id, p_capture_id);
  if v_capture.status <> 'open'
     and not (v_capture.status = 'closing' and v_capture.drain_deadline_at is not null and v_capture.drain_deadline_at > now()) then
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

  v_capture := public.dialpad_recording_refresh_terminal_capture(p_org_id, p_capture_id);
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
  if v_capture.status <> 'open'
     and not (v_capture.status = 'closing' and v_capture.drain_deadline_at is not null and v_capture.drain_deadline_at > now()) then
    raise exception 'CAPTURE_NOT_ACCEPTING' using errcode = '55000', detail = v_capture.status;
  end if;
  if not exists (select 1 from public.dialpad_recording_ingest_grants g
                  where g.capture_id = p_capture_id and g.epoch = p_epoch and g.consumed_at is not null) then
    raise exception 'EPOCH_NOT_AUTHORIZED' using errcode = '42501', detail = 'epoch_not_authorized';
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
language plpgsql security definer volatile set search_path = '' as $$
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
  -- A terminal lifecycle read is the observation boundary for workers. Close
  -- through the foundation machinery once so the drain deadline is durable
  -- even when no sealer has polled yet.
  if v_capture.status = 'open' and v_call_state = 'ended' then
    v_capture := public.dialpad_recording_refresh_terminal_capture(p_org_id, p_capture_id);
  end if;
  v_live := v_capture.status = 'open' and v_call_state = 'connected';
  v_drain := v_capture.status = 'closing'
             and v_capture.drain_deadline_at is not null
             and v_capture.drain_deadline_at > now();
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
        'storagePath', c.storage_path,
        'isEof', coalesce(c.is_eof or (s.eof_seq = c.seq and s.eof_sha256 = c.sha256), false),
        'eofSha256', case when coalesce(c.is_eof or (s.eof_seq = c.seq and s.eof_sha256 = c.sha256), false)
                         then coalesce(s.eof_sha256, c.sha256) else null end
      ) order by c.epoch, case when c.track = 'tab' then 0 else 1 end, c.seq)
        from public.dialpad_recording_chunks c
        left join public.dialpad_recording_segments s
          on s.capture_id = c.capture_id and s.track = c.track and s.epoch = c.epoch
       where c.capture_id = v_capture.id
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
  -- Zero-based PCM coordinate of the first sample above threshold. A later
  -- Jitter meter reports an exclusive end, so its crossingSample maps here
  -- as (meter crossingSample - 1), or conversely this value plus one when
  -- exporting the meter's exclusive-end coordinate.
  crossing_sample bigint not null check (crossing_sample >= 0),
  crossing_start_sample bigint not null check (crossing_start_sample >= 0),
  crossing_end_sample bigint not null check (crossing_end_sample > crossing_start_sample),
  evidence_ref text not null check (length(evidence_ref) between 1 and 256),
  latched_at timestamptz not null default now(),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id)
);
alter table public.dialpad_recording_vad_threshold_latches
  add column if not exists crossing_sample bigint;
update public.dialpad_recording_vad_threshold_latches
   set crossing_sample = crossing_start_sample
 where crossing_sample is null;
alter table public.dialpad_recording_vad_threshold_latches
  alter column crossing_sample set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.dialpad_recording_vad_threshold_latches'::regclass
       and conname = 'dialpad_recording_vad_threshold_crossing_sample_check'
  ) then
    alter table public.dialpad_recording_vad_threshold_latches
      add constraint dialpad_recording_vad_threshold_crossing_sample_check check (crossing_sample >= 0);
  end if;
end;
$$;

-- The foundation migration's result registrar predates explicit EOF markers.
-- Rewrite only its chunk-evidence aggregate in place so a deployed foundation
-- receives the same authoritative segment EOF semantics without duplicating
-- the long claim-fenced registrar body here.
do $transport_register_patch$
declare
  v_definition text;
  v_patched text;
  v_old text := 'select count(*), coalesce(sum(size_bytes), 0), coalesce(max(seq), -1), bool_or(is_eof), max(seq) filter (where is_eof)';
  v_new text := 'select count(*), coalesce(sum(c.size_bytes), 0), coalesce(max(c.seq), -1), bool_or(coalesce(c.is_eof or (s.eof_seq = c.seq and s.eof_sha256 = c.sha256), false)), max(c.seq) filter (where coalesce(c.is_eof or (s.eof_seq = c.seq and s.eof_sha256 = c.sha256), false))';
begin
  select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_register_dialpad_recording_result'
     and p.pronargs = 4;
  if v_definition is null then raise exception 'missing recording result registrar'; end if;
  if position('bool_or(coalesce(c.is_eof' in v_definition) > 0 then return; end if;
  if position(v_old in v_definition) = 0 then raise exception 'recording result registrar EOF aggregate target was not found'; end if;
  if position('from public.dialpad_recording_chunks where capture_id = p_capture_id and track = v_track and epoch = v_epoch;' in v_definition) = 0 then raise exception 'recording result registrar chunk source target was not found'; end if;
  v_patched := replace(v_definition, v_old, v_new);
  v_patched := replace(v_patched,
    'from public.dialpad_recording_chunks where capture_id = p_capture_id and track = v_track and epoch = v_epoch;',
    'from public.dialpad_recording_chunks c left join public.dialpad_recording_segments s on s.capture_id = c.capture_id and s.track = c.track and s.epoch = c.epoch where c.capture_id = p_capture_id and c.track = v_track and c.epoch = v_epoch;');
  if v_patched = v_definition or position(v_new in v_patched) = 0 or position('from public.dialpad_recording_chunks c left join public.dialpad_recording_segments s' in v_patched) = 0 then raise exception 'recording result registrar EOF patch did not apply'; end if;
  execute v_patched;
end;
$transport_register_patch$;

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
  v_cross_sample bigint;
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

  -- Serialize all batches for a capture before checking identity. This keeps
  -- identical concurrent submissions on the replay path instead of racing a
  -- primary-key insert, while preserving one immutable batch row.
  v_capture := public.dialpad_recording_refresh_terminal_capture(p_org_id, p_capture_id);
  v_hash := encode(extensions.digest(convert_to(p_ranges::text, 'utf8'), 'sha256'), 'hex');
  select * into v_batch from public.dialpad_recording_vad_batches where batch_id = p_batch_id for update;
  if found then
    if v_batch.capture_id <> p_capture_id or v_batch.org_id <> p_org_id or v_batch.track <> p_track
       or v_batch.epoch <> p_epoch or v_batch.range_count <> v_count or v_batch.ranges_sha256 <> v_hash then
      raise exception 'VAD_BATCH_CONFLICT' using errcode = '40001', detail = 'vad_batch_conflict';
    end if;
    v_status := 'replayed';
  else
    if v_capture.status <> 'open'
       and not (v_capture.status = 'closing' and v_capture.drain_deadline_at is not null and v_capture.drain_deadline_at > now()) then
      raise exception 'CAPTURE_NOT_ACCEPTING' using errcode = '55000', detail = v_capture.status;
    end if;
    if not exists (select 1 from public.dialpad_recording_ingest_grants g
                    where g.capture_id = p_capture_id and g.epoch = p_epoch and g.consumed_at is not null) then
      raise exception 'EPOCH_NOT_AUTHORIZED' using errcode = '42501', detail = 'epoch_not_authorized';
    end if;
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
    select epoch, start_sample, end_sample,
           (4800000 - (cumulative_samples - (end_sample - start_sample)))::bigint + start_sample
      into v_cross_epoch, v_cross_start, v_cross_end, v_cross_sample
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
       and vr.start_sample <= v_cross_sample and vr.end_sample > v_cross_sample
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
      (capture_id, org_id, crossing_total_samples, crossing_epoch, crossing_sample, crossing_start_sample,
       crossing_end_sample, evidence_ref)
    values (p_capture_id, p_org_id, 4800001, v_cross_epoch, v_cross_sample, v_cross_start, v_cross_end,
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
        'crossingSample', v_latch.crossing_sample,
        'crossingStartSample', v_latch.crossing_start_sample, 'crossingEndSample', v_latch.crossing_end_sample,
        'evidenceRef', v_latch.evidence_ref, 'latchedAt', v_latch.latched_at) end
  );
end;
$$;

-- Batched PCM continuity evidence is intentionally separate from voiced VAD
-- ranges. It records what the ingest worker processed, including silence,
-- reconnect/gap observations and an explicit EOF, without accepting a
-- browser-maintained cumulative seller total.
create table if not exists public.dialpad_recording_pcm_batches (
  batch_id uuid primary key,
  capture_id uuid not null,
  org_id uuid not null,
  track text not null check (track in ('tab', 'mic')),
  epoch smallint not null check (epoch between 1 and 16),
  processed_through_sample bigint not null check (processed_through_sample between 0 and 1000000000000),
  pcm_eof_sample bigint,
  source_sample_rate_hz integer,
  source_channels smallint,
  source_codec text,
  degraded_reasons jsonb not null default '[]'::jsonb,
  batch_sha256 text not null check (batch_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  check (pcm_eof_sample is null or (pcm_eof_sample between 0 and 1000000000000 and pcm_eof_sample <= processed_through_sample)),
  check ((source_sample_rate_hz is null and source_channels is null and source_codec is null)
      or (source_sample_rate_hz is not null and source_channels is not null and source_codec is not null
          and source_sample_rate_hz between 8000 and 192000 and source_channels between 1 and 2
          and source_codec ~ '^[a-z0-9_.-]{1,64}$')),
  check (jsonb_typeof(degraded_reasons) = 'array' and jsonb_array_length(degraded_reasons) <= 64),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id)
);

create table if not exists public.dialpad_recording_pcm_progress (
  capture_id uuid not null,
  org_id uuid not null,
  track text not null check (track in ('tab', 'mic')),
  epoch smallint not null check (epoch between 1 and 16),
  processed_through_sample bigint not null default 0 check (processed_through_sample between 0 and 1000000000000),
  pcm_eof_sample bigint,
  source_sample_rate_hz integer,
  source_channels smallint,
  source_codec text,
  degraded_reasons jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (capture_id, track, epoch),
  check (pcm_eof_sample is null or (pcm_eof_sample between 0 and 1000000000000 and pcm_eof_sample <= processed_through_sample)),
  check ((source_sample_rate_hz is null and source_channels is null and source_codec is null)
      or (source_sample_rate_hz is not null and source_channels is not null and source_codec is not null
          and source_sample_rate_hz between 8000 and 192000 and source_channels between 1 and 2
          and source_codec ~ '^[a-z0-9_.-]{1,64}$')),
  check (jsonb_typeof(degraded_reasons) = 'array' and jsonb_array_length(degraded_reasons) <= 64),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures (id, org_id)
);

comment on table public.dialpad_recording_pcm_batches is
  'Immutable, service-owned batched PCM continuity evidence; processed samples include silence and never come from a browser cumulative total.';
comment on table public.dialpad_recording_pcm_progress is
  'Monotonic per-track/epoch normalized PCM boundary, PCM EOF sample, source format and accumulated degradation reasons used to resume ingest safely.';

do $$
begin
  alter table public.dialpad_recording_pcm_batches drop constraint if exists dialpad_recording_pcm_batches_source_format_check;
  alter table public.dialpad_recording_pcm_progress drop constraint if exists dialpad_recording_pcm_progress_source_format_check;
  if not exists (select 1 from pg_constraint where conrelid = 'public.dialpad_recording_pcm_batches'::regclass and conname = 'dialpad_recording_pcm_batches_eof_sample_check') then
    alter table public.dialpad_recording_pcm_batches add constraint dialpad_recording_pcm_batches_eof_sample_check check (pcm_eof_sample is null or (pcm_eof_sample between 0 and 1000000000000 and pcm_eof_sample <= processed_through_sample));
  end if;
  alter table public.dialpad_recording_pcm_batches add constraint dialpad_recording_pcm_batches_source_format_check check ((source_sample_rate_hz is null and source_channels is null and source_codec is null) or (source_sample_rate_hz is not null and source_channels is not null and source_codec is not null and source_sample_rate_hz between 8000 and 192000 and source_channels between 1 and 2 and source_codec ~ '^[a-z0-9_.-]{1,64}$'));
  if not exists (select 1 from pg_constraint where conrelid = 'public.dialpad_recording_pcm_progress'::regclass and conname = 'dialpad_recording_pcm_progress_eof_sample_check') then
    alter table public.dialpad_recording_pcm_progress add constraint dialpad_recording_pcm_progress_eof_sample_check check (pcm_eof_sample is null or (pcm_eof_sample between 0 and 1000000000000 and pcm_eof_sample <= processed_through_sample));
  end if;
  alter table public.dialpad_recording_pcm_progress add constraint dialpad_recording_pcm_progress_source_format_check check ((source_sample_rate_hz is null and source_channels is null and source_codec is null) or (source_sample_rate_hz is not null and source_channels is not null and source_codec is not null and source_sample_rate_hz between 8000 and 192000 and source_channels between 1 and 2 and source_codec ~ '^[a-z0-9_.-]{1,64}$'));
end;
$$;

drop function if exists public.fn_record_dialpad_recording_pcm_progress(uuid, uuid, text, integer, uuid, bigint, integer, text, jsonb);
create or replace function public.fn_record_dialpad_recording_pcm_progress(
  p_org_id uuid, p_capture_id uuid, p_track text, p_epoch integer, p_batch_id uuid,
  p_processed_through_sample bigint, p_pcm_eof_sample bigint default null,
  p_source_sample_rate_hz integer default null, p_source_channels integer default null,
  p_source_codec text default null, p_degraded_reasons jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_batch public.dialpad_recording_pcm_batches%rowtype;
  v_progress public.dialpad_recording_pcm_progress%rowtype;
  v_hash text;
  v_reasons jsonb;
  v_status text;
begin
  p_degraded_reasons := coalesce(p_degraded_reasons, '[]'::jsonb);
  if p_org_id is null or p_capture_id is null or p_track not in ('tab', 'mic')
     or p_epoch is null or p_epoch not between 1 and 16 or p_batch_id is null
     or p_processed_through_sample is null or p_processed_through_sample not between 0 and 1000000000000
     or p_pcm_eof_sample is not null and (p_pcm_eof_sample not between 0 and 1000000000000 or p_pcm_eof_sample <> p_processed_through_sample)
     or not ((p_source_sample_rate_hz is null and p_source_channels is null and p_source_codec is null)
             or (p_source_sample_rate_hz is not null and p_source_channels is not null and p_source_codec is not null
                 and p_source_sample_rate_hz between 8000 and 192000 and p_source_channels between 1 and 2
                 and p_source_codec ~ '^[a-z0-9_.-]{1,64}$'))
     or jsonb_typeof(p_degraded_reasons) <> 'array'
     or jsonb_array_length(p_degraded_reasons) > 64
     or exists (select 1 from jsonb_array_elements(p_degraded_reasons) r where jsonb_typeof(r) <> 'string' or length(r #>> '{}') not between 1 and 64 or r #>> '{}' !~ '^[a-z0-9_]+$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'captureId', p_capture_id, 'track', p_track, 'epoch', p_epoch,
    'processedThroughSample', p_processed_through_sample,
    'pcmEofSample', p_pcm_eof_sample,
    'sourceSampleRateHz', p_source_sample_rate_hz, 'sourceChannels', p_source_channels, 'sourceCodec', p_source_codec,
    'degradedReasons', p_degraded_reasons
  )::text, 'utf8'), 'sha256'), 'hex');

  -- The capture row is the serialization point for both immutable batch
  -- identity and the mutable resume snapshot.
  v_capture := public.dialpad_recording_refresh_terminal_capture(p_org_id, p_capture_id);

  select * into v_batch from public.dialpad_recording_pcm_batches
   where batch_id = p_batch_id for update;
  if found then
    if v_batch.capture_id <> p_capture_id or v_batch.org_id <> p_org_id or v_batch.track <> p_track
       or v_batch.epoch <> p_epoch or v_batch.processed_through_sample <> p_processed_through_sample
       or v_batch.pcm_eof_sample is distinct from p_pcm_eof_sample
       or v_batch.source_sample_rate_hz is distinct from p_source_sample_rate_hz
       or v_batch.source_channels is distinct from p_source_channels
       or v_batch.source_codec is distinct from p_source_codec
       or v_batch.degraded_reasons <> p_degraded_reasons or v_batch.batch_sha256 <> v_hash then
      raise exception 'PCM_BATCH_CONFLICT' using errcode = '40001', detail = 'pcm_batch_conflict';
    end if;
    v_status := 'replayed';
  else
    if v_capture.status <> 'open'
       and not (v_capture.status = 'closing' and v_capture.drain_deadline_at is not null and v_capture.drain_deadline_at > now()) then
      raise exception 'CAPTURE_NOT_ACCEPTING' using errcode = '55000', detail = v_capture.status;
    end if;
    if not exists (select 1 from public.dialpad_recording_ingest_grants g
                    where g.capture_id = p_capture_id and g.epoch = p_epoch and g.consumed_at is not null) then
      raise exception 'EPOCH_NOT_AUTHORIZED' using errcode = '42501', detail = 'epoch_not_authorized';
    end if;
    insert into public.dialpad_recording_pcm_batches
      (batch_id, capture_id, org_id, track, epoch, processed_through_sample, pcm_eof_sample, source_sample_rate_hz, source_channels, source_codec, degraded_reasons, batch_sha256)
    values (p_batch_id, p_capture_id, p_org_id, p_track, p_epoch, p_processed_through_sample, p_pcm_eof_sample, p_source_sample_rate_hz, p_source_channels, p_source_codec, p_degraded_reasons, v_hash);
    v_status := 'recorded';
  end if;

  select * into v_progress from public.dialpad_recording_pcm_progress
   where capture_id = p_capture_id and track = p_track and epoch = p_epoch for update;
  if not found then
    insert into public.dialpad_recording_pcm_progress
      (capture_id, org_id, track, epoch, processed_through_sample, pcm_eof_sample, source_sample_rate_hz, source_channels, source_codec, degraded_reasons)
    values (p_capture_id, p_org_id, p_track, p_epoch, p_processed_through_sample, p_pcm_eof_sample, p_source_sample_rate_hz, p_source_channels, p_source_codec, p_degraded_reasons)
    returning * into v_progress;
  elsif v_status = 'recorded' then
    if p_processed_through_sample < v_progress.processed_through_sample
       or (v_progress.pcm_eof_sample is not null and p_processed_through_sample <> v_progress.pcm_eof_sample)
       or (v_progress.pcm_eof_sample is not null and p_pcm_eof_sample is distinct from v_progress.pcm_eof_sample)
       or (v_progress.source_sample_rate_hz is not null and (p_source_sample_rate_hz is distinct from v_progress.source_sample_rate_hz or p_source_channels is distinct from v_progress.source_channels or p_source_codec is distinct from v_progress.source_codec)) then
      raise exception 'PCM_PROGRESS_CONFLICT' using errcode = '40001', detail = 'pcm_progress_regressed';
    end if;
    select coalesce(jsonb_agg(reason order by reason), '[]'::jsonb) into v_reasons
      from (select distinct r.reason from jsonb_array_elements(v_progress.degraded_reasons || p_degraded_reasons) as r(reason)) reasons;
    update public.dialpad_recording_pcm_progress
       set processed_through_sample = greatest(processed_through_sample, p_processed_through_sample),
           pcm_eof_sample = coalesce(pcm_eof_sample, p_pcm_eof_sample),
           source_sample_rate_hz = coalesce(source_sample_rate_hz, p_source_sample_rate_hz),
           source_channels = coalesce(source_channels, p_source_channels),
           source_codec = coalesce(source_codec, p_source_codec),
           degraded_reasons = v_reasons, updated_at = now()
     where capture_id = p_capture_id and track = p_track and epoch = p_epoch
     returning * into v_progress;
  end if;

  return jsonb_build_object(
    'status', v_status, 'captureId', p_capture_id, 'track', p_track, 'epoch', p_epoch,
    'batchId', p_batch_id, 'processedThroughSample', v_progress.processed_through_sample,
    'pcmEofSample', v_progress.pcm_eof_sample,
    'sourceSampleRateHz', v_progress.source_sample_rate_hz, 'sourceChannels', v_progress.source_channels, 'sourceCodec', v_progress.source_codec,
    'normalizedSampleRateHz', 16000, 'normalizedChannels', 1,
    'degradedReasons', v_progress.degraded_reasons
  );
end;
$$;

-- Once transport measurement evidence has started, a retention-complete
-- capture is not claimable until every consumed epoch has durable normalized
-- PCM EOF at its processed boundary on both tracks. This closes the race
-- between retention EOF and a final VAD/PCM flush. Deadline expiry still
-- permits partial artifact classification with its missing continuity evidence
-- left degraded/provisional.
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
            exists (select 1 from public.dialpad_recording_ingest_grants g where g.capture_id = c.id and g.consumed_at is not null)
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
            and not exists (
              select 1
                from (
                  select distinct g.epoch
                    from public.dialpad_recording_ingest_grants g
                   where g.capture_id = c.id and g.consumed_at is not null
                ) epochs
                cross join (values ('tab'::text), ('mic'::text)) expected(track)
                left join public.dialpad_recording_pcm_progress p
                  on p.capture_id = c.id and p.epoch = epochs.epoch and p.track = expected.track
                 and p.pcm_eof_sample is not null
                 and p.processed_through_sample = p.pcm_eof_sample
               where p.capture_id is null
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
         set status = 'failed', result_at = now(), failure_code = 'seal_attempts_exhausted'
       where id = v_capture.id;
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

create or replace function public.fn_get_dialpad_recording_vad_snapshot(
  p_org_id uuid, p_capture_id uuid
) returns jsonb
language plpgsql security definer stable set search_path = '' as $$
declare
  v_total public.dialpad_recording_vad_totals%rowtype;
  v_latch public.dialpad_recording_vad_threshold_latches%rowtype;
  v_capture public.dialpad_recording_captures%rowtype;
  v_reasons jsonb;
begin
  select * into v_capture from public.dialpad_recording_captures where id = p_capture_id and org_id = p_org_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into v_total from public.dialpad_recording_vad_totals where capture_id = p_capture_id;
  select * into v_latch from public.dialpad_recording_vad_threshold_latches where capture_id = p_capture_id;
  select coalesce(jsonb_agg(reason order by reason), '[]'::jsonb) into v_reasons
    from (select distinct r.reason from public.dialpad_recording_pcm_progress p,
          jsonb_array_elements(p.degraded_reasons) as r(reason)
          where p.capture_id = p_capture_id) reasons;
  return jsonb_build_object(
    'version', 1, 'captureId', p_capture_id,
    'totalSamples', coalesce(v_total.voiced_samples, 0),
    'measurementStatus', coalesce(v_total.measurement_status, 'provisional'),
    'epoch', v_total.high_water_epoch,
    'epochCreditedThrough', v_total.high_water_end_sample,
    'crossing', case when v_latch.capture_id is null then null else jsonb_build_object(
      'status', 'latched', 'thresholdSamples', v_latch.threshold_samples,
      'crossingTotalSamples', v_latch.crossing_total_samples, 'crossingEpoch', v_latch.crossing_epoch,
      'crossingSample', v_latch.crossing_sample, 'crossingStartSample', v_latch.crossing_start_sample,
      'crossingEndSample', v_latch.crossing_end_sample, 'evidenceRef', v_latch.evidence_ref,
      'latchedAt', v_latch.latched_at) end,
    'processedPcm', coalesce((select jsonb_agg(jsonb_build_object(
      'track', p.track, 'epoch', p.epoch, 'processedThroughSample', p.processed_through_sample,
      'pcmEofSample', p.pcm_eof_sample,
      'sourceSampleRateHz', p.source_sample_rate_hz, 'sourceChannels', p.source_channels, 'sourceCodec', p.source_codec,
      'normalizedSampleRateHz', 16000, 'normalizedChannels', 1,
      'degradedReasons', p.degraded_reasons
    ) order by p.track, p.epoch) from public.dialpad_recording_pcm_progress p where p.capture_id = p_capture_id), '[]'::jsonb),
    'degradedReasons', v_reasons
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
drop trigger if exists dialpad_recording_pcm_batches_guard on public.dialpad_recording_pcm_batches;
create trigger dialpad_recording_pcm_batches_guard
  before update or delete on public.dialpad_recording_pcm_batches
  for each row execute function public.dialpad_recording_guard_vad_append_only();

alter table public.dialpad_recording_vad_batches enable row level security;
alter table public.dialpad_recording_vad_ranges enable row level security;
alter table public.dialpad_recording_vad_totals enable row level security;
alter table public.dialpad_recording_vad_threshold_latches enable row level security;
alter table public.dialpad_recording_pcm_batches enable row level security;
alter table public.dialpad_recording_pcm_progress enable row level security;
revoke all on table public.dialpad_recording_vad_batches from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_vad_ranges from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_vad_totals from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_vad_threshold_latches from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_pcm_batches from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_pcm_progress from public, anon, authenticated, service_role;
grant select on public.dialpad_recording_vad_batches to service_role;
grant select on public.dialpad_recording_vad_ranges to service_role;
grant select on public.dialpad_recording_vad_totals to service_role;
grant select on public.dialpad_recording_vad_threshold_latches to service_role;
grant select on public.dialpad_recording_pcm_batches to service_role;
grant select on public.dialpad_recording_pcm_progress to service_role;

revoke all on function public.fn_mark_dialpad_recording_eof(uuid, uuid, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_recording_lifecycle(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_recording_seal_inputs(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_record_dialpad_recording_vad_ranges(uuid, uuid, text, integer, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.dialpad_recording_refresh_terminal_capture(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fn_record_dialpad_recording_pcm_progress(uuid, uuid, text, integer, uuid, bigint, bigint, integer, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_recording_vad_snapshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.dialpad_recording_guard_vad_append_only() from public, anon, authenticated, service_role;
grant execute on function public.fn_mark_dialpad_recording_eof(uuid, uuid, text, integer, integer, text) to service_role;
grant execute on function public.fn_get_dialpad_recording_lifecycle(uuid, uuid) to service_role;
grant execute on function public.fn_get_dialpad_recording_seal_inputs(uuid, uuid) to service_role;
grant execute on function public.fn_record_dialpad_recording_vad_ranges(uuid, uuid, text, integer, uuid, jsonb) to service_role;
grant execute on function public.fn_record_dialpad_recording_pcm_progress(uuid, uuid, text, integer, uuid, bigint, bigint, integer, integer, text, jsonb) to service_role;
grant execute on function public.fn_get_dialpad_recording_vad_snapshot(uuid, uuid) to service_role;

commit;
