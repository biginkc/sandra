-- My Leads one-call close, P2 data plane (2.4): native-call matching (D4). A call Jarrad dials (or takes)
-- outside Sandra carries no custom_data; today every such event is quarantined 'no_custom_data'. This adds
-- a branch that matches it to ONE lead by exact 10-digit number against contacts on properties assigned to
-- the rep, behind the per-org native_matcher flag (missing table, row or column reads OFF).
--
--   one live lead   -> a synthetic matched intent (origin 'native'); the unchanged projection then creates
--                      the activity and (outbound only) the pending attempt keyed 'dialpad-native:<call id>'
--   several leads   -> quarantined 'ambiguous_lead' (not 'received', which the one-minute sweep would
--                      re-drive forever); 2.5's Assign to lead resolves it
--   none            -> quarantined 'no_lead_match'; all-DNC -> 'dnc_number'; no verified rep -> 'no_binding'
--
-- Semantic preservation: the legacy matcher is RENAMED, not copied; the new dialpad_cti_resolve_event calls it
-- and only intercepts a quarantined 'no_custom_data' result, so any event that carries custom_data (including an
-- unknown token) behaves exactly as before. dialpad_cti_project_intent and fn_process_dialpad_call_event are
-- patched in place by anchored replacement (asserted, idempotent). No data step.
begin;

-- Rename the live matcher wrapper to *_legacy once; on re-application (a stale older body re-created under the
-- original name) refresh the legacy copy from it.
do $rename$
begin
  if to_regprocedure('public.dialpad_cti_resolve_event(uuid)') is not null
     and position('dialpad_cti_native_resolve' in pg_get_functiondef('public.dialpad_cti_resolve_event(uuid)'::regprocedure)) = 0 then
    if to_regprocedure('public.dialpad_cti_resolve_event_legacy(uuid)') is not null then
      drop function public.dialpad_cti_resolve_event_legacy(uuid);
    end if;
    alter function public.dialpad_cti_resolve_event(uuid) rename to dialpad_cti_resolve_event_legacy;
  end if;
end $rename$;

create or replace function public.dialpad_cti_native_candidates(p_org uuid, p_user uuid, p_digits10 text)
returns table(property_id uuid, contact_id uuid, slot smallint, episode_id uuid, is_training boolean, is_dnc boolean)
language sql stable security definer set search_path = '' as $$
  select x.property_id, x.contact_id, x.slot, x.episode_id, x.is_training, x.is_dnc
  from (
    select distinct on (p.id) p.id as property_id, cpn.contact_id, cpn.slot, e.id as episode_id, p.is_training,
           (coalesce(p.is_dnc_locked, false) or p.status::text = 'dnc' or coalesce(c.do_not_contact, false)
            or exists (select 1 from public.global_phone_dnc_registry r
                       where r.org_id = p_org and r.phone_e164 = cpn.e164)) as is_dnc
    from public.contact_phone_numbers cpn
    join public.contacts c on c.id = cpn.contact_id and c.org_id = p_org
    join public.properties p on p.org_id = p_org and p.assigned_user_id = p_user and p.deleted_at is null
         and p.status::text not in ('closed', 'dead')
         and (p.homeowner_contact_id = c.id or exists (
               select 1 from public.property_contacts pc
               where pc.org_id = p_org and pc.property_id = p.id and pc.contact_id = c.id))
    join public.acquisition_assignment_episodes e on e.property_id = p.id and e.org_id = p_org
         and e.ended_at is null and e.assignee_user_id = p_user
    left join public.acquisition_queue_states q on q.property_id = p.id and q.org_id = p_org
    where cpn.org_id = p_org and cpn.digits10 = p_digits10 and q.archived_at is null
    order by p.id, cpn.slot
  ) x
$$;
revoke all on function public.dialpad_cti_native_candidates(uuid, uuid, text) from public, anon, authenticated, service_role;

