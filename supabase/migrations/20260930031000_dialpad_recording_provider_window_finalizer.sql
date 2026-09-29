-- Disabled-policy provider-window finalizer.
--
-- This is an additive, service-only numeric projection.  No policy rows are
-- seeded or accepted by this migration.  Until an owner accepts a measured
-- policy, finalization returns unknown/NULL eligibility and the KPI gate stays
-- closed for Dialpad calls.
begin;

create table public.dialpad_recording_provider_window_policies (
  org_id uuid not null references public.organizations(id) on delete restrict,
  policy_version text not null check (policy_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  algorithm_version text not null,
  policy_hash text not null check (policy_hash ~ '^[0-9a-f]{64}$'),
  mapping_method text not null check (mapping_method = 'affine_sample_support_v1'),
  time_unit text not null check (time_unit = 'microseconds'),
  sample_rate_hz integer not null check (sample_rate_hz = 16000),
  domain_start_sample bigint not null check (domain_start_sample >= 0),
  domain_end_sample bigint not null check (domain_end_sample > domain_start_sample),
  lower_slope_us_per_sample numeric not null check (lower_slope_us_per_sample > 0),
  lower_intercept_us numeric not null,
  upper_slope_us_per_sample numeric not null check (upper_slope_us_per_sample > 0),
  upper_intercept_us numeric not null,
  classification_overcount_samples numeric not null check (classification_overcount_samples >= 0),
  supported_duration_max_seconds integer not null check (supported_duration_max_seconds > 0),
  supported_anchor_cadence_ms integer not null check (supported_anchor_cadence_ms > 0),
  supported_stall_max_ms integer not null check (supported_stall_max_ms >= 0),
  supported_drift_ppm numeric not null check (supported_drift_ppm >= 0),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_refs jsonb not null check (jsonb_typeof(evidence_refs) = 'array' and jsonb_array_length(evidence_refs) between 1 and 32),
  acceptance_note text not null check (length(btrim(acceptance_note)) between 1 and 4000),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (org_id, policy_version),
  check ((accepted_at is null and accepted_by is null) or (accepted_at is not null and accepted_by is not null)),
  check (revoked_at is null or accepted_at is not null),
  check (lower_slope_us_per_sample * domain_start_sample + lower_intercept_us <= upper_slope_us_per_sample * domain_start_sample + upper_intercept_us),
  check (lower_slope_us_per_sample * domain_end_sample + lower_intercept_us <= upper_slope_us_per_sample * domain_end_sample + upper_intercept_us)
);

comment on table public.dialpad_recording_provider_window_policies is
  'Versioned empirical provider-window acceptance configurations. This migration seeds no accepted policy; numerical values require retained-call evidence and owner acceptance.';

create table public.dialpad_recording_provider_window_results (
  capture_id uuid primary key,
  org_id uuid not null,
  call_activity_id uuid not null unique,
  intent_id uuid not null,
  epoch smallint not null check (epoch between 1 and 16),
  provider_call_id text not null,
  policy_version text not null,
  policy_hash text not null check (policy_hash ~ '^[0-9a-f]{64}$'),
  algorithm_version text not null,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  observed_samples bigint not null check (observed_samples >= 0),
  eligible_samples bigint check (eligible_samples is null or eligible_samples between 0 and observed_samples),
  status text not null check (status in ('eligible', 'ineligible', 'unknown')),
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) between 1 and 32),
  sample_window jsonb not null check (jsonb_typeof(sample_window) = 'object'),
  selected_summary jsonb not null check (jsonb_typeof(selected_summary) = 'object'),
  evaluated_at timestamptz not null default now(),
  foreign key (capture_id, org_id) references public.dialpad_recording_captures(id, org_id) on delete restrict,
  foreign key (intent_id, org_id) references public.dialpad_call_intents(id, org_id) on delete restrict,
  check ((status = 'eligible') = (eligible_samples is not null and eligible_samples > 4800000)),
  check (status <> 'unknown' or eligible_samples is null)
);

comment on table public.dialpad_recording_provider_window_results is
  'Current service-owned provider-window result. NULL eligible_samples means evidence is incomplete, conflicting, unsupported, stale or policy-unaccepted; it never means zero seller speech.';

