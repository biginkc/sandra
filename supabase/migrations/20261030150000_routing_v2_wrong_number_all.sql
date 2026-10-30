-- SMS reply routing v2, PR-G: automatic wrong number for every property on a phone, and the
-- "no SMS capabilities" bounce marking the number bad. Behind routing_v2_flags.wrong_number_all
-- (default false) AND questions_live. Nothing calls these functions until the cutover PR wires
-- them; with the flags off they write nothing.
--
-- What it does (BUILD-PLAN §5 PR-G, §13.1, §14):
--   * wrong_number_all: the existing wrong_number disposition (same severity/held rules as
--     fn_apply_ai_disposition_with_review) on every property whose homeowner contact holds the
--     phone that texted, plus the property the text landed on. Auto-accepted (no pending review),
--     one audit row per property with the exact prior state, undo restores each property.
--   * bad_number: the existing bad_number disposition on the property the bounce landed on.
--   * Phone-level actions run only when EVERY target property is canary-eligible (§13.1).
--   * Never writes contacts, consent, or sms_phone_suppressions. A property whose homeowner
--     contact also has a different phone is skipped (that other phone stays reachable).
--   * Idempotent per source inbound message (unique claim row). Per-property advisory lock
--     `routing_v2:<property_id>` (§14) plus row locks, taken in property-id order.
--
-- Rollback: supabase/rollbacks/20261030150000_routing_v2_wrong_number_all.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.routing_v2_phone_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_property_id uuid not null references public.properties(id) on delete cascade,
  source_inbound_message_id uuid not null references public.messages(id) on delete cascade,
  action text not null check (action in ('wrong_number_all', 'bad_number')),
  phone_e164 text not null,
  status text not null check (status in ('claimed', 'applied', 'not_applied', 'undone')),
  not_applied_reason text,
  property_ids uuid[] not null default '{}',
  claimed_revision bigint,
  -- Durable send/apply state (crash recovery): pending -> sending -> sent; bad_number = not_needed.
  reply_state text not null default 'not_needed' check (reply_state in ('pending', 'sending', 'sent', 'not_needed')),
  reply_message_id uuid,
  -- A worker owns the row until the lease expires; a later webhook or the sweeper resumes it.
  lease_expires_at timestamptz,
  paused_at timestamptz,
  decision jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  constraint routing_v2_phone_actions_undone_pair check (undone_by is null or undone_at is not null)
);
comment on table public.routing_v2_phone_actions is
  'Routing v2 PR-G: one row per source inbound for a phone-level automatic action (wrong_number_all, bad_number). Unique per inbound = duplicate webhooks are no-ops.';

create unique index if not exists routing_v2_phone_actions_inbound_uidx
  on public.routing_v2_phone_actions (source_inbound_message_id);
create index if not exists routing_v2_phone_actions_org_created_idx
  on public.routing_v2_phone_actions (org_id, created_at desc);
create index if not exists routing_v2_phone_actions_unfinished_idx
  on public.routing_v2_phone_actions (lease_expires_at)
  where status = 'claimed' or (status = 'applied' and paused_at is null);