-- Binder (shared with 2.5): freezes one (property, contact, slot, episode, rep) match for a provider call as a
-- synthetic matched intent. Lock order: binding, property, open episode. One frozen match per provider call id.
create or replace function public.dialpad_cti_native_bind(
  p_event_id uuid, p_binding_id uuid, p_property_id uuid, p_contact_id uuid, p_slot smallint
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.dialpad_call_events%rowtype;
  v_binding public.dialpad_member_bindings%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_id uuid;
begin
  select * into v_event from public.dialpad_call_events where id = p_event_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select i.id into v_id from public.dialpad_call_intents i
    where i.org_id = v_event.org_id and i.matched_provider_call_id = v_event.provider_call_id;
  if found then return v_id; end if;

  select * into v_binding from public.dialpad_member_bindings
    where id = p_binding_id and org_id = v_event.org_id and status = 'verified' for share;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from public.properties where id = p_property_id and org_id = v_event.org_id for share;
  select * into v_episode from public.acquisition_assignment_episodes
    where property_id = p_property_id and org_id = v_event.org_id and ended_at is null
      and assignee_user_id = v_binding.user_id for share;
  if not found then raise exception 'STALE_ASSIGNMENT' using errcode = '42501'; end if;

  begin
    insert into public.dialpad_call_intents (org_id, connection_id, rep_user_id, binding_id, dialpad_user_id, property_id,
      contact_id, phone_slot, destination_e164, assignment_episode_id, custom_data, idempotency_key, request_hash,
      prepared_at, expires_at, origin, direction)
    values (v_event.org_id, v_event.connection_id, v_binding.user_id, v_binding.id, v_binding.dialpad_user_id, p_property_id,
      p_contact_id, p_slot, v_event.payload ->> 'external_number', v_episode.id,
      'sandra.dialpad.v1.' || encode(extensions.gen_random_bytes(24), 'hex'), extensions.gen_random_uuid(),
      encode(sha256(convert_to('dialpad-native:' || v_event.org_id::text || ':' || v_event.provider_call_id, 'utf8')), 'hex'),
      -- Window opens at the root event, not at bind time, so transfer legs and a late Assign-to-lead
      -- (all stamped earlier than now()) stay inside the intent window.
      least(to_timestamp(v_event.event_timestamp_ms / 1000.0), now()), now() + interval '1 day', 'native', lower(v_event.payload ->> 'direction'))
    returning id into v_id;
    update public.dialpad_call_intents
      set status = 'matched', matched_provider_call_id = v_event.provider_call_id,
          matched_event_id = v_event.id, matched_at = now()
      where id = v_id;
  exception when unique_violation then
    select i.id into v_id from public.dialpad_call_intents i
      where i.org_id = v_event.org_id and i.matched_provider_call_id = v_event.provider_call_id;
    if v_id is null then raise; end if;
  end;
  return v_id;
end $$;
revoke all on function public.dialpad_cti_native_bind(uuid, uuid, uuid, uuid, smallint) from public, anon, authenticated, service_role;

create or replace function public.dialpad_cti_native_resolve(p_event_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.dialpad_call_events%rowtype;
  v_binding public.dialpad_member_bindings%rowtype;
  v_unchanged jsonb;
  v_flag boolean;
  v_dir text;
  v_ext text;
  v_digits text;
  v_intent public.dialpad_call_intents%rowtype;
  v_open int;
  v_total int;
  v_live int;
  v_cand record;
  v_id uuid;
  v_reason text;
  c_skew_ms constant bigint := 5000;
begin
  select * into v_event from public.dialpad_call_events where id = p_event_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_unchanged := jsonb_build_object('eventId', v_event.id, 'disposition', 'quarantined', 'intentId', null,
    'reason', 'no_custom_data', 'replayed', false);

  -- 0. Kill switch: off, no row, or no table/column reads as OFF and the event stays as before.
  begin
    select f.native_matcher into v_flag from public.my_leads_feature_flags f where f.org_id = v_event.org_id;
  exception when undefined_table or undefined_column then
    v_flag := false;
  end;
  if not coalesce(v_flag, false) then return v_unchanged; end if;

  -- 1. Only chain roots resolve here; a leg whose root has no intent yet waits for the sibling loop.
  if public.dialpad_cti_chain_root(v_event.provider_call_id, v_event.payload) <> v_event.provider_call_id then
    return v_unchanged;
  end if;

  -- 2. Rep: a verified, active, acquisitions-enabled member of an org with My Leads on.
  if lower(coalesce(v_event.payload -> 'target' ->> 'type', '')) = 'user' then
    select * into v_binding from public.dialpad_member_bindings
      where org_id = v_event.org_id and dialpad_user_id = (v_event.payload -> 'target' ->> 'id') and status = 'verified' for share;
  end if;
  if v_binding.id is null
     or not public.dialpad_cti_member_is_active(v_event.org_id, v_binding.user_id)
     or not exists (select 1 from public.memberships m
                    where m.org_id = v_event.org_id and m.user_id = v_binding.user_id and m.acquisitions_enabled)
     or not exists (select 1 from public.acquisition_org_settings s where s.org_id = v_event.org_id and s.my_leads_enabled) then
    v_reason := 'no_binding';
  end if;

  -- 3. Direction and a US number.
  if v_reason is null then
    v_dir := lower(coalesce(v_event.payload ->> 'direction', ''));
    v_ext := v_event.payload ->> 'external_number';
    if v_dir not in ('inbound', 'outbound') or v_ext is null or v_ext !~ '^\+1[0-9]{10}$' then
      v_reason := 'no_lead_match';
    else
      v_digits := right(v_ext, 10);
    end if;
  end if;

  -- 4. A Sandra-dialed call whose events lost custom_data: bind the one open authorized intent.
  if v_reason is null and v_dir = 'outbound' then
    select count(*) into v_open from public.dialpad_call_intents i
      where i.org_id = v_event.org_id and i.rep_user_id = v_binding.user_id and i.status = 'prepared'
        and i.origin = 'sandra' and i.dispatch_authorized_at is not null and i.destination_e164 = v_ext
        and v_event.event_timestamp_ms >= floor(extract(epoch from i.dispatch_authorized_at) * 1000)::bigint - c_skew_ms
        and v_event.event_timestamp_ms <= floor(extract(epoch from i.expires_at) * 1000)::bigint;
    if v_open = 1 then
      select * into v_intent from public.dialpad_call_intents i
        where i.org_id = v_event.org_id and i.rep_user_id = v_binding.user_id and i.status = 'prepared'
          and i.origin = 'sandra' and i.dispatch_authorized_at is not null and i.destination_e164 = v_ext
          and v_event.event_timestamp_ms >= floor(extract(epoch from i.dispatch_authorized_at) * 1000)::bigint - c_skew_ms
          and v_event.event_timestamp_ms <= floor(extract(epoch from i.expires_at) * 1000)::bigint
        for update;
      if found then
        update public.dialpad_call_intents
          set status = 'matched', matched_provider_call_id = v_event.provider_call_id,
              matched_event_id = v_event.id, matched_at = now()
          where id = v_intent.id;
        update public.dialpad_call_events
          set disposition = 'matched', disposition_reason = null, matched_intent_id = v_intent.id, disposed_at = now()
          where id = v_event.id;
        return jsonb_build_object('eventId', v_event.id, 'disposition', 'matched', 'intentId', v_intent.id,
          'reason', null, 'replayed', false);
      end if;
    end if;
  end if;

  -- 5. Exact-number candidates on the rep's own open leads.
  if v_reason is null then
    select count(*)::int, (count(*) filter (where not c.is_dnc))::int into v_total, v_live
      from public.dialpad_cti_native_candidates(v_event.org_id, v_binding.user_id, v_digits) c;
    if v_total = 0 then v_reason := 'no_lead_match';
    elsif v_live = 0 then v_reason := 'dnc_number';
    elsif v_live > 1 then v_reason := 'ambiguous_lead';
    else
      select * into v_cand from public.dialpad_cti_native_candidates(v_event.org_id, v_binding.user_id, v_digits) c
        where not c.is_dnc;
      v_id := public.dialpad_cti_native_bind(v_event.id, v_binding.id, v_cand.property_id, v_cand.contact_id, v_cand.slot);
      update public.dialpad_call_events
        set disposition = 'matched', disposition_reason = null, matched_intent_id = v_id, disposed_at = now()
        where id = v_event.id;
      return jsonb_build_object('eventId', v_event.id, 'disposition', 'matched', 'intentId', v_id,
        'reason', null, 'replayed', false);
    end if;
  end if;

  update public.dialpad_call_events
    set disposition = 'quarantined', disposition_reason = v_reason, disposed_at = now()
    where id = v_event.id;
  return jsonb_build_object('eventId', v_event.id, 'disposition', 'quarantined', 'intentId', null,
    'reason', v_reason, 'replayed', false);
end $$;
revoke all on function public.dialpad_cti_native_resolve(uuid) from public, anon, authenticated, service_role;

create or replace function public.dialpad_cti_resolve_event(p_event_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res jsonb;
begin
  v_res := public.dialpad_cti_resolve_event_legacy(p_event_id);
  if v_res ->> 'disposition' = 'quarantined' and v_res ->> 'reason' = 'no_custom_data' then
    return public.dialpad_cti_native_resolve(p_event_id);
  end if;
  return v_res;
end $$;
revoke all on function public.dialpad_cti_resolve_event(uuid) from public, anon, authenticated, service_role;
revoke all on function public.dialpad_cti_resolve_event_legacy(uuid) from public, anon, authenticated, service_role;

-- Anchored patches of the live projection and the event processor.
do $patch$
declare
  r record;
  v_def text;
  v_found int;
begin
  for r in select * from (values
    ('public.dialpad_cti_project_intent(uuid)',
      'v_events, ''outbound'', v_intent.destination_e164,',
      'v_events, v_intent.direction, v_intent.destination_e164,'),
    ('public.dialpad_cti_project_intent(uuid)',
      E'-- Training keeps the frozen intent for attribution, never the customer ledger.\n  if not v_property.is_training then',
      E'-- Training keeps the frozen intent for attribution, never the customer ledger.\n  if not v_property.is_training and v_intent.direction = ''outbound'' then'),
    ('public.fn_process_dialpad_call_event(uuid)',
      'disposition_reason in (''no_custom_data'', ''intent_already_matched'', ''target_mismatch'', ''outside_intent_window'')',
      'disposition_reason in (''no_custom_data'', ''intent_already_matched'', ''target_mismatch'', ''outside_intent_window'', ''ambiguous_lead'')')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    if position(r.repl in v_def) > 0 then continue; end if; -- already patched
    v_found := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if v_found <> 1 then
      raise exception 'native matching patch: expected one anchor in %, found %: %', r.sig, v_found, left(r.anchor, 60);
    end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $patch$;

commit;
