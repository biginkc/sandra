begin;

-- Preserve the existing matching, tenant checks, side effects and receipt in
-- one transaction. The new evidence is accepted only by the signed provider
-- endpoint, never by browser completion or inferred from elapsed call time.
alter function public.jitter_writeback_call_activity(text,jsonb,uuid,text,text,uuid,text,text)
  rename to jitter_writeback_call_activity_before_metrics;
revoke all on function public.jitter_writeback_call_activity_before_metrics(text,jsonb,uuid,text,text,uuid,text,text)
  from public, anon, authenticated, service_role;

create function public.jitter_writeback_call_activity(
  p_attempt_id text, p_body jsonb, p_callback_assignee_id uuid,
  p_external_id text, p_notes text, p_org_id uuid,
  p_recording_path text, p_request_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb;
  v_talk numeric;
  v_expected boolean;
  v_activity public.call_activities%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;
  if p_body->'talk_duration_seconds' is not null and p_body->'talk_duration_seconds' <> 'null'::jsonb then
    if jsonb_typeof(p_body->'talk_duration_seconds') <> 'number' then
      raise exception 'invalid talk duration' using errcode='22023';
    end if;
    v_talk := (p_body->>'talk_duration_seconds')::numeric;
    if v_talk < 0 or v_talk > 2147483647 or trunc(v_talk) <> v_talk then
      raise exception 'invalid talk duration' using errcode='22023';
    end if;
  end if;
  if p_body->'recording_expected' is not null and p_body->'recording_expected' <> 'null'::jsonb then
    if jsonb_typeof(p_body->'recording_expected') <> 'boolean' then
      raise exception 'invalid recording expectation' using errcode='22023';
    end if;
    v_expected := (p_body->>'recording_expected')::boolean;
  end if;

  if p_body ? 'call_evidence_version' then
    if p_body->'call_evidence_version' is distinct from '1'::jsonb or nullif(p_body->>'ended_at','') is null
      or not isfinite((p_body->>'ended_at')::timestamptz) then
      raise exception 'invalid call evidence version or end' using errcode='22023';
    end if;
    if (p_body->>'org_id')::uuid is distinct from p_org_id then
      raise exception 'jitter coherence check failed';
    end if;
    select * into v_activity from public.call_activities
      where org_id=p_org_id and jitter_attempt_id=p_attempt_id
        and jitter_session_id=p_body->>'jitter_session_id'
        and provider=p_body->>'provider'
      for update;
    if not found then
      raise exception 'call evidence requires existing activity';
    end if;
    if nullif(btrim(p_body->>'provider_call_id'),'') is null
      or p_body->>'provider_call_id' is distinct from v_activity.provider_call_id
      or (p_body->>'property_id' is not null and (p_body->>'property_id')::uuid is distinct from v_activity.property_id)
      or (p_body->>'contact_id' is not null and (p_body->>'contact_id')::uuid is distinct from v_activity.contact_id)
      or (p_body->>'operator_user_id' is not null and (p_body->>'operator_user_id')::uuid is distinct from v_activity.operator_user_id) then
      raise exception 'call evidence identity mismatch' using errcode='22023';
    end if;
    update public.call_activities
      set talk_duration_seconds=coalesce(v_talk::integer,talk_duration_seconds),
          recording_expected=coalesce(v_expected,recording_expected),
          provider_ended_at=(p_body->>'ended_at')::timestamptz,
          ended_at=(p_body->>'ended_at')::timestamptz
      where id=v_activity.id;
    v_payload := jsonb_build_object('call_activity',jsonb_build_object('id',v_activity.id,'provider',v_activity.provider));
    update public.webhook_events set payload=v_payload, processing_status='processed', processed_at=statement_timestamp()
      where org_id=p_org_id and provider='jitter' and event_type='call_activity_writeback'
        and external_id=p_external_id and processing_status='pending' and request_hash=p_request_hash;
    if not found then
      raise exception 'idempotency reservation missing or hash mismatch';
    end if;
    return v_payload;
  end if;

  v_payload := public.jitter_writeback_call_activity_before_metrics(
    p_attempt_id,p_body,p_callback_assignee_id,p_external_id,p_notes,
    p_org_id,p_recording_path,p_request_hash
  );
  if v_payload->'call_activity'->>'id' is not null and (v_talk is not null or v_expected is not null) then
    update public.call_activities
      set talk_duration_seconds = coalesce(v_talk::integer,talk_duration_seconds),
          recording_expected = coalesce(v_expected,recording_expected)
      where id=(v_payload->'call_activity'->>'id')::uuid and org_id=p_org_id and provider_ended_at is null;

  end if;
  -- A delayed ordinary writeback cannot replace the provider's terminal time.
  update public.call_activities set ended_at=provider_ended_at
    where id=(v_payload->'call_activity'->>'id')::uuid and org_id=p_org_id
      and provider_ended_at is not null and ended_at is distinct from provider_ended_at;
  return v_payload;
end;
$$;
revoke all on function public.jitter_writeback_call_activity(text,jsonb,uuid,text,text,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.jitter_writeback_call_activity(text,jsonb,uuid,text,text,uuid,text,text)
  to service_role;

commit;
