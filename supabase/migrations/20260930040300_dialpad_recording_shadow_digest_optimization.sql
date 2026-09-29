-- Optimize immutable shadow VAD digesting for long fragmented captures.
-- Every canonical row, its order, and the freshness coverage remain intact;
-- long captures use one ordered aggregate instead of per-row PL/pgSQL hashing.
begin;

create or replace function public.dialpad_recording_shadow_input_base(p_org_id uuid, p_capture_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_intent public.dialpad_call_intents%rowtype;
  v_state bytea;
  v_row jsonb;
  v_text text;
  v_grant_count bigint;
  v_grant_digest text;
  v_grants jsonb := '[]'::jsonb;
  v_segment_count bigint;
  v_segment_digest text;
  v_chunk_count bigint;
  v_chunk_digest text;
  v_final_count bigint;
  v_final_digest text;
  v_vad_batch_count bigint;
  v_vad_batch_digest text;
  v_vad_range_count bigint;
  v_vad_range_digest text;
  v_pcm_batch_count bigint;
  v_pcm_batch_digest text;
  v_pcm_progress_count bigint;
  v_pcm_progress_digest text;
  v_total_count bigint;
  v_total_digest text;
  v_event_count bigint;
  v_event_digest text;
  v_observed bigint := 0;
  v_observed_by_epoch jsonb := '{}'::jsonb;
  v_vad_total bigint;
  v_consumed_epochs bigint;
  v_connected_min bigint;
  v_connected_max bigint;
  v_ended_min bigint;
  v_ended_max bigint;
  v_connected_values bigint;
  v_ended_values bigint;
  v_activity_provider text;
  v_activity_provider_call_id text;
  v_boundary_count bigint := 0;
  v_provider_call_count bigint;
  v_transfer boolean;
  v_event_conflict boolean;
  v_event_unresolved boolean;
  v_candidates jsonb := '[]'::jsonb;
  v_candidate jsonb;
  v_manifest jsonb;
  v_reasons text[] := array['timing_mapping_missing'];
  v_reason_json jsonb;
  v_evidence_status text;
  r record;
begin
  if p_org_id is null or p_capture_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into v_capture
    from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_capture.status not in ('sealed', 'partial', 'failed') then
    raise exception 'CAPTURE_NOT_TERMINAL' using errcode = '55000', detail = 'capture_not_terminal';
  end if;

  select provider, provider_call_id
    into v_activity_provider, v_activity_provider_call_id
    from public.call_activities
   where id = v_capture.call_activity_id and org_id = v_capture.org_id;
  if not found or v_activity_provider <> 'dialpad' or v_activity_provider_call_id is distinct from v_capture.provider_call_id then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'provider_evidence_unresolved');
  end if;

  select * into v_intent
    from public.dialpad_call_intents
   where id = v_capture.intent_id and org_id = v_capture.org_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:consumed-grants', 'utf8'), 'sha256');
  v_grant_count := 0;
  for r in
    select id, epoch, consumed_at
      from public.dialpad_recording_ingest_grants
     where capture_id = p_capture_id and org_id = p_org_id and consumed_at is not null
     order by epoch, id
  loop
    v_row := jsonb_build_object('grantId', r.id, 'epoch', r.epoch, 'consumedAt', r.consumed_at);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_grant_count := v_grant_count + 1;
    v_grants := v_grants || jsonb_build_array(jsonb_build_object('epoch', r.epoch));
  end loop;
  v_grant_digest := encode(v_state, 'hex');

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:segments', 'utf8'), 'sha256');
  v_segment_count := 0;
  for r in
    select track, epoch, chunk_count, total_bytes, max_seq, eof_seq, eof_sha256, eof_marked_at
      from public.dialpad_recording_segments
     where capture_id = p_capture_id and org_id = p_org_id
     order by epoch, track
  loop
    v_row := jsonb_build_object('track', r.track, 'epoch', r.epoch, 'chunkCount', r.chunk_count,
      'totalBytes', r.total_bytes, 'maxSeq', r.max_seq, 'eofSeq', r.eof_seq,
      'eofSha256', r.eof_sha256, 'eofMarkedAt', r.eof_marked_at);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_segment_count := v_segment_count + 1;
  end loop;
  v_segment_digest := encode(v_state, 'hex');

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:chunks', 'utf8'), 'sha256');
  v_chunk_count := 0;
  for r in
    select track, epoch, seq, size_bytes, sha256, is_eof, storage_path
      from public.dialpad_recording_chunks
     where capture_id = p_capture_id and org_id = p_org_id
     order by epoch, track, seq
  loop
    v_row := jsonb_build_object('track', r.track, 'epoch', r.epoch, 'seq', r.seq,
      'sizeBytes', r.size_bytes, 'sha256', r.sha256, 'isEof', r.is_eof, 'storagePath', r.storage_path);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_chunk_count := v_chunk_count + 1;
  end loop;
  v_chunk_digest := encode(v_state, 'hex');

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:track-finals', 'utf8'), 'sha256');
  v_final_count := 0;
  for r in
    select track, epoch, completeness, decode_ok, eof_verified, contiguous, source_chunk_count,
           source_bytes, source_last_seq, storage_path, size_bytes, sha256, codec, sample_rate_hz,
           channels, decoded_duration_ms, partial_reason
      from public.dialpad_recording_track_finals
     where capture_id = p_capture_id and org_id = p_org_id
     order by epoch, track
  loop
    v_row := jsonb_build_object('track', r.track, 'epoch', r.epoch, 'completeness', r.completeness,
      'decodeOk', r.decode_ok, 'eofVerified', r.eof_verified, 'contiguous', r.contiguous,
      'sourceChunkCount', r.source_chunk_count, 'sourceBytes', r.source_bytes,
      'sourceLastSeq', r.source_last_seq, 'storagePath', r.storage_path, 'sizeBytes', r.size_bytes,
      'sha256', r.sha256, 'codec', r.codec, 'sampleRateHz', r.sample_rate_hz,
      'channels', r.channels, 'decodedDurationMs', r.decoded_duration_ms, 'partialReason', r.partial_reason);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_final_count := v_final_count + 1;
  end loop;
  v_final_digest := encode(v_state, 'hex');

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:vad-batches', 'utf8'), 'sha256');
  v_vad_batch_count := 0;
  for r in
    select batch_id, track, epoch, range_count, ranges_sha256
      from public.dialpad_recording_vad_batches
     where capture_id = p_capture_id and org_id = p_org_id
     order by epoch, track, batch_id
  loop
    v_row := jsonb_build_object('batchId', r.batch_id, 'track', r.track, 'epoch', r.epoch,
      'rangeCount', r.range_count, 'rangesSha256', r.ranges_sha256);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_vad_batch_count := v_vad_batch_count + 1;
  end loop;
  v_vad_batch_digest := encode(v_state, 'hex');

  select count(*) into v_vad_range_count
    from public.dialpad_recording_vad_ranges
   where capture_id = p_capture_id and org_id = p_org_id;
  if v_vad_range_count <= 4096 then
    -- Preserve the established digest bytes for ordinary captures.
    v_state := extensions.digest(convert_to('provider-window-shadow-v1:vad-ranges', 'utf8'), 'sha256');
    for r in
      select track, epoch, batch_id, range_index, start_sample, end_sample, evidence_ref
        from public.dialpad_recording_vad_ranges
       where capture_id = p_capture_id and org_id = p_org_id
       order by epoch, track, batch_id, range_index
    loop
      v_row := jsonb_build_object('track', r.track, 'epoch', r.epoch, 'batchId', r.batch_id,
        'rangeIndex', r.range_index, 'startSample', r.start_sample, 'endSample', r.end_sample,
        'evidenceRef', r.evidence_ref);
      v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    end loop;
    v_vad_range_digest := encode(v_state, 'hex');
  else
    -- Long captures can contain hundreds of thousands of immutable fragments.
    -- Hash the complete canonical, length-prefixed ordered byte stream in one
    -- aggregate so freshness still covers every row while the database avoids
    -- one PL/pgSQL digest call per fragment.
    select encode(
      extensions.digest(
        convert_to('provider-window-shadow-v1:vad-ranges', 'utf8') || coalesce(string_agg(
            int4send(octet_length(row_text)) || convert_to(row_text, 'utf8'),
            ''::bytea order by epoch, track, batch_id, range_index
          ), ''::bytea),
        'sha256'
      ), 'hex')
      into v_vad_range_digest
      from (
        select track, epoch, batch_id, range_index,
               jsonb_build_object('track', track, 'epoch', epoch, 'batchId', batch_id,
                 'rangeIndex', range_index, 'startSample', start_sample, 'endSample', end_sample,
                 'evidenceRef', evidence_ref)::text as row_text
          from public.dialpad_recording_vad_ranges
         where capture_id = p_capture_id and org_id = p_org_id
      ) ordered_ranges;
  end if;

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:pcm-batches', 'utf8'), 'sha256');
  v_pcm_batch_count := 0;
  for r in
    select batch_id, track, epoch, processed_through_sample, pcm_eof_sample,
           source_sample_rate_hz, source_channels, source_codec, degraded_reasons, batch_sha256
      from public.dialpad_recording_pcm_batches
     where capture_id = p_capture_id and org_id = p_org_id
     order by epoch, track, batch_id
  loop
    v_row := jsonb_build_object('batchId', r.batch_id, 'track', r.track, 'epoch', r.epoch,
      'processedThroughSample', r.processed_through_sample, 'pcmEofSample', r.pcm_eof_sample,
      'sourceSampleRateHz', r.source_sample_rate_hz, 'sourceChannels', r.source_channels,
      'sourceCodec', r.source_codec, 'degradedReasons', r.degraded_reasons, 'batchSha256', r.batch_sha256);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_pcm_batch_count := v_pcm_batch_count + 1;
  end loop;
  v_pcm_batch_digest := encode(v_state, 'hex');

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:pcm-progress', 'utf8'), 'sha256');
  v_pcm_progress_count := 0;
  for r in
    select track, epoch, processed_through_sample, pcm_eof_sample, source_sample_rate_hz,
           source_channels, source_codec, degraded_reasons
      from public.dialpad_recording_pcm_progress
     where capture_id = p_capture_id and org_id = p_org_id
     order by epoch, track
  loop
    v_row := jsonb_build_object('track', r.track, 'epoch', r.epoch,
      'processedThroughSample', r.processed_through_sample, 'pcmEofSample', r.pcm_eof_sample,
      'sourceSampleRateHz', r.source_sample_rate_hz, 'sourceChannels', r.source_channels,
      'sourceCodec', r.source_codec, 'degradedReasons', r.degraded_reasons);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_pcm_progress_count := v_pcm_progress_count + 1;
  end loop;
  v_pcm_progress_digest := encode(v_state, 'hex');

  select coalesce(sum(upper(sample_range) - lower(sample_range)), 0)::bigint
    into v_observed
    from (
      select unnest(range_agg(int8range(vr.start_sample, vr.end_sample, '[)'))) as sample_range
        from public.dialpad_recording_vad_ranges vr
       where vr.capture_id = p_capture_id and vr.org_id = p_org_id and vr.track = 'tab'
       group by vr.epoch
    ) unioned;

  select coalesce(jsonb_object_agg(epoch::text, samples order by epoch), '{}'::jsonb)
    into v_observed_by_epoch
    from (
      select vr.epoch, coalesce(sum(upper(sample_range) - lower(sample_range)), 0)::bigint as samples
        from (
          select epoch, unnest(range_agg(int8range(start_sample, end_sample, '[)'))) as sample_range
            from public.dialpad_recording_vad_ranges
           where capture_id = p_capture_id and org_id = p_org_id and track = 'tab'
           group by epoch
        ) vr
       group by vr.epoch
       order by vr.epoch
    ) epochs;

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:vad-totals', 'utf8'), 'sha256');
  v_total_count := 0;
  for r in
    select voiced_samples, high_water_epoch, high_water_end_sample, measurement_status,
           provider_window_evidence, finalized_at
      from public.dialpad_recording_vad_totals
     where capture_id = p_capture_id and org_id = p_org_id
  loop
    v_row := jsonb_build_object('voicedSamples', r.voiced_samples, 'highWaterEpoch', r.high_water_epoch,
      'highWaterEndSample', r.high_water_end_sample, 'measurementStatus', r.measurement_status,
      'providerWindowEvidence', r.provider_window_evidence, 'finalizedAt', r.finalized_at);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_total_count := v_total_count + 1;
    v_vad_total := r.voiced_samples;
  end loop;
  v_total_digest := encode(v_state, 'hex');
  if v_vad_total is not null and v_vad_total <> v_observed then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'vad_totals_mismatch');
  end if;

  v_state := extensions.digest(convert_to('provider-window-shadow-v1:provider-events', 'utf8'), 'sha256');
  v_event_count := 0;
  for r in
    select e.id, e.provider_call_id, e.event_state, e.event_timestamp_ms, e.payload_sha256,
           e.signature_alg, e.secret_version, e.disposition, e.disposition_reason,
           e.matched_intent_id, e.conflicts_with_event_id, coalesce(max(m.change_id), 0) as latest_change_id
      from public.dialpad_call_events e
      left join public.dialpad_recording_shadow_event_changes m
        on m.event_id = e.id and m.org_id = e.org_id
     where e.org_id = p_org_id
       and e.id in (select event_id from public.dialpad_recording_shadow_relevant_events(p_org_id, p_capture_id))
     group by e.id, e.provider_call_id, e.event_state, e.event_timestamp_ms, e.payload_sha256,
              e.signature_alg, e.secret_version, e.disposition, e.disposition_reason,
              e.matched_intent_id, e.conflicts_with_event_id
     order by e.id
  loop
    v_row := jsonb_build_object('id', r.id, 'providerCallId', r.provider_call_id,
      'eventState', r.event_state, 'eventTimestampMs', r.event_timestamp_ms,
      'payloadSha256', r.payload_sha256, 'signatureAlg', r.signature_alg,
      'secretVersion', r.secret_version, 'disposition', r.disposition,
      'dispositionReason', r.disposition_reason, 'matchedIntentId', r.matched_intent_id,
      'conflictsWithEventId', r.conflicts_with_event_id, 'latestChangeId', r.latest_change_id);
    v_state := public.dialpad_recording_shadow_fold_step(v_state, v_row);
    v_event_count := v_event_count + 1;
  end loop;
  v_event_digest := encode(v_state, 'hex');

  select count(distinct e.provider_call_id),
         coalesce(bool_or(e.payload ->> 'is_transferred' = 'true'), false),
         coalesce(bool_or(e.disposition = 'conflict' or e.conflicts_with_event_id is not null), false),
         coalesce(bool_or(e.disposition not in ('matched', 'conflict')), false)
    into v_provider_call_count, v_transfer, v_event_conflict, v_event_unresolved
    from public.dialpad_call_events e
   where e.org_id = p_org_id
     and e.id in (select event_id from public.dialpad_recording_shadow_relevant_events(p_org_id, p_capture_id));
  if v_provider_call_count > 1 or v_transfer then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'multiple_provider_legs');
  end if;
  if v_event_conflict then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'provider_event_conflict');
  end if;
  if v_event_unresolved then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'provider_evidence_unresolved');
  end if;

  for r in
    select e.id, e.payload_sha256, e.event_state,
           public.dialpad_cti_payload_ms(e.payload, 'date_connected') as connected_ms,
           public.dialpad_cti_payload_ms(e.payload, 'date_ended') as ended_ms
      from public.dialpad_call_events e
     where e.org_id = p_org_id
       and e.disposition = 'matched'
       and e.provider_call_id = v_capture.provider_call_id
       and (e.matched_intent_id = v_capture.intent_id or e.provider_call_id = v_capture.provider_call_id)
       and (public.dialpad_cti_payload_ms(e.payload, 'date_connected') is not null
         or public.dialpad_cti_payload_ms(e.payload, 'date_ended') is not null)
       and e.id in (select event_id from public.dialpad_recording_shadow_relevant_events(p_org_id, p_capture_id))
     order by e.event_timestamp_ms, e.id
  loop
    v_boundary_count := v_boundary_count + 1;
    v_candidate := jsonb_build_object('eventId', r.id, 'payloadSha256', r.payload_sha256,
      'eventState', r.event_state, 'dateConnectedMs', r.connected_ms, 'dateEndedMs', r.ended_ms);
    if jsonb_array_length(v_candidates) < 8 then
      v_candidates := v_candidates || jsonb_build_array(v_candidate);
    end if;
  end loop;

  select min(public.dialpad_cti_payload_ms(e.payload, 'date_connected')),
         max(public.dialpad_cti_payload_ms(e.payload, 'date_connected')),
         min(public.dialpad_cti_payload_ms(e.payload, 'date_ended')),
         max(public.dialpad_cti_payload_ms(e.payload, 'date_ended')),
         count(distinct public.dialpad_cti_payload_ms(e.payload, 'date_connected')) filter (where public.dialpad_cti_payload_ms(e.payload, 'date_connected') is not null),
         count(distinct public.dialpad_cti_payload_ms(e.payload, 'date_ended')) filter (where public.dialpad_cti_payload_ms(e.payload, 'date_ended') is not null)
    into v_connected_min, v_connected_max, v_ended_min, v_ended_max, v_connected_values, v_ended_values
    from public.dialpad_call_events e
   where e.org_id = p_org_id
     and e.disposition = 'matched'
     and e.provider_call_id = v_capture.provider_call_id
     and e.id in (select event_id from public.dialpad_recording_shadow_relevant_events(p_org_id, p_capture_id));
  if v_connected_min is null or v_ended_min is null then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'provider_boundaries_missing');
  elsif v_connected_values > 1 or v_ended_values > 1 or v_connected_min >= v_ended_max then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'provider_boundaries_conflicting');
  end if;

  select count(distinct epoch) into v_consumed_epochs
    from public.dialpad_recording_ingest_grants
   where capture_id = p_capture_id and org_id = p_org_id and consumed_at is not null;
  if v_consumed_epochs > 1 then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'multiple_capture_epochs');
  end if;
  if v_capture.status <> 'sealed'
     or (select count(*) from public.dialpad_recording_track_finals
          where capture_id = p_capture_id and epoch = 1 and completeness = 'complete') < 2 then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'recording_incomplete');
  end if;
  if v_consumed_epochs = 0
     or exists (
       select 1
         from (
           select distinct epoch
             from public.dialpad_recording_ingest_grants
            where capture_id = p_capture_id and org_id = p_org_id and consumed_at is not null
         ) epochs
         cross join (values ('tab'::text), ('mic'::text)) tracks(track)
        where not exists (
          select 1
            from public.dialpad_recording_pcm_progress p
           where p.capture_id = p_capture_id and p.org_id = p_org_id
             and p.epoch = epochs.epoch and p.track = tracks.track
             and p.pcm_eof_sample is not null
        )
     ) then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'pcm_incomplete');
  end if;
  if exists (
    select 1 from public.dialpad_recording_pcm_progress p
     where p.capture_id = p_capture_id and jsonb_array_length(p.degraded_reasons) > 0
  ) then
    v_reasons := public.dialpad_recording_shadow_add_reason(v_reasons, 'pcm_degraded');
  end if;

  select coalesce(jsonb_agg(reason order by reason), '[]'::jsonb)
    into v_reason_json
    from unnest(v_reasons) as reasons(reason);
  if v_reasons && array['provider_boundaries_conflicting', 'provider_evidence_unresolved',
                         'provider_event_conflict', 'multiple_provider_legs', 'vad_totals_mismatch'] then
    v_evidence_status := 'conflicting';
  else
    v_evidence_status := 'insufficient';
  end if;

  v_manifest := jsonb_build_object(
    'schemaVersion', 1,
    'algorithmVersion', 'provider-window-shadow-v1',
    'capture', jsonb_build_object(
      'captureId', v_capture.id, 'orgId', v_capture.org_id, 'intentId', v_capture.intent_id,
      'callActivityId', v_capture.call_activity_id, 'providerCallId', v_capture.provider_call_id,
      'status', v_capture.status, 'closeReason', v_capture.close_reason,
      'resultAt', v_capture.result_at, 'failureCode', v_capture.failure_code,
      'resultIdentity', v_capture.result_identity
    ),
    'relations', jsonb_build_object(
      'consumedGrants', jsonb_build_object('count', v_grant_count, 'digest', v_grant_digest, 'epochs', v_grants),
      'segments', jsonb_build_object('count', v_segment_count, 'digest', v_segment_digest),
      'chunks', jsonb_build_object('count', v_chunk_count, 'digest', v_chunk_digest),
      'trackFinals', jsonb_build_object('count', v_final_count, 'digest', v_final_digest),
      'vadBatches', jsonb_build_object('count', v_vad_batch_count, 'digest', v_vad_batch_digest),
      'vadRanges', jsonb_build_object('count', v_vad_range_count, 'digest', v_vad_range_digest),
      'pcmBatches', jsonb_build_object('count', v_pcm_batch_count, 'digest', v_pcm_batch_digest),
      'pcmProgress', jsonb_build_object('count', v_pcm_progress_count, 'digest', v_pcm_progress_digest),
      'vadTotals', jsonb_build_object('count', v_total_count, 'digest', v_total_digest)
    ),
    'observedSamples', v_observed,
    'observedSamplesByEpoch', v_observed_by_epoch,
    'provider', jsonb_build_object(
      'eventCount', v_event_count, 'eventDigest', v_event_digest,
      'boundaryCandidateCount', v_boundary_count, 'providerBoundaryCandidates', v_candidates
    ),
    'timingEvidence', null,
    'reasons', v_reason_json,
    'evidenceStatus', v_evidence_status
  );

  return jsonb_build_object(
    'algorithmVersion', 'provider-window-shadow-v1',
    'inputDigest', encode(extensions.digest(convert_to(v_manifest::text, 'utf8'), 'sha256'), 'hex'),
    'manifest', v_manifest,
    'observedSamples', v_observed,
    'observedSamplesByEpoch', v_observed_by_epoch,
    'eligibleSamples', null,
    'timingStatus', 'unmapped',
    'evidenceStatus', v_evidence_status,
    'reasons', v_reason_json
  );
end;
$$;

commit;
