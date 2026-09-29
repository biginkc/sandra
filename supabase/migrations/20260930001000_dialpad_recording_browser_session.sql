-- Dialpad browser capture session authority.
--
-- This is a transport/bootstrap contract only. It does not project KPI state,
-- timing evidence, or private storage locators into the browser.

begin;

alter table public.dialpad_org_connections
  add column if not exists recording_ingest_endpoint text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.dialpad_org_connections'::regclass
       and conname = 'dialpad_org_connections_recording_endpoint_check'
  ) then
    alter table public.dialpad_org_connections
      add constraint dialpad_org_connections_recording_endpoint_check
      check (recording_ingest_endpoint is null
          or (length(recording_ingest_endpoint) between 16 and 2048
              and recording_ingest_endpoint ~ '^wss://[^[:space:]?#]+/dialpad-browser-ingest$'));
  end if;
end;
$$;

comment on column public.dialpad_org_connections.recording_ingest_endpoint is
  'Server-validated trusted WSS ingest endpoint. The browser receives this capability only after an authenticated capture grant; no token or storage path is stored here.';

-- Mint the next epoch from consumed grant history under the capture lock. The
-- expected epoch is an optimistic stale-session fence; consumed grants with
-- zero chunks still advance it. Unconsumed live grants are not rotated.
create or replace function public.fn_mint_dialpad_recording_next_epoch(
  p_org_id uuid, p_rep_user_id uuid, p_capture_id uuid,
  p_expected_consumed_epoch integer, p_token_hash text,
  p_ttl_seconds integer default 60
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_existing public.dialpad_recording_ingest_grants%rowtype;
  v_grant public.dialpad_recording_ingest_grants%rowtype;
  v_endpoint text;
  v_consumed integer;
  v_epoch integer;
begin
  if p_org_id is null or p_rep_user_id is null or p_capture_id is null
     or p_expected_consumed_epoch is null or p_expected_consumed_epoch not between 0 and 16
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_ttl_seconds is null or p_ttl_seconds not between 10 and 300 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- Capture first is the lock order used by close, consume and transport
  -- writers. All mutable authorization checks happen before token replay.
  select * into v_capture
    from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id and rep_user_id = p_rep_user_id
   for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.dialpad_cti_member_is_active(p_org_id, p_rep_user_id)
     or not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_rep_user_id and m.acquisitions_enabled) then
    return jsonb_build_object('status', 'denied', 'reason', 'rep_not_active');
  end if;
  if v_capture.status <> 'open' then
    return jsonb_build_object('status', 'denied', 'reason', 'capture_not_open');
  end if;
  if exists (select 1 from public.call_activities a where a.id = v_capture.call_activity_id and a.ended_at is not null) then
    return jsonb_build_object('status', 'denied', 'reason', 'call_ended');
  end if;

  select c.recording_ingest_endpoint into v_endpoint
    from public.dialpad_call_intents i
    join public.dialpad_org_connections c on c.id = i.connection_id and c.org_id = i.org_id
   where i.id = v_capture.intent_id and i.org_id = p_org_id;
  if v_endpoint is null then
    return jsonb_build_object('status', 'denied', 'reason', 'ingest_not_configured');
  end if;

  select * into v_existing
    from public.dialpad_recording_ingest_grants
   where token_hash = p_token_hash;
  if found then
    if v_existing.capture_id = p_capture_id and v_existing.rep_user_id = p_rep_user_id then
      return jsonb_build_object('status', 'replayed', 'grantId', v_existing.id, 'captureId', p_capture_id,
        'epoch', v_existing.epoch, 'expiresAt', v_existing.expires_at,
        'ingestEndpoint', v_endpoint, 'controlVersion', 2);
    end if;
    raise exception 'GRANT_CONFLICT' using errcode = '40001';
  end if;

  select coalesce(max(epoch), 0) into v_consumed
    from public.dialpad_recording_ingest_grants
   where capture_id = p_capture_id and consumed_at is not null;
  if p_expected_consumed_epoch <> v_consumed then
    return jsonb_build_object('status', 'denied', 'reason', 'epoch_stale', 'latestConsumedEpoch', v_consumed);
  end if;
  if exists (select 1 from public.dialpad_recording_ingest_grants g
              where g.capture_id = p_capture_id and g.consumed_at is null
                and g.revoked_at is null and g.expires_at > now()) then
    return jsonb_build_object('status', 'denied', 'reason', 'grant_pending', 'latestConsumedEpoch', v_consumed);
  end if;
  if (select count(*) from public.dialpad_recording_ingest_grants where capture_id = p_capture_id) >= 64 then
    return jsonb_build_object('status', 'denied', 'reason', 'grant_limit');
  end if;
  if v_consumed >= 16 then
    return jsonb_build_object('status', 'denied', 'reason', 'epoch_limit', 'latestConsumedEpoch', v_consumed);
  end if;

  v_epoch := v_consumed + 1;
  update public.dialpad_recording_ingest_grants set revoked_at = now()
   where capture_id = p_capture_id and consumed_at is null and revoked_at is null;
  insert into public.dialpad_recording_ingest_grants
    (org_id, capture_id, rep_user_id, epoch, token_hash, expires_at)
  values (p_org_id, p_capture_id, p_rep_user_id, v_epoch, p_token_hash, now() + make_interval(secs => p_ttl_seconds))
  returning * into v_grant;
  return jsonb_build_object('status', 'minted', 'grantId', v_grant.id, 'captureId', p_capture_id,
    'epoch', v_epoch, 'expiresAt', v_grant.expires_at,
    'ingestEndpoint', v_endpoint, 'controlVersion', 2);