create or replace function public.dialpad_recording_provider_window_policy_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.policy_version is distinct from old.policy_version or new.algorithm_version is distinct from old.algorithm_version
    or new.policy_hash is distinct from old.policy_hash or new.mapping_method is distinct from old.mapping_method
    or new.time_unit is distinct from old.time_unit or new.sample_rate_hz is distinct from old.sample_rate_hz
    or new.domain_start_sample is distinct from old.domain_start_sample or new.domain_end_sample is distinct from old.domain_end_sample
    or new.lower_slope_us_per_sample is distinct from old.lower_slope_us_per_sample or new.lower_intercept_us is distinct from old.lower_intercept_us
    or new.upper_slope_us_per_sample is distinct from old.upper_slope_us_per_sample or new.upper_intercept_us is distinct from old.upper_intercept_us
    or new.classification_overcount_samples is distinct from old.classification_overcount_samples
    or new.supported_duration_max_seconds is distinct from old.supported_duration_max_seconds
    or new.supported_anchor_cadence_ms is distinct from old.supported_anchor_cadence_ms
    or new.supported_stall_max_ms is distinct from old.supported_stall_max_ms or new.supported_drift_ppm is distinct from old.supported_drift_ppm
    or new.evidence_digest is distinct from old.evidence_digest or new.evidence_refs is distinct from old.evidence_refs
    or new.acceptance_note is distinct from old.acceptance_note
    or (old.accepted_at is not null and (new.accepted_at is distinct from old.accepted_at or new.accepted_by is distinct from old.accepted_by))
    or (old.accepted_at is null and new.accepted_at is null and new.accepted_by is distinct from old.accepted_by)
  ) then
    raise exception 'provider-window policy contents are immutable; create a new version' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists dialpad_recording_provider_window_policy_guard on public.dialpad_recording_provider_window_policies;
create trigger dialpad_recording_provider_window_policy_guard
before update on public.dialpad_recording_provider_window_policies
for each row execute function public.dialpad_recording_provider_window_policy_guard();

revoke all on function public.dialpad_recording_provider_window_policy_guard() from public,anon,authenticated,service_role;

create index dialpad_recording_provider_window_results_activity_idx
  on public.dialpad_recording_provider_window_results(org_id, call_activity_id, evaluated_at desc);
create index dialpad_recording_provider_window_policies_active_idx
  on public.dialpad_recording_provider_window_policies(org_id, policy_version)
  where accepted_at is not null and revoked_at is null;

alter table public.dialpad_recording_provider_window_policies enable row level security;
alter table public.dialpad_recording_provider_window_results enable row level security;
revoke all on table public.dialpad_recording_provider_window_policies from public, anon, authenticated, service_role;
revoke all on table public.dialpad_recording_provider_window_results from public, anon, authenticated, service_role;
grant select on public.dialpad_recording_provider_window_results to service_role;

create or replace function public.dialpad_recording_provider_window_add_reason(p_reasons text[], p_reason text)
returns text[] language sql immutable set search_path = '' as $$
  select case when p_reason = any(coalesce(p_reasons, '{}'::text[])) then coalesce(p_reasons, '{}')
    else array_append(coalesce(p_reasons, '{}'), p_reason) end;
$$;

