-- Rollback for 20261031130800: restore the 20261030250000 body byte for byte (shadow source).
begin;
set local lock_timeout = '5s';
create or replace function public.fn_routing_v2_phone_action_apply_all(
  p_source_inbound_message_id uuid,
  p_action text,
  p_phone text,
  p_decision jsonb default '{}'::jsonb,
  -- The decision_context_revision the v2 decision was made against (optional).
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_existing public.routing_v2_phone_actions%rowtype;
  v_flags jsonb;
  v_dispo text := case p_action when 'wrong_number_all' then 'wrong_number' else 'bad_number' end;
  v_digits text := public.routing_v2_phone_digits(p_phone);
  v_ids uuid[];
  v_id uuid;
  v_action_id uuid;
  v_send_id uuid;
  r record;
  v_reason text;
  v_source_reason text;
  v_paused uuid[];
  v_after record;
  v_row_id uuid;
  v_applied uuid[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_skips jsonb := '{}'::jsonb;
  v_dec record;
  v_contacts uuid[];
  v_pause_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_action not in ('wrong_number_all', 'bad_number') then
    raise exception 'unsupported routing v2 phone action: %', p_action using errcode = '22023';
  end if;
  -- The decision's revision is required: without it A cannot prove the decision is current.
  if p_expected_revision is null then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'expected_revision_required');
  end if;

  select m.id, m.org_id, m.property_id, m.from_address, m.created_at, m.body
  into v_message
  from public.messages m
  where m.id = p_source_inbound_message_id and m.channel = 'sms' and m.direction = 'inbound';
  if not found or v_message.property_id is null then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'source_message_missing');
  end if;
  if coalesce(p_phone, '') !~ '^\+1[0-9]{10}$' or v_digits <> public.routing_v2_phone_digits(v_message.from_address) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'phone_mismatch');
  end if;

  -- Never trust the caller's description of the decision: re-derive it from the persisted
  -- v2 decision for THIS inbound (routing_v2_shadow_decisions, PR-A/PR-D). Only the scope is a
  -- caller input (the v2 question set has no scope question; the cutover PR supplies it).
  select d.road, d.provenance, d.haiku_eligibility, d.haiku
  into v_dec
  from public.routing_v2_shadow_decisions d
  where d.inbound_message_id = p_source_inbound_message_id
    and d.org_id = v_message.org_id and d.property_id = v_message.property_id
    and d.status = 'decided';
  if not found then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'no_decision_record');
  end if;
  if p_action = 'wrong_number_all' then
    -- ORDER-TABLE: a Jev wrong-person answer >= 0.60 is the road; in the 0.50-0.70 band Haiku
    -- decides, and if Haiku is unsure Jev's road stands (applyHaikuPolicy final_road).
    if v_dec.road is distinct from 'wrong_number_close'
       or v_dec.provenance->>'by' is distinct from 'jev'
       or v_dec.provenance->>'signal' is distinct from 'wrong_person'
       or jsonb_typeof(v_dec.provenance->'probability') is distinct from 'number'
       or (v_dec.provenance->>'probability')::numeric < 0.6 then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'decision_not_wrong_person');
    end if;
    if v_dec.haiku_eligibility is not null and (
         v_dec.haiku is null
      or jsonb_typeof(v_dec.haiku->'hold') is distinct from 'boolean'
      or (v_dec.haiku->>'hold')::boolean
      or v_dec.haiku->>'final_road' is distinct from 'wrong_number_close'
    ) then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'haiku_not_confirmed');
    end if;
    if coalesce(p_decision->>'wrong_scope', '') <> 'all' then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'scope_not_all');
    end if;
  else
    -- The bounce code check (PR-A route.ts codePreCheck) recorded on the decision, and the
    -- inbound text itself still matches that detector.
    if v_dec.road is distinct from 'bad_number'
       or v_dec.provenance->>'by' is distinct from 'code'
       or v_dec.provenance->>'check' is distinct from 'bad_number'
       or coalesce(v_message.body, '') !~* '(no sms capabilit|unable to receive)' then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'decision_not_bounce');
    end if;
  end if;

  -- Global-DNC write barrier (20260830092331), SHARED, before any phone/contact/property lock:
  -- the global-DNC path takes it EXCLUSIVE before locking contacts, so taking it first here
  -- means the two can only queue behind each other, never deadlock.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
  -- Serialize every v2 phone action and undo for this phone.
  perform public.routing_v2_phone_lock(v_message.org_id, p_phone);

  select * into v_existing from public.routing_v2_phone_actions a
  where a.source_inbound_message_id = p_source_inbound_message_id;
  if found then
    return jsonb_build_object(
      'status', 'replayed', 'actionId', v_existing.id, 'actionStatus', v_existing.status,
      'replyState', v_existing.reply_state, 'sendId', v_existing.send_id,
      'propertyIds', to_jsonb(v_existing.property_ids)
    );
  end if;

  select c.routing_v2_flags into v_flags
  from public.ai_responder_configs c
  where c.org_id = v_message.org_id and c.active = true
  limit 1;
  if v_flags is null or jsonb_typeof(v_flags) <> 'object'
     or (v_flags->'questions_live') is distinct from 'true'::jsonb
     or (v_flags->'wrong_number_all') is distinct from 'true'::jsonb then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'flag_off');
  end if;

  -- Settle window: the triggering inbound must be at least 30 s old, so every inbound that
  -- arrived around it has committed and is visible to the newest-inbound check below
  -- (inbound inserts commit in milliseconds). Retryable; nothing is written.
  if v_message.created_at > clock_timestamp() - interval '30 seconds' then
    return jsonb_build_object('status', 'not_settled', 'reason', 'inbound_settle_window', 'retryAfterSeconds',
      greatest(1, ceil(extract(epoch from (v_message.created_at + interval '30 seconds' - clock_timestamp()))))::int);
  end if;

  -- D. Latest reply wins across every property for this phone (committed rows; range on
  -- created_at uses idx_messages_created).
  if exists (
    select 1 from public.messages m
    where m.created_at >= v_message.created_at
      and m.org_id = v_message.org_id and m.channel = 'sms' and m.direction = 'inbound'
      and m.id <> v_message.id
      and public.routing_v2_phone_digits(m.from_address) = v_digits
      and (m.created_at > v_message.created_at or m.id > v_message.id)
  ) then
    return jsonb_build_object('status', 'superseded', 'reason', 'newer_inbound_from_phone');
  end if;

  -- Lock order (same everywhere): phone advisory -> contacts rows -> contact_phone_numbers
  -- rows -> sms_phone_suppressions -> per-property advisory -> properties rows -> enrollments.
  -- Contacts holding the phone (equality on the stored E.164 plus the normalized phone table).
  v_contacts := array(
    select c.id from public.contacts c
    where c.org_id = v_message.org_id
      and (c.phone_1 = p_phone or c.phone_2 = p_phone or c.phone_3 = p_phone
           or c.id in (select cp.contact_id from public.contact_phone_numbers cp where cp.org_id = v_message.org_id and cp.digits10 = v_digits))
    order by c.id
  );
  if p_action = 'wrong_number_all' then
    select array_agg(p.id order by p.id) into v_ids
    from public.properties p
    where p.org_id = v_message.org_id and p.deleted_at is null
      and (p.id = v_message.property_id or p.homeowner_contact_id = any(v_contacts));
  else
    select array_agg(p.id) into v_ids
    from public.properties p
    where p.id = v_message.property_id and p.org_id = v_message.org_id and p.deleted_at is null;
  end if;
  if v_ids is null or not (v_message.property_id = any(v_ids)) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'source_property_missing');
  end if;

  perform 1 from public.contacts c
  where c.id = any(v_contacts)
     or c.id in (select p.homeowner_contact_id from public.properties p where p.id = any(v_ids))
  order by c.id for update;
  perform 1 from public.contact_phone_numbers cp
  where cp.org_id = v_message.org_id and cp.digits10 = v_digits
  order by cp.contact_id, cp.slot for update;
  perform 1 from public.sms_phone_suppressions sp
  where sp.org_id = v_message.org_id and sp.channel = 'sms' and sp.phone_e164 = p_phone
  for update;
  if found then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'phone_suppressed');
  end if;
  -- Global phone DNC registry (append-only; inserted only under the EXCLUSIVE global-DNC
  -- barrier, so it cannot change while A holds the shared one). Read directly, as the other
  -- registry consumers do (norma eligibility, voicemail drop): contact/property DNC flags and
  -- sms_phone_suppressions do not cover a registry-only phone.
  if exists (select 1 from public.global_phone_dnc_registry g where g.org_id = v_message.org_id and g.phone_e164 = p_phone) then
    return jsonb_build_object('status', 'suppressed', 'reason', 'global_dnc_registry');
  end if;
  foreach v_id in array v_ids loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || v_id::text));
  end loop;
  perform 1 from public.properties p where p.id = any(v_ids) order by p.id for update;

  -- Re-derive the target set under the locks; a change since the first read = retry later.
  if p_action = 'wrong_number_all' and v_ids is distinct from (
    select array_agg(p.id order by p.id) from public.properties p
    where p.org_id = v_message.org_id and p.deleted_at is null
      and (p.id = v_message.property_id or exists (
        select 1 from public.contacts c
        where c.id = p.homeowner_contact_id and c.org_id = v_message.org_id
          and (c.phone_1 = p_phone or c.phone_2 = p_phone or c.phone_3 = p_phone
               or c.id in (select cp.contact_id from public.contact_phone_numbers cp where cp.org_id = v_message.org_id and cp.digits10 = v_digits))))
  ) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'property_set_changed');
  end if;

  -- Final write gate: re-read the active config NOW, after every lock, with FOR SHARE (an
  -- owner's flag flip waits for this transaction, or this read sees the flip). The earlier
  -- read was only an early exit; this one decides.
  select c.routing_v2_flags into v_flags
  from public.ai_responder_configs c
  where c.org_id = v_message.org_id and c.active = true
  limit 1
  for share;
  if v_flags is null or jsonb_typeof(v_flags) <> 'object'
     or (v_flags->'questions_live') is distinct from 'true'::jsonb
     or (v_flags->'wrong_number_all') is distinct from 'true'::jsonb then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'flag_off');
  end if;
  -- Phone-level actions are eligible only if every property on the phone is (§13.1).
  if exists (select 1 from unnest(v_ids) t(id) where not public.routing_v2_phone_action_eligible(v_flags, t.id)) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'canary_excluded');
  end if;

  if exists (
    select 1 from public.properties p where p.id = v_message.property_id and p.decision_context_revision is distinct from p_expected_revision
  ) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'stale_decision_context');
  end if;

  for r in
    select p.id, p.outreach_dispo, p.needs_human_attention, p.is_training, p.is_dnc_locked,
           p.id = v_message.property_id as is_source,
           coalesce(c.sms_opted_out, false) or coalesce(c.do_not_contact, false) as contact_suppressed,
           exists (
             select 1 from unnest(array[c.phone_1, c.phone_2, c.phone_3]) ph(v)
             where nullif(public.routing_v2_phone_digits(ph.v), '') is not null
               and public.routing_v2_phone_digits(ph.v) <> v_digits
           ) as other_phone
    from public.properties p
    left join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = v_message.org_id
    where p.id = any(v_ids)
    order by p.id
  loop
    v_reason := case
      when r.needs_human_attention then 'held'
      when r.is_training then 'training'
      when r.is_dnc_locked then 'dnc_locked'
      when r.outreach_dispo in ('opted_out', 'dnc') then 'opted_out_or_dnc'
      when r.outreach_dispo = v_dispo then 'already_applied'
      when r.outreach_dispo is not null and r.outreach_dispo not in ('not_interested', 'needs_sequence') then 'human_owned_outcome'
      when r.contact_suppressed then 'contact_suppressed'
      when exists (
        select 1 from public.ai_disposition_reviews rv
        where rv.property_id = r.id and rv.org_id = v_message.org_id and rv.status = 'pending'
      ) then 'pending_review'
      when not r.is_source and r.other_phone then 'other_phones_on_contact'
      else null
    end;
    if r.is_source then v_source_reason := v_reason; end if;
    if v_reason is not null then v_skips := v_skips || jsonb_build_object(r.id::text, v_reason); end if;
  end loop;
  if v_source_reason is not null then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'source_' || v_source_reason);
  end if;

  -- Every check passed: write it all.
  insert into public.routing_v2_phone_actions (
    org_id, source_property_id, source_inbound_message_id, action, phone_e164, status,
    property_ids, reply_state, fence_at, decision
  ) values (
    v_message.org_id, v_message.property_id, p_source_inbound_message_id, p_action, p_phone, 'applied',
    v_ids, case p_action when 'wrong_number_all' then 'awaiting_fence' else 'not_needed' end,
    case p_action when 'wrong_number_all' then clock_timestamp() + interval '10 seconds' end,
    coalesce(p_decision, '{}'::jsonb)
  )
  returning id, send_id into v_action_id, v_send_id;

  for r in
    select p.id, p.outreach_dispo, p.follow_up_at,
           p.id = v_message.property_id as is_source
    from public.properties p where p.id = any(v_ids) order by p.id
  loop
    if v_skips ? r.id::text then
      insert into public.routing_v2_phone_action_properties (action_id, org_id, property_id, is_source, outcome, skip_reason)
      values (v_action_id, v_message.org_id, r.id, r.is_source, 'skipped', v_skips->>r.id::text);
      v_skipped := v_skipped || jsonb_build_object('propertyId', r.id, 'reason', v_skips->>r.id::text);
      continue;
    end if;

    update public.properties
    -- Only the disposition. Hold fields (needs_human_attention, last_ai_escalation_*) are never
    -- written by A or by undo, so undo can't restore a stale hold (no ABA hazard).
    set outreach_dispo = v_dispo, updated_at = now()
    where id = r.id and org_id = v_message.org_id
    returning decision_context_revision, follow_up_at into v_after;

    -- As setResponderDispo does for a wrong_number: pause the property's active drips.
    v_paused := '{}';
    v_pause_at := null;
    if p_action = 'wrong_number_all' then
      -- Each pause carries this action's token and a unique stamp; undo resumes only rows that
      -- still carry both (any later resume/re-pause clears the token, see the trigger below).
      v_pause_at := clock_timestamp();
      -- Provenance marker for routing_v2_pause_token_guard (transaction-local; reset below).
      perform set_config('routing_v2.pausing', 'on', true);
      with paused as (
        update public.sequence_enrollments e
        set status = 'paused', pause_reason = 'inbound_reply', updated_at = v_pause_at,
            routing_v2_pause_token = v_action_id
        where e.property_id = r.id and e.status = 'active'
        returning e.id, e.sequence_id
      )
      select coalesce(array_agg(id order by id), '{}') into v_paused from paused;
      perform set_config('routing_v2.pausing', '', true);
      if cardinality(v_paused) = 0 then v_pause_at := null; end if;
      if cardinality(v_paused) > 0 then
        insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
        values (v_message.org_id, r.id, 'system', 'sequence_paused', jsonb_build_object(
          'count', cardinality(v_paused), 'reason', 'inbound_reply', 'permanent', false, 'phone_action_id', v_action_id));
      end if;
    end if;

    insert into public.routing_v2_phone_action_properties (
      action_id, org_id, property_id, is_source, outcome, applied_dispo,
      prior_outreach_dispo, prior_follow_up_at,
      applied_follow_up_at, recorded_revision, paused_enrollment_ids, paused_at
    ) values (
      v_action_id, v_message.org_id, r.id, r.is_source, 'applied', v_dispo,
      r.outreach_dispo, r.follow_up_at,
      v_after.follow_up_at, v_after.decision_context_revision, v_paused, v_pause_at
    )
    returning id into v_row_id;

    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (
      v_message.org_id, r.id, 'ai', 'dispo_set',
      jsonb_build_object(
        'from', r.outreach_dispo, 'to', v_dispo, 'reason', 'routing_v2:' || p_action, 'auto_accepted', true,
        'phone_action_id', v_action_id, 'source_inbound_message_id', p_source_inbound_message_id
      ),
      'routing_v2_phone_action_properties.applied', v_row_id
    );
    v_applied := v_applied || r.id;
  end loop;

  return jsonb_build_object(
    'status', 'applied', 'actionId', v_action_id, 'sendId', v_send_id,
    'replyState', case p_action when 'wrong_number_all' then 'awaiting_fence' else 'not_needed' end,
    'applied', to_jsonb(v_applied), 'skipped', v_skipped, 'propertyIds', to_jsonb(v_ids)
  );
end;
$$;

revoke all on function public.fn_routing_v2_phone_action_apply_all(uuid, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_apply_all(uuid, text, text, jsonb, bigint) to service_role;
commit;