end;
$$;

-- Private-path-free authoritative status/bootstrap projection. The caller
-- receives only the latest consumed watermark and safe transport metadata.
create or replace function public.fn_get_dialpad_recording_browser_status(
  p_org_id uuid, p_rep_user_id uuid, p_capture_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_capture public.dialpad_recording_captures%rowtype;
  v_endpoint text;
  v_epoch integer;
  v_total_samples bigint;
  v_measurement_status text;
begin
  if p_org_id is null or p_rep_user_id is null or p_capture_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_capture from public.dialpad_recording_captures
   where id = p_capture_id and org_id = p_org_id and rep_user_id = p_rep_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select c.recording_ingest_endpoint into v_endpoint
    from public.dialpad_call_intents i
    join public.dialpad_org_connections c on c.id = i.connection_id and c.org_id = i.org_id
   where i.id = v_capture.intent_id and i.org_id = p_org_id;
  select coalesce(max(epoch), 0) into v_epoch
    from public.dialpad_recording_ingest_grants
   where capture_id = p_capture_id and consumed_at is not null;
  select coalesce(t.voiced_samples, 0), coalesce(t.measurement_status, 'provisional')
    into v_total_samples, v_measurement_status
    from public.dialpad_recording_vad_totals t
   where t.capture_id = p_capture_id and t.org_id = p_org_id;
  return jsonb_build_object(
    'captureId', v_capture.id, 'captureStatus', v_capture.status,
    'closedAt', v_capture.closed_at, 'drainDeadlineAt', v_capture.drain_deadline_at,
    'latestConsumedEpoch', v_epoch, 'ingestEndpoint', v_endpoint,
    'controlVersion', 2, 'tracks', jsonb_build_array('tab', 'mic'),
    'totalSamples', coalesce(v_total_samples, 0), 'measurementStatus', coalesce(v_measurement_status, 'provisional'));
end;
$$;

revoke all on function public.fn_mint_dialpad_recording_next_epoch(uuid, uuid, uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.fn_get_dialpad_recording_browser_status(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_mint_dialpad_recording_next_epoch(uuid, uuid, uuid, integer, text, integer) to service_role;
grant execute on function public.fn_get_dialpad_recording_browser_status(uuid, uuid, uuid) to service_role;

commit;