create table if not exists public.routing_v2_phone_action_properties (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references public.routing_v2_phone_actions(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  is_source boolean not null default false,
  outcome text not null check (outcome in ('applied', 'skipped')),
  skip_reason text,
  applied_dispo text,
  prior_outreach_dispo text,
  prior_follow_up_at timestamptz,
  prior_needs_human_attention boolean,
  prior_last_ai_escalation_reason text,
  applied_follow_up_at timestamptz,
  recorded_revision bigint,
  paused_enrollment_ids uuid[] not null default '{}',
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint routing_v2_phone_action_properties_outcome_shape check (
    (outcome = 'applied' and applied_dispo is not null and skip_reason is null)
    or (outcome = 'skipped' and applied_dispo is null and skip_reason is not null)
  ),
  constraint routing_v2_phone_action_properties_undone_pair check (undone_by is null or undone_at is not null)
);
comment on table public.routing_v2_phone_action_properties is
  'Routing v2 PR-G audit + undo: one row per target property (applied with its exact prior state, or skipped with the reason).';

create unique index if not exists routing_v2_phone_action_properties_uidx
  on public.routing_v2_phone_action_properties (action_id, property_id);
create index if not exists routing_v2_phone_action_properties_property_idx
  on public.routing_v2_phone_action_properties (property_id, created_at desc);

alter table public.routing_v2_phone_actions enable row level security;
alter table public.routing_v2_phone_action_properties enable row level security;
revoke all on public.routing_v2_phone_actions from public, anon, authenticated;
revoke all on public.routing_v2_phone_action_properties from public, anon, authenticated;
grant select on public.routing_v2_phone_actions to authenticated;
grant select on public.routing_v2_phone_action_properties to authenticated;
grant select, insert, update on public.routing_v2_phone_actions to service_role;
grant select, insert, update on public.routing_v2_phone_action_properties to service_role;

drop policy if exists routing_v2_phone_actions_org_select on public.routing_v2_phone_actions;
create policy routing_v2_phone_actions_org_select on public.routing_v2_phone_actions
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and org_id in (select public.pipeline_runs_readable_org_ids()));
drop policy if exists routing_v2_phone_action_properties_org_select on public.routing_v2_phone_action_properties;
create policy routing_v2_phone_action_properties_org_select on public.routing_v2_phone_action_properties
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and org_id in (select public.pipeline_runs_readable_org_ids()));

-- §13.1, the SQL twin of isV2Eligible(parseRoutingV2Flags(flags), id) in
-- src/lib/sms-classification/routing-v2/flags.ts (pinned to it by the integration test):
--   * canary_property_ids: absent, or an array whose every entry is a UUID string; anything
--     else (null, non-array, one bad entry) = nothing eligible (fail closed);
--   * canary_percent: absent, or an integer JSON number 0..100; anything else = nothing eligible;
--   * eligible = id listed (case-insensitive) OR sha256(lower(id)) first 4 bytes (uint32 BE) % 100 < percent.
create or replace function public.routing_v2_phone_action_eligible(p_flags jsonb, p_property_id uuid)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb := p_flags->'canary_property_ids';
  v_pct jsonb := p_flags->'canary_percent';
  v_percent numeric := 0;
  v_bucket bigint;