-- One STABLE read assembles every mutable input. The result digest is the
-- freshness fence used by both finalization and KPI reads.
create or replace function public.dialpad_recording_provider_window_input(
  p_org_id uuid, p_capture_id uuid, p_policy_version text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c public.dialpad_recording_captures%rowtype;
  p public.dialpad_recording_provider_window_policies%rowtype;
  epoch_count integer := 0;
  selected_epoch smallint;
  tab_eof bigint;
  observed bigint := 0;
  clipped bigint := 0;
  eligible bigint;
  lower_sample bigint;
  upper_sample bigint;
  connected_count bigint := 0;
  ended_count bigint := 0;
  provider_count bigint := 0;
  connected_us bigint;
  ended_us bigint;
  timing_count bigint := 0;
  reason_list text[] := '{}';
  ranges jsonb := '[]'::jsonb;
  summary jsonb := '{}'::jsonb;
  base jsonb;
  manifest jsonb;
  digest text;
  r record;
begin
  if p_org_id is null or p_capture_id is null or p_policy_version is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into c from public.dialpad_recording_captures where id=p_capture_id and org_id=p_org_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if c.status not in ('sealed','partial','failed') then
    reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, 'capture_not_terminal');
  end if;
  select * into p from public.dialpad_recording_provider_window_policies
    where org_id=p_org_id and policy_version=p_policy_version;
  if not found then
    reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, 'policy_not_found');
  elsif p.accepted_at is null then
    reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, 'policy_not_accepted');
  elsif p.revoked_at is not null then
    reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, 'policy_revoked');
  end if;

  select count(distinct epoch), min(epoch)::smallint into epoch_count, selected_epoch
    from public.dialpad_recording_ingest_grants
   where capture_id=p_capture_id and org_id=p_org_id and consumed_at is not null;
  if epoch_count <> 1 then
    reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, case when epoch_count=0 then 'missing_consumed_epoch' else 'multiple_consumed_epochs' end);
  end if;

  if selected_epoch is not null then
    if (select count(*) from public.dialpad_recording_track_finals where capture_id=p_capture_id and org_id=p_org_id and epoch=selected_epoch and track in ('tab','mic') and completeness='complete' and decode_ok and eof_verified and contiguous) <> 2 then
      reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, 'incomplete_track_finals');
    end if;
    if (select count(*) from public.dialpad_recording_pcm_progress where capture_id=p_capture_id and org_id=p_org_id and epoch=selected_epoch and track in ('tab','mic') and pcm_eof_sample is not null and processed_through_sample=pcm_eof_sample and degraded_reasons='[]'::jsonb) <> 2 then
      reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, 'incomplete_pcm_eof');
    end if;
    select processed_through_sample into tab_eof from public.dialpad_recording_pcm_progress where capture_id=p_capture_id and org_id=p_org_id and epoch=selected_epoch and track='tab' and pcm_eof_sample=processed_through_sample;
    if tab_eof is null then tab_eof := 0; end if;
    if exists (select 1 from public.dialpad_recording_vad_ranges where capture_id=p_capture_id and org_id=p_org_id and epoch=selected_epoch and (start_sample < 0 or end_sample > tab_eof)) then
      reason_list := public.dialpad_recording_provider_window_add_reason(reason_list, 'vad_out_of_pcm_bounds');
    end if;
    select coalesce(sum(upper(u.r)-lower(u.r)),0)::bigint into observed
      from (select unnest(range_agg(int8range(start_sample,end_sample,'[)'))) r
              from public.dialpad_recording_vad_ranges
             where capture_id=p_capture_id and org_id=p_org_id and track='tab' and epoch=selected_epoch) u;
    select coalesce(jsonb_agg(jsonb_build_object('startSample',lower(u.r),'endSample',upper(u.r)) order by lower(u.r)), '[]'::jsonb)
      into ranges
      from (select unnest(range_agg(int8range(start_sample,end_sample,'[)'))) r
              from public.dialpad_recording_vad_ranges
             where capture_id=p_capture_id and org_id=p_org_id and track='tab' and epoch=selected_epoch) u;
  end if;

  select count(distinct public.dialpad_cti_payload_ms(e.payload,'date_connected')) filter (where public.dialpad_cti_payload_ms(e.payload,'date_connected') is not null),
         count(distinct public.dialpad_cti_payload_ms(e.payload,'date_ended')) filter (where public.dialpad_cti_payload_ms(e.payload,'date_ended') is not null),
         count(distinct e.provider_call_id),
         min(public.dialpad_cti_payload_ms(e.payload,'date_connected')),
         max(public.dialpad_cti_payload_ms(e.payload,'date_ended'))
    into connected_count, ended_count, provider_count, connected_us, ended_us
    from public.dialpad_call_events e
   where e.org_id=p_org_id and e.disposition='matched'
     and (e.matched_intent_id=c.intent_id or e.provider_call_id=c.provider_call_id)
     and e.id in (select event_id from public.dialpad_recording_shadow_relevant_events(p_org_id,p_capture_id));
  if connected_count <> 1 then reason_list := public.dialpad_recording_provider_window_add_reason(reason_list,'provider_connected_boundary'); end if;
  if ended_count <> 1 then reason_list := public.dialpad_recording_provider_window_add_reason(reason_list,'provider_ended_boundary'); end if;
  if provider_count <> 1 then reason_list := public.dialpad_recording_provider_window_add_reason(reason_list,'provider_leg_ambiguous'); end if;
  if connected_us is not null and ended_us is not null and ended_us < connected_us then reason_list := public.dialpad_recording_provider_window_add_reason(reason_list,'provider_boundary_reversed'); end if;
  if exists (select 1 from public.dialpad_call_events e where e.org_id=p_org_id and e.id in (select event_id from public.dialpad_recording_shadow_relevant_events(p_org_id,p_capture_id)) and e.payload->>'is_transferred'='true') then
    reason_list := public.dialpad_recording_provider_window_add_reason(reason_list,'provider_transfer');
  end if;

  select count(*) into timing_count from public.dialpad_recording_timing_records where capture_id=p_capture_id and org_id=p_org_id and epoch=selected_epoch;
  if selected_epoch is null or not exists (select 1 from public.dialpad_recording_timing_state where capture_id=p_capture_id and org_id=p_org_id and epoch=selected_epoch and status='collected') or timing_count=0 then
    reason_list := public.dialpad_recording_provider_window_add_reason(reason_list,'timing_not_collected');
  end if;

  if p.accepted_at is not null and p.revoked_at is null and selected_epoch is not null and connected_count=1 and ended_count=1 and provider_count=1 and connected_us is not null and ended_us is not null and ended_us >= connected_us and tab_eof > 0 and epoch_count=1 then
    lower_sample := greatest(0::bigint, p.domain_start_sample, ceil((connected_us::numeric - p.lower_intercept_us) / p.lower_slope_us_per_sample)::bigint);
    upper_sample := least(tab_eof, p.domain_end_sample, floor((ended_us::numeric - p.upper_intercept_us) / p.upper_slope_us_per_sample)::bigint);
    if upper_sample < lower_sample then upper_sample := lower_sample; end if;
    select coalesce(sum(greatest(0::bigint, least(upper_sample, upper(u.r)::bigint)-greatest(lower_sample, lower(u.r)::bigint))),0)::bigint into clipped
      from (select unnest(range_agg(int8range(start_sample,end_sample,'[)'))) r
              from public.dialpad_recording_vad_ranges
             where capture_id=p_capture_id and org_id=p_org_id and track='tab' and epoch=selected_epoch) u;
    eligible := greatest(0::bigint, clipped - ceil(p.classification_overcount_samples)::bigint);
  end if;

  if cardinality(reason_list) = 0 and eligible is not null then
    if eligible > 4800000 then reason_list := array['eligible']; else reason_list := array['below_threshold']; end if;
  elsif cardinality(reason_list) = 0 then
    reason_list := array['unsupported'];
  end if;
  summary := jsonb_build_object('providerCallId', c.provider_call_id, 'connectedUs', connected_us, 'endedUs', ended_us, 'timingRecords', timing_count);
  manifest := jsonb_build_object('captureId',p_capture_id,'orgId',p_org_id,'epoch',selected_epoch,'policyVersion',p_policy_version,'policyHash',coalesce(p.policy_hash,repeat('0',64)),'observedSamples',observed,'sampleWindow',jsonb_build_object('lowerSample',lower_sample,'upperSample',upper_sample),'ranges',ranges,'summary',summary,'reasons',to_jsonb(reason_list));
  digest := encode(extensions.digest(convert_to(manifest::text,'utf8'),'sha256'),'hex');
  return jsonb_build_object('algorithmVersion','provider-window-finalizer-v1','policyVersion',p_policy_version,'policyHash',coalesce(p.policy_hash,repeat('0',64)),'epoch',selected_epoch,'inputDigest',digest,'observedSamples',observed,'eligibleSamples',case when cardinality(reason_list)=1 and (reason_list[1] in ('eligible','below_threshold')) then eligible else null end,'status',case when cardinality(reason_list)=1 and reason_list[1]='eligible' then 'eligible' when cardinality(reason_list)=1 and reason_list[1]='below_threshold' then 'ineligible' else 'unknown' end,'reasons',to_jsonb(reason_list),'sampleWindow',jsonb_build_object('lowerSample',lower_sample,'upperSample',upper_sample),'selectedSummary',summary);
