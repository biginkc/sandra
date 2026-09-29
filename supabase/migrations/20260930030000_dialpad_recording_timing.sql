-- Dialpad authenticated browser timing observation ledger.
-- Depends on 20260929210000 recording foundation, 20260930001000 browser
-- session, and 20260930001100 shadow evidence. Timing is observation only;
-- it never creates eligible samples or changes audio seal predicates.
begin;

create table public.dialpad_recording_timing_batches (
  capture_id uuid not null,
  org_id uuid not null,
  epoch smallint not null check (epoch between 1 and 16),
  batch_id uuid not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  record_count smallint not null check (record_count between 1 and 16),
  payload_bytes integer not null check (payload_bytes between 1 and 12288),
  created_at timestamptz not null default now(),
  primary key (capture_id, epoch, batch_id),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures(id, org_id)
);

create table public.dialpad_recording_timing_records (
  capture_id uuid not null,
  org_id uuid not null,
  epoch smallint not null check (epoch between 1 and 16),
  stream text not null check (stream in ('tab:anchor','mic:anchor','tab:context','mic:context','exchange')),
  seq integer not null check (seq >= 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  record jsonb not null,
  payload_bytes integer not null check (payload_bytes between 1 and 2048),
  created_at timestamptz not null default now(),
  primary key (capture_id, epoch, stream, seq),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures(id, org_id)
);

create table public.dialpad_recording_timing_state (
  capture_id uuid not null,
  org_id uuid not null,
  epoch smallint not null check (epoch between 1 and 16),
  status text not null default 'open' check (status in ('open','collected','incomplete')),
  last_sequences jsonb,
  reasons jsonb not null default '[]'::jsonb,
  final_request_hash text check (final_request_hash is null or final_request_hash ~ '^[0-9a-f]{64}$'),
  finalized_at timestamptz,
  primary key (capture_id, epoch),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures(id, org_id),
  check (jsonb_typeof(reasons) = 'array'),
  check (status = 'open' or (last_sequences is not null and finalized_at is not null))
);
alter table public.dialpad_recording_timing_state add column if not exists final_request_hash text;

alter table public.dialpad_recording_timing_batches enable row level security;
alter table public.dialpad_recording_timing_records enable row level security;
alter table public.dialpad_recording_timing_state enable row level security;
revoke all on public.dialpad_recording_timing_batches from public, anon, authenticated;
revoke all on public.dialpad_recording_timing_records from public, anon, authenticated;
revoke all on public.dialpad_recording_timing_state from public, anon, authenticated;
revoke all on public.dialpad_recording_timing_batches from service_role;
revoke all on public.dialpad_recording_timing_records from service_role;
revoke all on public.dialpad_recording_timing_state from service_role;
grant select on public.dialpad_recording_timing_batches to service_role;
grant select on public.dialpad_recording_timing_records to service_role;
grant select on public.dialpad_recording_timing_state to service_role;

create or replace function public.dialpad_recording_timing_stream(p_record jsonb)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_record) <> 'object' then raise exception 'timing record must be object' using errcode = '22023'; end if;
  if p_record->>'kind' = 'anchor' and p_record->>'track' in ('tab','mic') then return p_record->>'track' || ':anchor'; end if;
  if p_record->>'kind' = 'context_clock' and p_record->>'track' in ('tab','mic') then return p_record->>'track' || ':context'; end if;
  if p_record->>'kind' = 'exchange' then return 'exchange'; end if;
  raise exception 'invalid timing record kind' using errcode = '22023';
end $$;

