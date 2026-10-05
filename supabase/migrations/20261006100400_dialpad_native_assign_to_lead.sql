-- My Leads one-call close, P2 data plane (2.5): "Assign to lead". A native call whose number matched several of
-- the rep's leads is quarantined 'ambiguous_lead' (2.4); the rep picks one here. Two new functions, no change to
-- any existing body, no data step. Inert until a call is quarantined ambiguous_lead (needs native_matcher).
begin;

-- The caller's own unresolved ambiguous calls from the last 14 days, candidates recomputed live.
create or replace function public.fn_list_ambiguous_native_calls(p_org_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dialpad_user text;
  v_user uuid := auth.uid();
begin
  if v_user is null or not public.dialpad_cti_member_is_active(p_org_id, v_user) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select b.dialpad_user_id into v_dialpad_user from public.dialpad_member_bindings b
    where b.org_id = p_org_id and b.user_id = v_user and b.status = 'verified';
  if v_dialpad_user is null then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'providerCallId', c.provider_call_id,
        'startedAtMs', c.started_ms,
        'direction', c.direction,
        'numberLast4', right(c.external_number, 4),
        'candidates', coalesce((
          select jsonb_agg(jsonb_build_object(
              'propertyId', p.id, 'contactId', k.contact_id, 'slot', k.slot,
              'address', p.address, 'city', p.city,
              'homeownerName', nullif(btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), ''),
              'stage', q.stage) order by p.address, p.id)
          from public.dialpad_cti_native_candidates(p_org_id, v_user, right(c.external_number, 10)) k
          join public.properties p on p.id = k.property_id and p.org_id = p_org_id
          join public.contacts ct on ct.id = k.contact_id
          left join public.acquisition_queue_states q on q.property_id = p.id and q.org_id = p_org_id
          where not k.is_dnc), '[]'::jsonb)
      ) order by c.started_ms desc)
    from (
      select e.provider_call_id, min(e.event_timestamp_ms) as started_ms,
             (array_agg(lower(e.payload ->> 'direction') order by e.event_timestamp_ms, e.id))[1] as direction,
             (array_agg(e.payload ->> 'external_number' order by e.event_timestamp_ms, e.id))[1] as external_number
      from public.dialpad_call_events e
      where e.org_id = p_org_id and e.disposition = 'quarantined' and e.disposition_reason = 'ambiguous_lead'
        and (e.payload -> 'target' ->> 'id') = v_dialpad_user
        and e.received_at >= now() - interval '14 days'
        and public.dialpad_cti_chain_root(e.provider_call_id, e.payload) = e.provider_call_id
        and not exists (select 1 from public.dialpad_call_intents i
                        where i.org_id = p_org_id and i.matched_provider_call_id = e.provider_call_id)
      group by e.provider_call_id
    ) c), '[]'::jsonb);
end $$;
revoke all on function public.fn_list_ambiguous_native_calls(uuid) from public, anon, service_role;
grant execute on function public.fn_list_ambiguous_native_calls(uuid) to authenticated;

-- Assign one ambiguous call to one of its candidate leads. Idempotent: a replay of a successful assignment returns
-- 'already_assigned'; a different lead for an already frozen call raises MLS01 (the non-retryable My Leads conflict).
create or replace function public.fn_assign_native_call_to_lead(
  p_org_id uuid, p_provider_call_id text, p_property_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_binding public.dialpad_member_bindings%rowtype;
  v_event public.dialpad_call_events%rowtype;
  v_intent public.dialpad_call_intents%rowtype;
  v_cand record;
  v_intent_id uuid;
  v_key text;
  v_attempt uuid;
  v_activity uuid;
  v_proc jsonb;
begin
  if v_user is null or not public.dialpad_cti_member_is_active(p_org_id, v_user) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_provider_call_id is null or p_provider_call_id !~ '^[0-9]{1,20}$' or p_property_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_binding from public.dialpad_member_bindings
    where org_id = p_org_id and user_id = v_user and status = 'verified';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- Earliest event of any disposition of this call that targets the caller's own Dialpad user.
  select * into v_event from public.dialpad_call_events e
    where e.org_id = p_org_id and e.provider_call_id = p_provider_call_id
      and (e.payload -> 'target' ->> 'id') = v_binding.dialpad_user_id
      and public.dialpad_cti_chain_root(e.provider_call_id, e.payload) = e.provider_call_id
    order by e.event_timestamp_ms, e.id limit 1;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  -- The same lock fn_process_dialpad_call_event takes, before any row lock.
  perform pg_advisory_xact_lock(hashtextextended('dialpad-chain:' || p_org_id::text || ':' || p_provider_call_id, 0));

  -- Inspect the frozen match FIRST: a successful assignment leaves no ambiguous_lead event, so a replay
  -- must be answered from the frozen intent, not refused for lack of an unresolved event.
  select * into v_intent from public.dialpad_call_intents i
    where i.org_id = p_org_id and i.matched_provider_call_id = p_provider_call_id;
  if found then
    if v_intent.rep_user_id <> v_user then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if v_intent.property_id <> p_property_id then
      raise exception 'STALE_STATE' using errcode = 'MLS01';
    end if;
    v_key := public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id);
    select a.id into v_attempt from public.acquisition_attempts a
      where a.org_id = p_org_id and a.source = 'dialpad' and a.provider_attempt_key = v_key;
    select c.id into v_activity from public.call_activities c
      where c.org_id = p_org_id and c.provider = 'dialpad' and c.jitter_attempt_id = v_key;
    return jsonb_build_object('status', 'already_assigned', 'intentId', v_intent.id,
      'attemptId', v_attempt, 'callActivityId', v_activity);
  end if;

  if not exists (select 1 from public.dialpad_call_events e
                 where e.org_id = p_org_id and e.disposition = 'quarantined' and e.disposition_reason = 'ambiguous_lead'
                   and (e.provider_call_id = p_provider_call_id or (e.payload ->> 'master_call_id') = p_provider_call_id)
                   and (e.payload -> 'target' ->> 'id') = v_binding.dialpad_user_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_cand from public.dialpad_cti_native_candidates(
      p_org_id, v_user, right(v_event.payload ->> 'external_number', 10)) k
    where k.property_id = p_property_id;
  if not found or v_cand.is_dnc then
    raise exception 'STALE_ASSIGNMENT' using errcode = '42501';
  end if;

  v_intent_id := public.dialpad_cti_native_bind(v_event.id, v_binding.id, v_cand.property_id, v_cand.contact_id, v_cand.slot);
  v_proc := public.fn_process_dialpad_call_event(v_event.id);
  return jsonb_build_object('status', 'assigned', 'intentId', v_intent_id,
    'attemptId', v_proc -> 'attemptId', 'callActivityId', v_proc -> 'callActivityId');
end $$;
revoke all on function public.fn_assign_native_call_to_lead(uuid, text, uuid) from public, anon, service_role;
grant execute on function public.fn_assign_native_call_to_lead(uuid, text, uuid) to authenticated;

commit;