end;
$$;

create or replace function public.fn_get_dialpad_recording_final_input(p_org_id uuid,p_capture_id uuid,p_policy_version text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.dialpad_recording_provider_window_input(p_org_id,p_capture_id,p_policy_version);
$$;

create or replace function public.fn_finalize_dialpad_recording_provider_window(
  p_org_id uuid,p_capture_id uuid,p_policy_version text,p_expected_input_digest text
) returns jsonb language plpgsql security definer volatile set search_path = '' as $$
declare
  c public.dialpad_recording_captures%rowtype;
  v_input jsonb;
  v_existing public.dialpad_recording_provider_window_results%rowtype;
  v_replayed boolean := false;
begin
  if p_org_id is null or p_capture_id is null or p_policy_version is null or p_expected_input_digest is null or p_expected_input_digest !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  select * into c from public.dialpad_recording_captures where id=p_capture_id and org_id=p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  perform 1 from public.dialpad_recording_vad_totals where capture_id=p_capture_id and org_id=p_org_id for update;
  select * into v_existing from public.dialpad_recording_provider_window_results where capture_id=p_capture_id and org_id=p_org_id for update;
  v_input := public.dialpad_recording_provider_window_input(p_org_id,p_capture_id,p_policy_version);
  if v_input->>'inputDigest' <> p_expected_input_digest then raise exception 'FINAL_INPUT_CHANGED' using errcode='40001', detail='final_input_changed'; end if;
  if found and v_existing.input_digest=v_input->>'inputDigest' then
    v_replayed := true;
  else
    insert into public.dialpad_recording_provider_window_results(capture_id,org_id,call_activity_id,intent_id,epoch,provider_call_id,policy_version,policy_hash,algorithm_version,input_digest,observed_samples,eligible_samples,status,reasons,sample_window,selected_summary)
    values (p_capture_id,p_org_id,c.call_activity_id,c.intent_id,coalesce((v_input->>'epoch')::smallint,1),c.provider_call_id,v_input->>'policyVersion',v_input->>'policyHash',v_input->>'algorithmVersion',v_input->>'inputDigest',(v_input->>'observedSamples')::bigint,(v_input->>'eligibleSamples')::bigint,v_input->>'status',v_input->'reasons',v_input->'sampleWindow',v_input->'selectedSummary')
    on conflict (capture_id) do update set call_activity_id=excluded.call_activity_id,intent_id=excluded.intent_id,epoch=excluded.epoch,provider_call_id=excluded.provider_call_id,policy_version=excluded.policy_version,policy_hash=excluded.policy_hash,algorithm_version=excluded.algorithm_version,input_digest=excluded.input_digest,observed_samples=excluded.observed_samples,eligible_samples=excluded.eligible_samples,status=excluded.status,reasons=excluded.reasons,sample_window=excluded.sample_window,selected_summary=excluded.selected_summary,evaluated_at=now();
  end if;
  return v_input || jsonb_build_object('replayed',v_replayed);
end;
$$;

-- Bounded browser-independent reconciliation selection. It uses terminal
-- capture/result state as the durable work signal; duplicate workers are safe
-- because finalization is digest-fenced and replayable.
create or replace function public.fn_list_dialpad_recording_provider_window_candidates(p_limit integer default 25)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('orgId',q.org_id,'captureId',q.capture_id,'policyVersion',q.policy_version) order by q.result_at,q.capture_id),'[]'::jsonb)
    from (
      select c.org_id,c.id as capture_id,c.result_at,p.policy_version
        from public.dialpad_recording_captures c
        join lateral (
          select policy_version from public.dialpad_recording_provider_window_policies p
           where p.org_id=c.org_id and p.accepted_at is not null and p.revoked_at is null
           order by p.accepted_at desc,p.policy_version desc limit 1
        ) p on true
        left join public.dialpad_recording_provider_window_results r on r.capture_id=c.id and r.org_id=c.org_id
       where c.status in ('sealed','partial','failed')
         and (r.capture_id is null or r.input_digest is distinct from (public.dialpad_recording_provider_window_input(c.org_id,c.id,r.policy_version)->>'inputDigest') or r.policy_version is distinct from p.policy_version)
       order by c.result_at,c.id
       limit greatest(1,least(coalesce(p_limit,25),100))
    ) q;