begin
  if p_flags is null or jsonb_typeof(p_flags) <> 'object' or p_property_id is null then
    return false;
  end if;
  if v_ids is not null then
    if jsonb_typeof(v_ids) <> 'array' then
      return false;
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_ids) e(v)
      where jsonb_typeof(e.v) <> 'string'
         or (e.v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      return false;
    end if;
  end if;
  if v_pct is not null then
    if jsonb_typeof(v_pct) <> 'number' then
      return false;
    end if;
    v_percent := (v_pct #>> '{}')::numeric;
    if v_percent <> trunc(v_percent) or v_percent < 0 or v_percent > 100 then
      return false;
    end if;
  end if;
  if v_ids is not null and exists (
    select 1 from jsonb_array_elements_text(v_ids) e(v) where lower(e.v) = lower(p_property_id::text)
  ) then
    return true;
  end if;
  v_bucket := ('x' || substr(encode(sha256(convert_to(lower(p_property_id::text), 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 100;
  return v_bucket < v_percent;
end;
$$;
revoke all on function public.routing_v2_phone_action_eligible(jsonb, uuid) from public, anon, authenticated;

create or replace function public.routing_v2_phone_digits(p_phone text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10); $$;
revoke all on function public.routing_v2_phone_digits(text) from public, anon, authenticated;

-- The plan: target properties, per-property apply/skip, and the whole-action verdict.
-- p_lock = true takes the advisory + row locks (property-id order). Internal only.
create or replace function public.routing_v2_phone_action_plan(
  p_org_id uuid,
  p_action text,
  p_phone text,
  p_source_property_id uuid,
  p_lock boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_flags jsonb;
  v_dispo text := case p_action when 'wrong_number_all' then 'wrong_number' else 'bad_number' end;
  v_ids uuid[];
  v_id uuid;
  v_targets jsonb := '[]'::jsonb;
  v_source_reason text;
  v_source_found boolean := false;
  r record;
  v_reason text;
begin
  select c.routing_v2_flags into v_flags
  from public.ai_responder_configs c
  where c.org_id = p_org_id and c.active = true
  limit 1;
  if v_flags is null or jsonb_typeof(v_flags) <> 'object'
     or (v_flags->'questions_live') is distinct from 'true'::jsonb
     or (v_flags->'wrong_number_all') is distinct from 'true'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'flag_off');
  end if;

  if p_action = 'wrong_number_all' then
    select array_agg(p.id order by p.id) into v_ids
    from public.properties p
    where p.org_id = p_org_id and p.deleted_at is null
      and (p.id = p_source_property_id or exists (
        select 1 from public.contacts c
        where c.id = p.homeowner_contact_id and c.org_id = p_org_id
          and public.routing_v2_phone_digits(p_phone) in (
            public.routing_v2_phone_digits(c.phone_1),
            public.routing_v2_phone_digits(c.phone_2),
            public.routing_v2_phone_digits(c.phone_3))));
  else
    select array_agg(p.id) into v_ids
    from public.properties p
    where p.id = p_source_property_id and p.org_id = p_org_id and p.deleted_at is null;
  end if;
  if v_ids is null or not (p_source_property_id = any(v_ids)) then
    return jsonb_build_object('ok', false, 'reason', 'source_property_missing');
  end if;

  if p_lock then
    -- Serializes this phone's own v2 actions (claim/apply/undo). Other writers of contact
    -- phones or suppressions do not take it; the apply re-check covers what they change.
    perform pg_advisory_xact_lock(hashtext('routing_v2_phone:' || public.routing_v2_phone_digits(p_phone)));
    foreach v_id in array v_ids loop
      perform pg_advisory_xact_lock(hashtext('routing_v2:' || v_id::text));
    end loop;
    perform 1 from public.properties p where p.id = any(v_ids) order by p.id for update;
  end if;

  -- Phone-level actions are eligible only if every property on the phone is (§13.1).
  if exists (select 1 from unnest(v_ids) t(id) where not public.routing_v2_phone_action_eligible(v_flags, t.id)) then
    return jsonb_build_object('ok', false, 'reason', 'canary_excluded');
  end if;

  if exists (
    select 1 from public.sms_phone_suppressions sp
    where sp.org_id = p_org_id and sp.channel = 'sms'
      and public.routing_v2_phone_digits(sp.phone_e164) = public.routing_v2_phone_digits(p_phone)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'phone_suppressed');
  end if;

  for r in
    select p.id, p.outreach_dispo, p.needs_human_attention, p.is_training, p.is_dnc_locked,
           p.id = p_source_property_id as is_source,
           c.id as contact_id, coalesce(c.sms_opted_out, false) or coalesce(c.do_not_contact, false) as contact_suppressed,
           exists (
             select 1 from unnest(array[c.phone_1, c.phone_2, c.phone_3]) ph(v)
             where nullif(public.routing_v2_phone_digits(ph.v), '') is not null
               and public.routing_v2_phone_digits(ph.v) <> public.routing_v2_phone_digits(p_phone)
           ) as other_phone
    from public.properties p
    left join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = p_org_id
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
        where rv.property_id = r.id and rv.org_id = p_org_id and rv.status = 'pending'
      ) then 'pending_review'
      when not r.is_source and r.other_phone then 'other_phones_on_contact'
      else null
    end;
    if r.is_source then
      v_source_found := true;
      v_source_reason := v_reason;
    end if;
    v_targets := v_targets || jsonb_build_object('property_id', r.id, 'is_source', r.is_source, 'skip_reason', v_reason);
  end loop;

  if not v_source_found then
    return jsonb_build_object('ok', false, 'reason', 'source_property_missing');
  end if;
  if v_source_reason is not null then
    return jsonb_build_object('ok', false, 'reason', 'source_' || v_source_reason);
  end if;
  return jsonb_build_object('ok', true, 'dispo', v_dispo, 'property_ids', to_jsonb(v_ids), 'targets', v_targets);
end;
$$;
revoke all on function public.routing_v2_phone_action_plan(uuid, text, text, uuid, boolean) from public, anon, authenticated, service_role;


-- Step 1: claim (before the reply is sent). Not applicable = no row at all (today's path runs).
-- The claimer holds a lease; a crash leaves the row resumable once the lease expires.
create or replace function public.fn_routing_v2_phone_action_claim(
  p_source_inbound_message_id uuid,
  p_action text,
  p_phone text,
  p_decision jsonb default '{}'::jsonb,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_existing public.routing_v2_phone_actions%rowtype;
  v_plan jsonb;
  v_id uuid;
  v_revision bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_action not in ('wrong_number_all', 'bad_number') then
    raise exception 'unsupported routing v2 phone action: %', p_action using errcode = '22023';
  end if;

  select m.id, m.org_id, m.property_id, m.from_address
  into v_message
  from public.messages m
  where m.id = p_source_inbound_message_id and m.channel = 'sms' and m.direction = 'inbound';
  if not found or v_message.property_id is null then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'source_message_missing');
  end if;
  if nullif(public.routing_v2_phone_digits(p_phone), '') is null
     or length(public.routing_v2_phone_digits(p_phone)) <> 10
     or public.routing_v2_phone_digits(p_phone) <> public.routing_v2_phone_digits(v_message.from_address) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'phone_mismatch');
  end if;

  select * into v_existing from public.routing_v2_phone_actions a
  where a.source_inbound_message_id = p_source_inbound_message_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'actionId', v_existing.id, 'actionStatus', v_existing.status);
  end if;

  v_plan := public.routing_v2_phone_action_plan(v_message.org_id, p_action, p_phone, v_message.property_id, true);
  if not (v_plan->>'ok')::boolean then
    return jsonb_build_object('status', 'not_applicable', 'reason', v_plan->>'reason');
  end if;

  select p.decision_context_revision into v_revision from public.properties p where p.id = v_message.property_id;

  insert into public.routing_v2_phone_actions (
    org_id, source_property_id, source_inbound_message_id, action, phone_e164, status,
    property_ids, claimed_revision, decision, reply_state, lease_expires_at
  ) values (
    v_message.org_id, v_message.property_id, p_source_inbound_message_id, p_action, p_phone, 'claimed',
    array(select jsonb_array_elements_text(v_plan->'property_ids')::uuid), v_revision, coalesce(p_decision, '{}'::jsonb),
    case p_action when 'wrong_number_all' then 'pending' else 'not_needed' end,
    now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 1))
  )
  on conflict (source_inbound_message_id) do nothing
  returning id into v_id;
  if v_id is null then
    select * into v_existing from public.routing_v2_phone_actions a
    where a.source_inbound_message_id = p_source_inbound_message_id;
    return jsonb_build_object('status', 'replayed', 'actionId', v_existing.id, 'actionStatus', v_existing.status);
  end if;
  return jsonb_build_object(
    'status', 'claimed', 'actionId', v_id, 'propertyIds', v_plan->'property_ids',
    'replyState', case p_action when 'wrong_number_all' then 'pending' else 'not_needed' end
  );
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_claim(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_claim(uuid, text, text, jsonb, integer) to service_role;

-- Durable step transitions, each atomic on the locked row. Callers act only when ok = true.
--   begin_send : claimed + pending  -> sending (BEFORE the provider call; a crash after this
--                point is never re-sent, see take_lease)
--   sent       : claimed + sending  -> sent (+ reply message id)
--   close      : claimed + pending/sending/sent/not_needed -> not_applied (reason)
--   paused     : applied, paused_at null -> paused_at = now()
create or replace function public.fn_routing_v2_phone_action_step(
  p_action_id uuid,
  p_step text,
  p_reply_message_id uuid default null,
  p_reason text default null,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  v_ok boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_step = 'begin_send' and v.status = 'claimed' and v.reply_state = 'pending' then
    update public.routing_v2_phone_actions
    set reply_state = 'sending', lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 1))
    where id = v.id;
    v_ok := true;
  elsif p_step = 'sent' and v.status = 'claimed' and v.reply_state = 'sending' and p_reply_message_id is not null then
    update public.routing_v2_phone_actions set reply_state = 'sent', reply_message_id = p_reply_message_id where id = v.id;
    v_ok := true;
  elsif p_step = 'close' and v.status = 'claimed' then
    update public.routing_v2_phone_actions
    set status = 'not_applied', not_applied_reason = coalesce(nullif(btrim(p_reason), ''), 'closed')
    where id = v.id;
    v_ok := true;
  elsif p_step = 'paused' and v.status = 'applied' and v.paused_at is null then
    update public.routing_v2_phone_actions set paused_at = now() where id = v.id;
    v_ok := true;
  elsif p_step not in ('begin_send', 'sent', 'close', 'paused') then
    raise exception 'unsupported step: %', p_step using errcode = '22023';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  return jsonb_build_object('ok', v_ok, 'status', v.status, 'replyState', v.reply_state, 'pausedAt', v.paused_at);
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_step(uuid, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_step(uuid, text, uuid, text, integer) to service_role;

-- Resume an unfinished action whose lease expired (duplicate webhook or sweeper).
-- A row stuck in `sending` is never re-sent: if the approved reply (p_reply_body, passed by
-- the app so the text lives in one place) is on the thread after the claim, it is recorded as
-- sent; otherwise the action closes as send_outcome_unknown and a person looks.
create or replace function public.fn_routing_v2_phone_action_take_lease(
  p_action_id uuid,
  p_reply_body text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  v_msg uuid;
  v_applied jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not (v.status = 'claimed' or (v.status = 'applied' and v.paused_at is null)) then
    return jsonb_build_object('taken', false, 'status', v.status, 'reason', 'finished');
  end if;
  if v.lease_expires_at is not null and v.lease_expires_at > now() then
    return jsonb_build_object('taken', false, 'status', v.status, 'reason', 'lease_held');
  end if;
  update public.routing_v2_phone_actions
  set lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 1))
  where id = v.id;

  if v.status = 'claimed' and v.reply_state = 'sending' then
    select m.id into v_msg
    from public.messages m
    where m.org_id = v.org_id and m.property_id = v.source_property_id
      and m.channel = 'sms' and m.direction = 'outbound'
      and m.created_at >= v.created_at
      and p_reply_body is not null and m.body = p_reply_body
    order by m.created_at
    limit 1;
    if v_msg is not null then
      update public.routing_v2_phone_actions set reply_state = 'sent', reply_message_id = v_msg where id = v.id;
    else
      update public.routing_v2_phone_actions
      set status = 'not_applied', not_applied_reason = 'send_outcome_unknown'
      where id = v.id;
    end if;
  end if;

  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  select coalesce(jsonb_agg(ap.property_id order by ap.property_id), '[]'::jsonb) into v_applied
  from public.routing_v2_phone_action_properties ap
  where ap.action_id = v.id and ap.outcome = 'applied';
  return jsonb_build_object(
    'taken', true, 'status', v.status, 'replyState', v.reply_state, 'action', v.action,
    'propertyIds', to_jsonb(v.property_ids), 'applied', v_applied, 'reason', v.not_applied_reason
  );
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_take_lease(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_take_lease(uuid, text, integer) to service_role;

-- Sweeper feed: unfinished actions whose lease expired.
create or replace function public.fn_routing_v2_phone_action_list_stale(p_limit integer default 25)
returns table (action_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id
  from public.routing_v2_phone_actions a
  where (a.status = 'claimed' or (a.status = 'applied' and a.paused_at is null))
    and (a.lease_expires_at is null or a.lease_expires_at <= now())
  order by a.lease_expires_at nulls first
  limit greatest(coalesce(p_limit, 25), 1);
$$;
revoke all on function public.fn_routing_v2_phone_action_list_stale(integer) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_list_stale(integer) to service_role;

-- Step 2: apply, only once the reply is durably `sent` (or not needed for a bounce).
-- Re-checks everything under the locks; any change = not_applied, nothing written.
create or replace function public.fn_routing_v2_phone_action_apply(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action public.routing_v2_phone_actions%rowtype;
  v_plan jsonb;
  v_ids uuid[];
  v_target jsonb;
  v_prop record;
  v_after record;
  v_row_id uuid;
  v_revision bigint;
  v_source_at timestamptz;
  v_applied uuid[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select * into v_action from public.routing_v2_phone_actions where id = p_action_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_action.status <> 'claimed' then
    return jsonb_build_object('status', 'replayed', 'actionId', v_action.id, 'actionStatus', v_action.status);
  end if;
  if v_action.reply_state not in ('sent', 'not_needed') then
    return jsonb_build_object('status', 'reply_pending', 'actionId', v_action.id, 'replyState', v_action.reply_state);
  end if;

  v_plan := public.routing_v2_phone_action_plan(v_action.org_id, v_action.action, v_action.phone_e164, v_action.source_property_id, true);
  v_reason := case when not (v_plan->>'ok')::boolean then v_plan->>'reason' end;

  if v_reason is null then
    v_ids := array(select jsonb_array_elements_text(v_plan->'property_ids')::uuid);
    if not (v_ids @> v_action.property_ids and v_action.property_ids @> v_ids) then
      v_reason := 'property_set_changed';
    end if;
  end if;

  if v_reason is null then
    -- A newer seller text on the source property owns the thread now (latest reply wins).
    select m.created_at into v_source_at from public.messages m where m.id = v_action.source_inbound_message_id;
    if exists (
      select 1 from public.messages m
      where m.property_id = v_action.source_property_id and m.org_id = v_action.org_id
        and m.channel = 'sms' and m.direction = 'inbound'
        and m.id <> v_action.source_inbound_message_id
        and m.created_at > v_source_at
    ) then
      v_reason := 'superseded_by_newer_inbound';
    end if;
  end if;

  if v_reason is null then
    -- Our own approved reply is one outbound row and may move the revision by exactly one.
    select p.decision_context_revision into v_revision from public.properties p where p.id = v_action.source_property_id;
    if v_revision is distinct from v_action.claimed_revision
       and not (v_action.reply_state = 'sent' and v_revision = v_action.claimed_revision + 1) then
      v_reason := 'stale_decision_context';
    end if;
  end if;

  if v_reason is not null then
    update public.routing_v2_phone_actions
    set status = 'not_applied', not_applied_reason = v_reason
    where id = v_action.id;
    return jsonb_build_object('status', 'not_applied', 'actionId', v_action.id, 'reason', v_reason);
  end if;

  for v_target in select * from jsonb_array_elements(v_plan->'targets') loop
    if v_target->>'skip_reason' is not null then
      insert into public.routing_v2_phone_action_properties (action_id, org_id, property_id, is_source, outcome, skip_reason)
      values (v_action.id, v_action.org_id, (v_target->>'property_id')::uuid, (v_target->>'is_source')::boolean, 'skipped', v_target->>'skip_reason');
      v_skipped := v_skipped || jsonb_build_object('propertyId', v_target->>'property_id', 'reason', v_target->>'skip_reason');
      continue;
    end if;

    select p.id, p.outreach_dispo, p.follow_up_at, p.needs_human_attention, p.last_ai_escalation_reason
    into v_prop
    from public.properties p
    where p.id = (v_target->>'property_id')::uuid and p.org_id = v_action.org_id;

    update public.properties
    set outreach_dispo = v_plan->>'dispo',
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_prop.id and org_id = v_action.org_id
    returning decision_context_revision, follow_up_at into v_after;

    insert into public.routing_v2_phone_action_properties (
      action_id, org_id, property_id, is_source, outcome, applied_dispo,
      prior_outreach_dispo, prior_follow_up_at, prior_needs_human_attention, prior_last_ai_escalation_reason,
      applied_follow_up_at, recorded_revision
    ) values (
      v_action.id, v_action.org_id, v_prop.id, (v_target->>'is_source')::boolean, 'applied', v_plan->>'dispo',
      v_prop.outreach_dispo, v_prop.follow_up_at, v_prop.needs_human_attention, v_prop.last_ai_escalation_reason,
      v_after.follow_up_at, v_after.decision_context_revision
    )
    returning id into v_row_id;

    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (
      v_action.org_id, v_prop.id, 'ai', 'dispo_set',
      jsonb_build_object(
        'from', v_prop.outreach_dispo,
        'to', v_plan->>'dispo',
        'reason', 'routing_v2:' || v_action.action,
        'auto_accepted', true,
        'phone_action_id', v_action.id,
        'source_inbound_message_id', v_action.source_inbound_message_id
      ),
      'routing_v2_phone_action_properties.applied', v_row_id
    );
    v_applied := v_applied || v_prop.id;
  end loop;

  update public.routing_v2_phone_actions
  set status = 'applied', applied_at = now(),
      -- A bounce pauses nothing, so it is finished as soon as it is applied.
      paused_at = case when v_action.action = 'bad_number' then now() else null end
  where id = v_action.id;

  return jsonb_build_object('status', 'applied', 'actionId', v_action.id, 'applied', to_jsonb(v_applied), 'skipped', v_skipped);
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_apply(uuid) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_apply(uuid) to service_role;

-- Undo (a person, from the app): restores each applied property's exact prior state, unless
-- something changed since. Never restored (skipped + audited):
--   * the action's phone is suppressed now (opt-out wins: nothing restored, no drip resumed);
--   * the disposition, follow-up date or decision revision moved (a person or a later decision);
--   * a hold was raised since (needs_human_attention / reason differ from what the action left);
--   * the homeowner contact is opted out or do-not-contact now.
create or replace function public.fn_undo_routing_v2_phone_action(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action public.routing_v2_phone_actions%rowtype;
  v_row public.routing_v2_phone_action_properties%rowtype;
  v_cur record;
  v_reason text;
  v_phone_suppressed boolean;
  v_restored jsonb := '[]'::jsonb;
  v_changed jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_enrollments uuid[] := '{}';
  v_remaining integer;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_action_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select * into v_action from public.routing_v2_phone_actions where id = p_action_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_action.org_id)
     or v_action.org_id not in (select public.pipeline_runs_readable_org_ids()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_action.status = 'undone' then
    return jsonb_build_object('status', 'already_undone', 'restored', '[]'::jsonb, 'stateChanged', '[]'::jsonb, 'skipped', '[]'::jsonb, 'enrollmentIds', '[]'::jsonb);
  end if;
  if v_action.status <> 'applied' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('routing_v2_phone:' || public.routing_v2_phone_digits(v_action.phone_e164)));
  v_phone_suppressed := exists (
    select 1 from public.sms_phone_suppressions sp
    where sp.org_id = v_action.org_id and sp.channel = 'sms'
      and public.routing_v2_phone_digits(sp.phone_e164) = public.routing_v2_phone_digits(v_action.phone_e164)
  );

  for v_row in
    select * from public.routing_v2_phone_action_properties
    where action_id = v_action.id and outcome = 'applied' and undone_at is null
    order by property_id
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || v_row.property_id::text));
    select p.outreach_dispo, p.follow_up_at, p.decision_context_revision,
           p.needs_human_attention, p.last_ai_escalation_reason,
           coalesce(c.sms_opted_out, false) or coalesce(c.do_not_contact, false) as contact_suppressed
    into v_cur
    from public.properties p
    left join public.contacts c on c.id = p.homeowner_contact_id
    where p.id = v_row.property_id and p.org_id = v_action.org_id
    for update of p;

    v_reason := case
      when not found then 'property_missing'
      when v_phone_suppressed then 'phone_suppressed'
      when v_cur.outreach_dispo is distinct from v_row.applied_dispo
        or v_cur.follow_up_at is distinct from v_row.applied_follow_up_at
        or v_cur.decision_context_revision is distinct from v_row.recorded_revision then 'state_changed'
      -- The action left needs_human_attention = false and no reason; anything else is a later hold.
      when v_cur.needs_human_attention is distinct from false
        or v_cur.last_ai_escalation_reason is not null then 'hold_changed'
      when v_cur.contact_suppressed then 'contact_suppressed'
      else null
    end;

    if v_reason is not null then
      v_changed := v_changed || to_jsonb(v_row.property_id);
      v_skipped := v_skipped || jsonb_build_object('propertyId', v_row.property_id, 'reason', v_reason);
      insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload)
      values (
        v_action.org_id, v_row.property_id, 'user', v_actor, 'routing_v2_phone_action_undo_skipped',
        jsonb_build_object('reason', v_reason, 'phone_action_id', v_action.id, 'action', v_action.action)
      );
      continue;
    end if;

    update public.properties
    set outreach_dispo = v_row.prior_outreach_dispo,
        follow_up_at = v_row.prior_follow_up_at,
        needs_human_attention = v_row.prior_needs_human_attention,
        last_ai_escalation_reason = v_row.prior_last_ai_escalation_reason,
        updated_at = now()
    where id = v_row.property_id and org_id = v_action.org_id;

    update public.routing_v2_phone_action_properties
    set undone_at = now(), undone_by = v_actor
    where id = v_row.id;

    insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
    values (
      v_action.org_id, v_row.property_id, 'user', v_actor, 'routing_v2_phone_action_undone',
      jsonb_build_object(
        'action', v_action.action,
        'applied_dispo', v_row.applied_dispo,
        'restored_dispo', v_row.prior_outreach_dispo,
        'phone_action_id', v_action.id,
        'source_inbound_message_id', v_action.source_inbound_message_id
      ),
      'routing_v2_phone_action_properties.undone', v_row.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    v_restored := v_restored || to_jsonb(v_row.property_id);
    v_enrollments := v_enrollments || v_row.paused_enrollment_ids;
  end loop;

  select count(*) into v_remaining
  from public.routing_v2_phone_action_properties
  where action_id = v_action.id and outcome = 'applied' and undone_at is null;
  if v_remaining = 0 then
    update public.routing_v2_phone_actions set status = 'undone', undone_at = now(), undone_by = v_actor where id = v_action.id;
  end if;

  return jsonb_build_object(
    'status', case when v_remaining = 0 then 'undone' else 'partial' end,
    'restored', v_restored,
    'stateChanged', v_changed,
    'skipped', v_skipped,
    'enrollmentIds', to_jsonb(v_enrollments)
  );
end;
$$;
revoke all on function public.fn_undo_routing_v2_phone_action(uuid) from public, anon;
grant execute on function public.fn_undo_routing_v2_phone_action(uuid) to authenticated;

commit;