create or replace function public.dialpad_recording_timing_record_check(p_record jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare
  k text := p_record->>'kind';
  required text[];
  key_count integer;
begin
  if jsonb_typeof(p_record) <> 'object' then raise exception 'timing record must be object' using errcode = '22023'; end if;
  if k = 'anchor' then
    required := array['kind','track','seq','contextId','anchor','contextFrame','sourceCursor','blockLength','sourceRateHz','outputCursor','outputFrameIndex','phaseNumerator','continuity','previousContextEndFrame','discardedTailSamples'];
  elsif k = 'context_clock' then
    required := array['kind','track','seq','contextId','observation','browserBeforeMs','contextTimeMs','browserAfterMs','browserTimeOriginMs','state'];
  elsif k = 'exchange' then
    required := array['kind','seq','serverClockId','browserSendMs','browserReceiveMs','serverReceiveMonoMs','serverSendMonoMs','serverReceiveWallMs','serverSendWallMs'];
  else
    raise exception 'invalid timing record kind' using errcode = '22023';
  end if;
  select count(*) into key_count from jsonb_object_keys(p_record);
  if key_count <> cardinality(required) or exists (select 1 from jsonb_object_keys(p_record) kx where not (kx = any(required))) then
    raise exception 'timing record keys are not exact' using errcode = '22023';
  end if;
  if jsonb_typeof(p_record->'seq') <> 'number' or (p_record->>'seq')::numeric < 0 or (p_record->>'seq')::numeric > 2147483647 or (p_record->>'seq')::numeric <> trunc((p_record->>'seq')::numeric) then raise exception 'invalid timing sequence' using errcode = '22023'; end if;
  if k = 'anchor' then
    if p_record->>'track' not in ('tab','mic') or p_record->>'contextId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_record->>'anchor' not in ('start','periodic','discontinuity','final') or p_record->>'continuity' not in ('continuous','empty_input_gap','context_frame_gap','channel_change','unknown') then raise exception 'invalid timing anchor identity' using errcode = '22023'; end if;
    if exists (select 1 from unnest(array['contextFrame','sourceCursor','blockLength','sourceRateHz','outputCursor','outputFrameIndex','phaseNumerator']) field where jsonb_typeof(p_record->field) <> 'number') then raise exception 'invalid timing anchor number' using errcode = '22023'; end if;
    if exists (select 1 from unnest(array['previousContextEndFrame','discardedTailSamples']) field where jsonb_typeof(p_record->field) not in ('number','null')) then raise exception 'invalid timing anchor nullable number' using errcode = '22023'; end if;
    if (p_record->>'contextFrame')::numeric < 0 or (p_record->>'sourceCursor')::numeric < 0 or (p_record->>'blockLength')::numeric < 0 or (p_record->>'sourceRateHz')::numeric < 8000 or (p_record->>'sourceRateHz')::numeric > 192000 or (p_record->>'outputCursor')::numeric < 0 or (p_record->>'outputFrameIndex')::numeric < 0 or (p_record->>'phaseNumerator')::numeric < 0 or (p_record->>'phaseNumerator')::numeric >= 16000 or (p_record->>'contextFrame')::numeric > 9007199254740991 or (p_record->>'sourceCursor')::numeric > 9007199254740991 or (p_record->>'blockLength')::numeric > 9007199254740991 or (p_record->>'outputCursor')::numeric > 9007199254740991 or (p_record->>'outputFrameIndex')::numeric > 9007199254740991 or (p_record->>'contextFrame')::numeric <> trunc((p_record->>'contextFrame')::numeric) or (p_record->>'sourceCursor')::numeric <> trunc((p_record->>'sourceCursor')::numeric) or (p_record->>'blockLength')::numeric <> trunc((p_record->>'blockLength')::numeric) or (p_record->>'sourceRateHz')::numeric <> trunc((p_record->>'sourceRateHz')::numeric) or (p_record->>'outputCursor')::numeric <> trunc((p_record->>'outputCursor')::numeric) or (p_record->>'outputFrameIndex')::numeric <> trunc((p_record->>'outputFrameIndex')::numeric) or (p_record->>'phaseNumerator')::numeric <> trunc((p_record->>'phaseNumerator')::numeric) then raise exception 'invalid timing anchor range' using errcode = '22023'; end if;
    if p_record->>'anchor' = 'final' and (p_record->>'blockLength')::numeric <> 0 then raise exception 'invalid timing final anchor' using errcode = '22023'; end if;
  elsif k = 'context_clock' then
    if p_record->>'track' not in ('tab','mic') or p_record->>'contextId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_record->>'observation' not in ('start','periodic','state_change','final') or p_record->>'state' not in ('running','suspended','closed') then raise exception 'invalid timing clock identity' using errcode = '22023'; end if;
    if exists (select 1 from unnest(array['browserBeforeMs','contextTimeMs','browserAfterMs','browserTimeOriginMs']) field where jsonb_typeof(p_record->field) <> 'number') then raise exception 'invalid timing clock number' using errcode = '22023'; end if;
    if (p_record->>'browserBeforeMs')::numeric > (p_record->>'browserAfterMs')::numeric then raise exception 'invalid timing clock bracket' using errcode = '22023'; end if;
  elsif k = 'exchange' then
    if p_record->>'serverClockId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid timing exchange identity' using errcode = '22023'; end if;
    if exists (select 1 from unnest(array['browserSendMs','browserReceiveMs','serverReceiveMonoMs','serverSendMonoMs','serverReceiveWallMs','serverSendWallMs']) field where jsonb_typeof(p_record->field) <> 'number') then raise exception 'invalid timing exchange number' using errcode = '22023'; end if;
    if (p_record->>'browserReceiveMs')::numeric < (p_record->>'browserSendMs')::numeric or (p_record->>'serverSendMonoMs')::numeric < (p_record->>'serverReceiveMonoMs')::numeric then raise exception 'invalid timing exchange ordering' using errcode = '22023'; end if;
  end if;
  if octet_length(p_record::text) > 2048 then raise exception 'timing record exceeds bound' using errcode = '22023'; end if;
end $$;

create or replace function public.fn_append_dialpad_recording_timing(
  p_org_id uuid, p_capture_id uuid, p_epoch integer, p_batch_id uuid, p_records jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cap public.dialpad_recording_captures%rowtype;
  existing public.dialpad_recording_timing_batches%rowtype;
  state public.dialpad_recording_timing_state%rowtype;
  item jsonb;
  stream_name text;
  record_hash text;
  batch_hash text;
  count_in_batch integer;
  capture_count integer;
  batch_count integer;
  new_record_count integer := 0;
  capture_bytes bigint;
  batch_bytes bigint;
  distinct_count integer;
  payload_bytes integer;
begin
  if p_org_id is null or p_capture_id is null or p_batch_id is null or p_epoch not between 1 and 16 or jsonb_typeof(p_records) <> 'array' then
    raise exception 'invalid timing append input' using errcode = '22023';
  end if;
  select count(*) into count_in_batch from jsonb_array_elements(p_records);
  if count_in_batch < 1 or count_in_batch > 16 then raise exception 'timing batch record limit exceeded' using errcode = '22023'; end if;
  payload_bytes := octet_length(p_records::text);
  if payload_bytes > 12288 then raise exception 'timing batch exceeds wire bound' using errcode = '22023'; end if;
  batch_hash := encode(extensions.digest(convert_to(p_records::text,'utf8'),'sha256'),'hex');
  for item in select value from jsonb_array_elements(p_records) loop
    perform public.dialpad_recording_timing_record_check(item);
  end loop;
  select count(*) into distinct_count from (
    select distinct public.dialpad_recording_timing_stream(value) as stream, (value->>'seq')::integer as seq
      from jsonb_array_elements(p_records)
  ) unique_records;
  if distinct_count <> count_in_batch then raise exception 'duplicate timing record key in batch' using errcode = '40001'; end if;

  -- Capture is always the first lock. The timing row is locked only after the
  -- capture has been checked, matching the finalizer's lock order.
  select * into cap
    from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id
   for update;
  if not found then raise exception 'recording capture not found' using errcode = 'P0002'; end if;

  select * into existing
    from public.dialpad_recording_timing_batches
   where capture_id=p_capture_id and epoch=p_epoch and batch_id=p_batch_id;
  if found then
    if existing.content_hash <> batch_hash then raise exception 'timing batch replay conflict' using errcode = '40001'; end if;
    return jsonb_build_object('status','replayed','recordCount',existing.record_count,'captureRecordCount',(select count(*) from public.dialpad_recording_timing_records where capture_id=p_capture_id));
  end if;
  if cap.status not in ('open','closing') then raise exception 'timing capture is terminal' using errcode = '55000'; end if;
  if cap.status = 'closing' and cap.drain_deadline_at is not null and cap.drain_deadline_at <= now() then raise exception 'timing drain expired' using errcode = '55000'; end if;
  if not exists (select 1 from public.dialpad_recording_ingest_grants where capture_id=p_capture_id and org_id=p_org_id and epoch=p_epoch and consumed_at is not null) then
    raise exception 'timing epoch is not consumed' using errcode = '55000';
  end if;
  if p_epoch <> (select max(epoch) from public.dialpad_recording_ingest_grants where capture_id=p_capture_id and org_id=p_org_id and consumed_at is not null) then
    raise exception 'timing epoch is stale' using errcode = '55000';
  end if;

  insert into public.dialpad_recording_timing_state(capture_id,org_id,epoch)
  values (p_capture_id,p_org_id,p_epoch) on conflict do nothing;
  select * into state from public.dialpad_recording_timing_state where capture_id=p_capture_id and epoch=p_epoch for update;
  if state.status <> 'open' then raise exception 'timing evidence is terminal' using errcode = '55000'; end if;

  for item in select value from jsonb_array_elements(p_records) loop
    stream_name := public.dialpad_recording_timing_stream(item);
    record_hash := encode(extensions.digest(convert_to(item::text,'utf8'),'sha256'),'hex');
    if item->>'kind' in ('anchor','context_clock') and exists (
      select 1 from public.dialpad_recording_timing_records
       where capture_id=p_capture_id and epoch=p_epoch
         and record->>'contextId'=item->>'contextId'
         and record->>'track' is distinct from item->>'track'
    ) then raise exception 'timing context identity reused across tracks' using errcode = '22023'; end if;
    if exists (
      select 1 from public.dialpad_recording_timing_records
       where capture_id=p_capture_id and epoch=p_epoch and stream=stream_name
         and seq=(item->>'seq')::integer and content_hash <> record_hash
    ) then raise exception 'timing record replay conflict' using errcode = '40001'; end if;
    if not exists (
      select 1 from public.dialpad_recording_timing_records
       where capture_id=p_capture_id and epoch=p_epoch and stream=stream_name and seq=(item->>'seq')::integer
    ) then new_record_count := new_record_count + 1; end if;
  end loop;
  if exists (
    select 1 from (
      select value->>'contextId' as context_id, count(distinct value->>'track') as track_count
        from jsonb_array_elements(p_records)
       where value->>'kind' in ('anchor','context_clock')
       group by value->>'contextId'
    ) contexts where contexts.track_count > 1
  ) then raise exception 'timing context identity reused across tracks' using errcode = '22023'; end if;

  select count(*) into capture_count from public.dialpad_recording_timing_records where capture_id=p_capture_id;
  select coalesce(sum(r.payload_bytes),0) into capture_bytes from public.dialpad_recording_timing_records r where r.capture_id=p_capture_id;
  select count(*) into batch_count from public.dialpad_recording_timing_batches where capture_id=p_capture_id;
  select coalesce(sum(b.payload_bytes),0) into batch_bytes from public.dialpad_recording_timing_batches b where b.capture_id=p_capture_id;
  if capture_count + new_record_count > 8192 or batch_count + 1 > 8192 or capture_bytes + batch_bytes + payload_bytes > 16777216 then
    raise exception 'timing observation capacity exceeded' using errcode = '22023';
  end if;

  insert into public.dialpad_recording_timing_batches(capture_id,org_id,epoch,batch_id,content_hash,record_count,payload_bytes)
  values (p_capture_id,p_org_id,p_epoch,p_batch_id,batch_hash,count_in_batch,payload_bytes);
  for item in select value from jsonb_array_elements(p_records) loop
    stream_name := public.dialpad_recording_timing_stream(item);
    record_hash := encode(extensions.digest(convert_to(item::text,'utf8'),'sha256'),'hex');
    insert into public.dialpad_recording_timing_records(capture_id,org_id,epoch,stream,seq,content_hash,record,payload_bytes)
    values (p_capture_id,p_org_id,p_epoch,stream_name,(item->>'seq')::integer,record_hash,item,octet_length(item::text))
    on conflict do nothing;
  end loop;
  if exists (
    select 1 from public.dialpad_recording_timing_records
     where capture_id=p_capture_id and epoch=p_epoch
     group by stream having min(seq) <> 0 or count(*) <> max(seq) + 1
  ) then raise exception 'timing sequence gap' using errcode = '22023'; end if;
  return jsonb_build_object('status','recorded','recordCount',count_in_batch,'captureRecordCount',(select count(*) from public.dialpad_recording_timing_records where capture_id=p_capture_id));
end $$;

create or replace function public.fn_finish_dialpad_recording_timing(
  p_org_id uuid, p_capture_id uuid, p_epoch integer, p_last_sequences jsonb, p_outcome text, p_reasons jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cap public.dialpad_recording_captures%rowtype;
  current_state public.dialpad_recording_timing_state%rowtype;
  effective text;
  final_request_hash text;
  canonical_reasons jsonb;
begin
  if p_org_id is null or p_capture_id is null or p_epoch not between 1 and 16 or p_outcome not in ('collected','incomplete') or jsonb_typeof(p_last_sequences) <> 'object' or (select count(*) from jsonb_object_keys(p_last_sequences)) <> 5 or jsonb_typeof(p_reasons) <> 'array' then
    raise exception 'invalid timing finish input' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each(p_last_sequences) entry
     where entry.key not in ('tabAnchor','micAnchor','tabContext','micContext','exchange')
        or jsonb_typeof(entry.value) <> 'number'
        or (entry.value::text)::numeric < -1
        or (entry.value::text)::numeric > 2147483647
        or (entry.value::text)::numeric <> trunc((entry.value::text)::numeric)
  ) then raise exception 'invalid timing finish sequences' using errcode = '22023'; end if;
  if jsonb_array_length(p_reasons) > 8 or exists (
    select 1 from jsonb_array_elements_text(p_reasons) reason
    where reason not in ('missing_anchor','clock_discontinuity','exchange_timeout','observation_overflow','persistence_failed','capture_interrupted','missing_final','sequence_gap','legacy_unavailable')
  ) or (select count(*) from jsonb_array_elements_text(p_reasons)) <> (select count(distinct reason) from jsonb_array_elements_text(p_reasons) reason) then
    raise exception 'invalid timing finish reasons' using errcode = '22023';
  end if;
  if p_reasons <> (select coalesce(jsonb_agg(to_jsonb(reason) order by reason), '[]'::jsonb) from jsonb_array_elements_text(p_reasons) as reasons(reason)) then
    raise exception 'timing finish reasons must be sorted' using errcode = '22023';
  end if;
  final_request_hash := encode(extensions.digest(convert_to(jsonb_build_object('lastSequences',p_last_sequences,'outcome',p_outcome,'reasons',p_reasons)::text,'utf8'),'sha256'),'hex');

  -- The capture lock precedes the timing state lock for finish/append races.
  select * into cap from public.dialpad_recording_captures where id=p_capture_id and org_id=p_org_id for update;
  if not found then raise exception 'recording capture not found' using errcode = 'P0002'; end if;
  insert into public.dialpad_recording_timing_state(capture_id,org_id,epoch) values (p_capture_id,p_org_id,p_epoch) on conflict do nothing;
  select * into current_state from public.dialpad_recording_timing_state where capture_id=p_capture_id and epoch=p_epoch for update;
  if current_state.status <> 'open' then
    if current_state.final_request_hash = final_request_hash then
      return jsonb_build_object('status',current_state.status,'reasons',current_state.reasons);
    end if;
    raise exception 'timing finish replay conflict' using errcode = '40001';
  end if;
  if cap.status not in ('open','closing') then raise exception 'timing capture is terminal' using errcode = '55000'; end if;
  if cap.status = 'closing' and cap.drain_deadline_at is not null and cap.drain_deadline_at <= now() then raise exception 'timing drain expired' using errcode = '55000'; end if;
  if not exists (select 1 from public.dialpad_recording_ingest_grants where capture_id=p_capture_id and org_id=p_org_id and epoch=p_epoch and consumed_at is not null) then raise exception 'timing epoch is not consumed' using errcode = '55000'; end if;
  if p_epoch <> (select max(epoch) from public.dialpad_recording_ingest_grants where capture_id=p_capture_id and org_id=p_org_id and consumed_at is not null) then raise exception 'timing epoch is stale' using errcode = '55000'; end if;
  if coalesce((select max(seq) from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:anchor'), -1) <> (p_last_sequences->>'tabAnchor')::integer
     or coalesce((select max(seq) from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:anchor'), -1) <> (p_last_sequences->>'micAnchor')::integer
     or coalesce((select max(seq) from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:context'), -1) <> (p_last_sequences->>'tabContext')::integer
     or coalesce((select max(seq) from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:context'), -1) <> (p_last_sequences->>'micContext')::integer
     or coalesce((select max(seq) from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='exchange'), -1) <> (p_last_sequences->>'exchange')::integer then
    raise exception 'timing finish sequences do not match persisted records' using errcode = '22023';
  end if;

  effective := case when p_outcome='collected' and jsonb_array_length(p_reasons)=0 then 'collected' else 'incomplete' end;
  canonical_reasons := p_reasons;
  if effective = 'collected' then
    if not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:anchor' and record->>'anchor'='start')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:anchor' and record->>'anchor'='start')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:anchor' and record->>'anchor'='final')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:anchor' and record->>'anchor'='final')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:context' and record->>'observation'='start')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:context' and record->>'observation'='start')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:context' and record->>'observation'='final')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:context' and record->>'observation'='final')
       or not exists (select 1 from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='exchange') then
      effective := 'incomplete';
      canonical_reasons := canonical_reasons || '["missing_final"]'::jsonb;
    end if;
    if exists (
      select 1 from public.dialpad_recording_timing_records
       where capture_id=p_capture_id and epoch=p_epoch and stream in ('tab:anchor','mic:anchor')
         and record->>'continuity' <> 'continuous'
    ) or exists (
      select 1 from public.dialpad_recording_timing_records
       where capture_id=p_capture_id and epoch=p_epoch and stream in ('tab:context','mic:context') and record->>'state' = 'suspended'
    ) then
      effective := 'incomplete';
      canonical_reasons := canonical_reasons || '["clock_discontinuity"]'::jsonb;
    end if;
    if exists (
      select 1 from (
        select stream, count(distinct record->>'contextId') as context_count
          from public.dialpad_recording_timing_records
         where capture_id=p_capture_id and epoch=p_epoch and stream in ('tab:anchor','mic:anchor','tab:context','mic:context')
         group by stream
    ) stable_contexts where context_count <> 1
    ) or (
      (select count(*) from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream in ('tab:context','mic:context')) > 0
      and (select count(distinct record->>'browserTimeOriginMs') from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream in ('tab:context','mic:context')) <> 1
    ) then
      effective := 'incomplete';
      canonical_reasons := canonical_reasons || '["clock_discontinuity"]'::jsonb;
    end if;
    if exists (
      select 1
        from public.dialpad_recording_timing_records f
        left join lateral (
          select p.record
            from public.dialpad_recording_timing_records p
           where p.capture_id=f.capture_id and p.epoch=f.epoch and p.stream=f.stream and p.record->>'anchor' <> 'final' and p.seq < f.seq
           order by p.seq desc limit 1
        ) previous on true
       where f.capture_id=p_capture_id and f.epoch=p_epoch and f.stream in ('tab:anchor','mic:anchor') and f.record->>'anchor'='final'
         and (previous.record is null or (f.record->>'sourceCursor')::numeric <> (previous.record->>'sourceCursor')::numeric + (previous.record->>'blockLength')::numeric)
    ) then
      effective := 'incomplete';
      canonical_reasons := canonical_reasons || '["sequence_gap"]'::jsonb;
    end if;
    if (select record->>'contextId' from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:anchor' and record->>'anchor'='final' order by seq desc limit 1)
       is distinct from (select record->>'contextId' from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='tab:context' and record->>'observation'='final' order by seq desc limit 1)
       or (select record->>'contextId' from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:anchor' and record->>'anchor'='final' order by seq desc limit 1)
       is distinct from (select record->>'contextId' from public.dialpad_recording_timing_records where capture_id=p_capture_id and epoch=p_epoch and stream='mic:context' and record->>'observation'='final' order by seq desc limit 1) then
      effective := 'incomplete';
      canonical_reasons := canonical_reasons || '["missing_final"]'::jsonb;
    end if;
  end if;
  select coalesce(jsonb_agg(to_jsonb(reason) order by reason), '[]'::jsonb)
    into canonical_reasons
    from (select distinct reason from jsonb_array_elements_text(canonical_reasons) as reasons(reason)) unique_reasons;
  insert into public.dialpad_recording_timing_state(capture_id,org_id,epoch,status,last_sequences,reasons,final_request_hash,finalized_at)
  values (p_capture_id,p_org_id,p_epoch,effective,p_last_sequences,canonical_reasons,final_request_hash,now())
    on conflict (capture_id,epoch) do update set status=excluded.status,last_sequences=excluded.last_sequences,reasons=excluded.reasons,final_request_hash=excluded.final_request_hash,finalized_at=excluded.finalized_at;
  return jsonb_build_object('status',effective,'reasons',canonical_reasons);
end $$;

revoke all on function public.dialpad_recording_timing_stream(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.dialpad_recording_timing_record_check(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fn_append_dialpad_recording_timing(uuid,uuid,integer,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.fn_finish_dialpad_recording_timing(uuid,uuid,integer,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.fn_append_dialpad_recording_timing(uuid,uuid,integer,uuid,jsonb) to service_role;
grant execute on function public.fn_finish_dialpad_recording_timing(uuid,uuid,integer,jsonb,text,jsonb) to service_role;

-- Extend the reviewed shadow input through a wrapper so timing observations
-- participate in its immutable digest without editing the historical helper.
alter function public.dialpad_recording_shadow_input(uuid, uuid)
  rename to dialpad_recording_shadow_input_base;

create or replace function public.dialpad_recording_shadow_input(p_org_id uuid, p_capture_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
with base as materialized (
  select public.dialpad_recording_shadow_input_base(p_org_id, p_capture_id) as value
), timing_records as (
  select count(*)::integer as record_count,
         coalesce(sum(r.payload_bytes), 0)::bigint as total_bytes,
         encode(extensions.digest(convert_to(coalesce(string_agg(
           r.epoch::text || ':' || r.stream || ':' || r.seq::text || ':' || r.content_hash,
           '|' order by r.epoch, r.stream, r.seq), ''), 'utf8'), 'sha256'), 'hex') as record_digest
    from public.dialpad_recording_timing_records r
   where r.capture_id = p_capture_id and r.org_id = p_org_id
), timing_states as (
  select coalesce(jsonb_agg(jsonb_build_object(
           'epoch', s.epoch, 'status', s.status, 'lastSequences', s.last_sequences, 'reasons', s.reasons
         ) order by s.epoch), '[]'::jsonb) as rows
    from public.dialpad_recording_timing_state s
   where s.capture_id = p_capture_id and s.org_id = p_org_id
), timing as (
  select jsonb_build_object(
    'recordCount', timing_records.record_count,
    'bytes', timing_records.total_bytes,
    'digest', timing_records.record_digest,
    'state', case
      when jsonb_array_length(timing_states.rows) = 0 then 'missing'
      when exists (select 1 from jsonb_array_elements(timing_states.rows) state_row where state_row->>'status' = 'incomplete') then 'incomplete'
      when exists (select 1 from jsonb_array_elements(timing_states.rows) state_row where state_row->>'status' = 'open') then 'pending'
      else 'collected'
    end,
    'epochs', timing_states.rows
  ) as value
    from timing_records cross join timing_states
), updated as (
  select jsonb_set(base.value, '{manifest}', jsonb_set(base.value->'manifest', '{timingEvidence}', timing.value, true), true) as value
    from base cross join timing
)
select jsonb_set(updated.value, '{inputDigest}', to_jsonb(encode(extensions.digest(convert_to((updated.value->'manifest')::text, 'utf8'), 'sha256'), 'hex')), true)
  from updated;
$$;

revoke all on function public.dialpad_recording_shadow_input_base(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.dialpad_recording_shadow_input(uuid, uuid) from public, anon, authenticated, service_role;

commit;