$$;

create or replace function public.fn_get_dialpad_recording_provider_window_result(p_org_id uuid,p_rep_user_id uuid,p_capture_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.dialpad_recording_provider_window_results%rowtype; c public.dialpad_recording_captures%rowtype; current_digest text;
begin
  select * into c from public.dialpad_recording_captures where id=p_capture_id and org_id=p_org_id and rep_user_id=p_rep_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select * into r from public.dialpad_recording_provider_window_results where capture_id=p_capture_id and org_id=p_org_id;
  if not found then return jsonb_build_object('status','pending','currentAtRead',false,'result',null); end if;
  current_digest := public.dialpad_recording_provider_window_input(p_org_id,p_capture_id,r.policy_version)->>'inputDigest';
  return jsonb_build_object('status',case when current_digest=r.input_digest then r.status else 'stale' end,'currentAtRead',current_digest=r.input_digest,'currentInputDigest',current_digest,'result',jsonb_build_object('captureId',r.capture_id,'observedSamples',r.observed_samples,'eligibleSamples',r.eligible_samples,'status',r.status,'reasons',r.reasons,'evaluatedAt',r.evaluated_at));
end;
$$;

-- Add the narrow durable latch and current final-result summary to the
-- existing private browser projection. Raw provider/timing evidence remains
-- excluded; a terminal capture can therefore be refreshed after the browser
-- has gone away.
create or replace function public.fn_get_dialpad_recording_browser_status(
  p_org_id uuid, p_rep_user_id uuid, p_capture_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c public.dialpad_recording_captures%rowtype;
  endpoint text;
  epoch integer;
  total_samples bigint;
  measurement_status text;
  latch public.dialpad_recording_vad_threshold_latches%rowtype;
  result_row public.dialpad_recording_provider_window_results%rowtype;
  current_digest text;
begin
  if p_org_id is null or p_rep_user_id is null or p_capture_id is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  select * into c from public.dialpad_recording_captures where id=p_capture_id and org_id=p_org_id and rep_user_id=p_rep_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
  select con.recording_ingest_endpoint into endpoint from public.dialpad_call_intents i join public.dialpad_org_connections con on con.id=i.connection_id and con.org_id=i.org_id where i.id=c.intent_id and i.org_id=p_org_id;
  select coalesce(max(g.epoch),0) into epoch from public.dialpad_recording_ingest_grants g where g.capture_id=p_capture_id and g.consumed_at is not null;
  select coalesce(t.voiced_samples,0),coalesce(t.measurement_status,'provisional') into total_samples,measurement_status from public.dialpad_recording_vad_totals t where t.capture_id=p_capture_id and t.org_id=p_org_id;
  select * into latch from public.dialpad_recording_vad_threshold_latches where capture_id=p_capture_id and org_id=p_org_id;
  select * into result_row from public.dialpad_recording_provider_window_results where capture_id=p_capture_id and org_id=p_org_id;
  if result_row.capture_id is not null then current_digest := public.dialpad_recording_provider_window_input(p_org_id,p_capture_id,result_row.policy_version)->>'inputDigest'; end if;
  return jsonb_build_object(
    'captureId',c.id,'captureStatus',c.status,'closedAt',c.closed_at,'drainDeadlineAt',c.drain_deadline_at,
    'latestConsumedEpoch',epoch,'ingestEndpoint',endpoint,'controlVersion',2,'tracks',jsonb_build_array('tab','mic'),
    'totalSamples',coalesce(total_samples,0),'measurementStatus',measurement_status,
    'crossing',case when latch.capture_id is null then null else jsonb_build_object('status','latched','thresholdSamples',latch.threshold_samples,'crossingTotalSamples',latch.crossing_total_samples,'crossingEpoch',latch.crossing_epoch,'crossingSample',latch.crossing_sample,'crossingStartSample',latch.crossing_start_sample,'crossingEndSample',latch.crossing_end_sample) end,
    'finalResult',case when result_row.capture_id is null then null else jsonb_build_object('status',case when current_digest=result_row.input_digest then result_row.status else 'stale' end,'observedSamples',result_row.observed_samples,'eligibleSamples',case when current_digest=result_row.input_digest then result_row.eligible_samples else null end,'reasons',result_row.reasons,'evaluatedAt',result_row.evaluated_at) end
  );
end;
$$;

-- Use the result only when its digest and policy are fresh in this same
-- statement. Non-Dialpad rows preserve the connected-duration rule.
create or replace function public.dialpad_recording_provider_window_is_eligible(p_org_id uuid,p_capture_id uuid,p_call_activity_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.dialpad_recording_provider_window_results r
    join public.dialpad_recording_provider_window_policies p on p.org_id=r.org_id and p.policy_version=r.policy_version
    where r.org_id=p_org_id and r.capture_id=p_capture_id and r.call_activity_id=p_call_activity_id
      and r.status='eligible' and r.eligible_samples>4800000 and p.accepted_at is not null and p.revoked_at is null and r.policy_hash=p.policy_hash
      and r.input_digest=(public.dialpad_recording_provider_window_input(r.org_id,r.capture_id,r.policy_version)->>'inputDigest')
  );
$$;

-- Preserve every KPI field and every non-Dialpad branch; only the Dialpad
-- long-call predicate moves behind the fresh finalizer result.
create or replace function public.fn_get_acquisition_kpis(p_org_id uuid,p_member_id uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_at timestamptz:=statement_timestamp(); v_today_start timestamptz:=date_trunc('day',v_at at time zone 'America/Chicago') at time zone 'America/Chicago'; v_attempts bigint; v_reached bigint; v_pending bigint; v_offers bigint; v_last timestamptz; v_contact bigint; v_needs_offer bigint; v_overdue bigint; v_missing bigint; v_recording_unknown bigint; v_talk_samples bigint; v_talk_unknown bigint; v_talk_average double precision; v_long bigint; v_properties uuid[]; v_stale bigint; v_samples bigint; v_first_pending bigint; v_first_seconds double precision; v_due bigint; v_held bigint; v_unattributed bigint;
begin
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end<=p_start then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  select count(*),count(*) filter(where outcome='reached'),count(*) filter(where outcome is null) into v_attempts,v_reached,v_pending from public.acquisition_attempts where org_id=p_org_id and actor_user_id=p_member_id and occurred_at>=p_start and occurred_at<p_end;
  select max(occurred_at) into v_last from public.acquisition_attempts where org_id=p_org_id and actor_user_id=p_member_id and attempt_kind='call' and occurred_at>=v_today_start and occurred_at<=v_at;
  select count(*) into v_offers from public.acquisition_offers where org_id=p_org_id and actor_user_id=p_member_id and sent_at>=p_start and sent_at<p_end;
  with queue as materialized (select * from public.my_leads_queue_rows(p_org_id,p_member_id,v_at)) select count(*) filter(where q.stage='needs_offer'),count(*) filter(where q.stage='contacted' and not exists(select 1 from public.tasks t where t.org_id=p_org_id and t.related_property_id=q.property_id and t.type='appointment' and t.status in ('open','snoozed') and greatest(t.due_at,case when t.status='snoozed' then t.snoozed_until end)>v_at)),array_agg(q.property_id),count(*) filter(where q.warning_rank>0) into v_needs_offer,v_contact,v_properties,v_stale from queue q;
  select count(*) into v_overdue from public.tasks t where t.org_id=p_org_id and t.assignee_id=p_member_id and t.related_property_id is not null and t.type='appointment' and t.status in ('open','snoozed') and t.due_at<=v_at and t.related_property_id=any(v_properties);
  select count(*) filter(where coalesce(c.provider_ended_at,c.ended_at,c.started_at,a.occurred_at)<=v_at-interval '5 minutes' and nullif(btrim(c.recording_path),'') is null and nullif(btrim(a.recording_url),'') is null and not exists(select 1 from public.call_recordings r where r.call_activity_id=c.id and r.status='available' and nullif(btrim(r.storage_path),'') is not null)),count(*) filter(where false),count(*) filter(where a.outcome='reached' and c.talk_duration_seconds is not null),count(*) filter(where a.outcome='reached' and c.talk_duration_seconds is null),avg(c.talk_duration_seconds) filter(where a.outcome='reached' and c.talk_duration_seconds is not null),count(*) filter(where a.outcome='reached' and ((c.provider='dialpad' and exists (select 1 from public.dialpad_recording_captures rc where rc.org_id=a.org_id and rc.call_activity_id=a.call_activity_id and public.dialpad_recording_provider_window_is_eligible(a.org_id,rc.id,a.call_activity_id))) or (c.provider is distinct from 'dialpad' and c.talk_duration_seconds>300))) into v_missing,v_recording_unknown,v_talk_samples,v_talk_unknown,v_talk_average,v_long from public.acquisition_attempts a left join public.call_activities c on c.id=a.call_activity_id and c.org_id=a.org_id and c.property_id=a.property_id where a.org_id=p_org_id and a.actor_user_id=p_member_id and a.attempt_kind='call' and a.occurred_at>=p_start and a.occurred_at<p_end;
  select count(*) filter(where first_call_started_at is not null),count(*) filter(where first_call_started_at is null),avg(extract(epoch from(first_call_started_at-assigned_at))) filter(where first_call_started_at is not null) into v_samples,v_first_pending,v_first_seconds from public.acquisition_assignment_episodes where org_id=p_org_id and assignee_user_id=p_member_id and eligible and episode_kind='live' and assigned_at>=p_start and assigned_at<p_end;
  select count(*),count(*) filter(where t.outcome='held') into v_due,v_held from public.tasks t join public.acquisition_appointment_attribution a on a.task_id=t.id and a.org_id=t.org_id where t.org_id=p_org_id and a.accountable_user_id=p_member_id and t.type='appointment' and t.related_property_id is not null and t.status<>'cancelled' and t.outcome is distinct from 'rescheduled' and t.due_at>=p_start and t.due_at<p_end;
  select count(*) into v_unattributed from public.tasks t where t.org_id=p_org_id and t.type='appointment' and t.related_property_id is not null and t.status<>'cancelled' and t.outcome is distinct from 'rescheduled' and t.due_at>=p_start and t.due_at<p_end and not exists(select 1 from public.acquisition_appointment_attribution a where a.task_id=t.id and a.org_id=t.org_id);
  return jsonb_build_object('firstCallSamples',v_samples,'firstCallPending',v_first_pending,'firstCallElapsedSeconds',v_first_seconds,'appointmentsDue',v_due,'appointmentsHeld',v_held,'orgAppointmentsUnattributed',v_unattributed,'staleLeads',v_stale,'attempts',v_attempts,'reached',v_reached,'pendingOutcomes',v_pending,'offersSent',v_offers,'contactWithoutFollowUp',v_contact,'needsOffers',v_needs_offer,'appointmentsOverdue',v_overdue,'lastAttemptAt',v_last,'lastAttemptClockVersion',1,'asOf',v_at,'missingRecordings',v_missing,'recordingExpectationUnknown',v_recording_unknown,'averageTalkSeconds',v_talk_average,'talkTimeSamples',v_talk_samples,'talkTimeUnknown',v_talk_unknown,'conversationsOverFiveMinutes',v_long);
end;
$$;

revoke all on function public.dialpad_recording_provider_window_add_reason(text[],text) from public,anon,authenticated,service_role;
revoke all on function public.dialpad_recording_provider_window_input(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.fn_list_dialpad_recording_provider_window_candidates(integer) from public,anon,authenticated;
revoke all on function public.fn_get_dialpad_recording_final_input(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.fn_finalize_dialpad_recording_provider_window(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.fn_get_dialpad_recording_provider_window_result(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.dialpad_recording_provider_window_is_eligible(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_list_dialpad_recording_provider_window_candidates(integer) to service_role;
grant execute on function public.fn_get_dialpad_recording_final_input(uuid,uuid,text) to service_role;
grant execute on function public.fn_finalize_dialpad_recording_provider_window(uuid,uuid,text,text) to service_role;
grant execute on function public.fn_get_dialpad_recording_provider_window_result(uuid,uuid,uuid) to service_role;

commit;
