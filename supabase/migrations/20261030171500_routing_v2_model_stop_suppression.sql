-- 20261030171500_routing_v2_model_stop_suppression.sql
-- Routing v2 PR-I: automatic stop suppression (flag-off).
--
-- Jarrad (2026-10-30): a Jev-decided stop (>=0.70, final, no Haiku) or a Jev
-- legal/hostile >=0.70 suppresses the phone automatically, behind
-- ai_responder_configs.routing_v2_flags.model_stop_suppression (default false).
-- The suppression row carries its own source 'model_stop' (never a carrier STOP
-- or DNC source) so it is countable and reversible.
--
-- 1. routing_v2_model_stop_events: audit of every model_stop write, lift and
--    refused lift. One apply row per inbound message (duplicate webhooks).
-- 2. fn_apply_model_stop_suppression (service_role): re-checks the flags at
--    write time (questions_live AND model_stop_suppression) and canary
--    eligibility of EVERY property sharing the phone (same formula as
--    routing-v2/flags.ts; fn_routing_v2_property_eligible), is idempotent per
--    inbound message, and never touches an existing suppression row of any
--    source (insert ... on conflict do nothing).
-- 3. fn_lift_model_stop_suppression (authenticated, Messages v2 gate): deletes
--    a suppression row ONLY while its source is 'model_stop'. Carrier STOP, DNC
--    and human-confirmed rows are refused. Audited.
--
-- Additive only. No data step. With the flag false (the default) nothing calls
-- or writes any of this, and today's human-review path is unchanged.
-- Rollback: supabase/rollbacks/20261030171500_routing_v2_model_stop_suppression.sql

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.routing_v2_model_stop_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  phone_e164 text not null,
  -- Not a foreign key: a lift deletes the suppression row, the audit stays.
  suppression_id uuid,
  inbound_message_id uuid,
  property_id uuid,
  contact_id uuid,
  action text not null,
  -- For already_suppressed / lift_refused: the source of the row that was left alone.
  existing_source text,
  actor_user_id uuid references auth.users(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint routing_v2_model_stop_events_action_check
    check (action in ('suppressed', 'already_suppressed', 'lifted', 'lift_refused')),
  constraint routing_v2_model_stop_events_phone_check
    check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint routing_v2_model_stop_events_apply_has_inbound
    check (action not in ('suppressed', 'already_suppressed') or inbound_message_id is not null)
);

comment on table public.routing_v2_model_stop_events is
  'Routing v2 PR-I audit: automatic model_stop phone suppressions, their lifts, and refused lifts.';

-- Idempotency: one apply outcome per inbound message, whatever happens later.
create unique index if not exists idx_routing_v2_model_stop_events_apply_inbound
  on public.routing_v2_model_stop_events (inbound_message_id)
  where action in ('suppressed', 'already_suppressed');

create index if not exists idx_routing_v2_model_stop_events_org_phone
  on public.routing_v2_model_stop_events (org_id, phone_e164, created_at desc);

create index if not exists idx_routing_v2_model_stop_events_suppression
  on public.routing_v2_model_stop_events (suppression_id)
  where suppression_id is not null;

alter table public.routing_v2_model_stop_events enable row level security;
revoke all on public.routing_v2_model_stop_events from public, anon, authenticated;
grant select on public.routing_v2_model_stop_events to authenticated;
grant select, insert on public.routing_v2_model_stop_events to service_role;

drop policy if exists routing_v2_model_stop_events_org_select on public.routing_v2_model_stop_events;
create policy routing_v2_model_stop_events_org_select on public.routing_v2_model_stop_events
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

-- ---------------------------------------------------------------------------
-- Canary eligibility, the SQL twin of routing-v2/flags.ts (BUILD-PLAN §13.1).
-- Pinned to the TS helpers by the integration test (same answers, same ids).
-- Fail closed: any malformed canary_property_ids / canary_percent = nothing eligible.
-- ---------------------------------------------------------------------------
create or replace function public.fn_routing_v2_canary_bucket(p_property_id uuid)
returns integer
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  -- flags.ts canaryBucket: sha256(lower(id)), first 4 bytes as an unsigned int, mod 100.
  select ((('x' || substr(encode(sha256(convert_to(lower(p_property_id::text), 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint) % 100)::integer;
$$;

create or replace function public.fn_routing_v2_property_eligible(p_flags jsonb, p_property_id uuid)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb;
  v_pct jsonb;
  v_pct_num numeric;
begin
  if p_property_id is null or p_flags is null or jsonb_typeof(p_flags) <> 'object' then
    return false;
  end if;
  v_ids := p_flags -> 'canary_property_ids';
  v_pct := p_flags -> 'canary_percent';
  -- canary_property_ids: absent, or an array whose every entry is a UUID string.
  if v_ids is not null then
    if jsonb_typeof(v_ids) <> 'array' then
      return false;
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_ids) e
      where jsonb_typeof(e) <> 'string'
         or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      return false;
    end if;
  end if;
  -- canary_percent: absent, or an integer 0..100.
  if v_pct is not null then
    if jsonb_typeof(v_pct) <> 'number' then
      return false;
    end if;
    v_pct_num := (v_pct #>> '{}')::numeric;
    if v_pct_num <> trunc(v_pct_num) or v_pct_num < 0 or v_pct_num > 100 then
      return false;
    end if;
  else
    v_pct_num := 0;
  end if;
  if v_ids is not null and exists (
    select 1 from jsonb_array_elements_text(v_ids) t where lower(t) = lower(p_property_id::text)
  ) then
    return true;
  end if;
  return public.fn_routing_v2_canary_bucket(p_property_id) < v_pct_num;
end;
$$;

-- Every live property that shares this phone in the org: the inbound's own property,
-- properties whose homeowner contact has the phone, and properties linked to such a
-- contact through property_contacts. Phone-level actions need ALL of them eligible.
create or replace function public.fn_model_stop_phone_property_ids(p_org_id uuid, p_phone_e164 text, p_property_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with c as (
    select ct.id from public.contacts ct
    where ct.org_id = p_org_id
      and p_phone_e164 in (ct.phone_1, ct.phone_2, ct.phone_3)
    union
    select n.contact_id from public.contact_phone_numbers n
    where n.org_id = p_org_id and n.e164 = p_phone_e164
  )
  select p.id from public.properties p
  where p.org_id = p_org_id
    and p.deleted_at is null
    and (
      p.id = p_property_id
      or p.homeowner_contact_id in (select id from c)
      or exists (
        select 1 from public.property_contacts pc
        where pc.org_id = p_org_id and pc.property_id = p.id and pc.contact_id in (select id from c)
      )
    );
$$;

revoke all on function public.fn_routing_v2_canary_bucket(uuid) from public, anon, authenticated;
revoke all on function public.fn_routing_v2_property_eligible(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.fn_model_stop_phone_property_ids(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_canary_bucket(uuid) to service_role;
grant execute on function public.fn_routing_v2_property_eligible(jsonb, uuid) to service_role;
grant execute on function public.fn_model_stop_phone_property_ids(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Apply (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.fn_apply_model_stop_suppression(
  p_org_id uuid,
  p_phone_e164 text,
  p_inbound_message_id uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_detail jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prior public.routing_v2_model_stop_events%rowtype;
  v_existing public.sms_phone_suppressions%rowtype;
  v_suppression_id uuid;
  v_config_count integer;
  v_flags jsonb;
  v_phone_properties uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_org_id is null or p_inbound_message_id is null
     or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  -- Serialize per inbound (duplicate webhooks) and per phone (concurrent replies).
  perform pg_advisory_xact_lock(hashtext('model_stop_inbound:' || p_inbound_message_id::text));
  perform pg_advisory_xact_lock(hashtext('model_stop_phone:' || p_org_id::text || ':' || p_phone_e164));

  select * into v_prior
  from public.routing_v2_model_stop_events e
  where e.inbound_message_id = p_inbound_message_id
    and e.action in ('suppressed', 'already_suppressed');
  if found then
    return jsonb_build_object('status', 'duplicate', 'prior', v_prior.action, 'suppressionId', v_prior.suppression_id);
  end if;

  -- Write-time flag re-check: flag off = nothing written. Exactly one active config
  -- (flags.ts reads it with maybeSingle; two active rows read as all off).
  select count(*), (array_agg(c.routing_v2_flags))[1]
  into v_config_count, v_flags
  from public.ai_responder_configs c
  where c.org_id = p_org_id and c.active = true;
  if v_config_count <> 1
     or jsonb_typeof(v_flags) is distinct from 'object'
     or v_flags -> 'questions_live' is distinct from 'true'::jsonb
     or v_flags -> 'model_stop_suppression' is distinct from 'true'::jsonb then
    return jsonb_build_object('status', 'flag_off');
  end if;

  -- Write-time canary re-check (§13.1/§13.2): every property on this phone must be
  -- eligible right now, under the same formula as routing-v2/flags.ts.
  select coalesce(array_agg(x), '{}') into v_phone_properties
  from public.fn_model_stop_phone_property_ids(p_org_id, p_phone_e164, p_property_id) x;
  if cardinality(v_phone_properties) = 0 or exists (
    select 1 from unnest(v_phone_properties) x
    where not public.fn_routing_v2_property_eligible(v_flags, x)
  ) then
    return jsonb_build_object('status', 'not_eligible');
  end if;

  if not exists (
    select 1 from public.messages m
    where m.id = p_inbound_message_id and m.org_id = p_org_id and m.direction = 'inbound'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.sms_phone_suppressions (
    org_id, channel, phone_e164, source, source_detail, first_contact_id, provider
  ) values (
    p_org_id, 'sms', p_phone_e164, 'model_stop',
    coalesce(p_detail, '{}'::jsonb) || jsonb_build_object(
      'inboundMessageId', p_inbound_message_id, 'propertyId', p_property_id),
    p_contact_id, 'routing_v2'
  )
  on conflict (org_id, channel, phone_e164) do nothing
  returning id into v_suppression_id;

  if v_suppression_id is not null then
    insert into public.routing_v2_model_stop_events (
      org_id, phone_e164, suppression_id, inbound_message_id, property_id, contact_id, action, detail
    ) values (
      p_org_id, p_phone_e164, v_suppression_id, p_inbound_message_id, p_property_id, p_contact_id,
      'suppressed', coalesce(p_detail, '{}'::jsonb)
    );
    return jsonb_build_object('status', 'suppressed', 'suppressionId', v_suppression_id);
  end if;

  -- Already suppressed (carrier STOP, DNC, human, or an earlier model_stop): left untouched.
  select * into v_existing
  from public.sms_phone_suppressions s
  where s.org_id = p_org_id and s.channel = 'sms' and s.phone_e164 = p_phone_e164;
  insert into public.routing_v2_model_stop_events (
    org_id, phone_e164, suppression_id, inbound_message_id, property_id, contact_id, action, existing_source, detail
  ) values (
    p_org_id, p_phone_e164, v_existing.id, p_inbound_message_id, p_property_id, p_contact_id,
    'already_suppressed', v_existing.source, coalesce(p_detail, '{}'::jsonb)
  );
  return jsonb_build_object('status', 'already_suppressed', 'suppressionId', v_existing.id, 'existingSource', v_existing.source);
end;
$$;

revoke all on function public.fn_apply_model_stop_suppression(uuid, text, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_apply_model_stop_suppression(uuid, text, uuid, uuid, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Lift (authenticated; owner or acquisitions, the Messages v2 gate)
-- ---------------------------------------------------------------------------
create or replace function public.fn_lift_model_stop_suppression(p_suppression_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.sms_phone_suppressions%rowtype;
  v_lifted public.routing_v2_model_stop_events%rowtype;
  v_note text := nullif(left(coalesce(p_note, ''), 500), '');
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_suppression_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select * into v_row from public.sms_phone_suppressions where id = p_suppression_id for update;
  if not found then
    -- Already lifted? Only visible to someone who may see that org's audit.
    select * into v_lifted
    from public.routing_v2_model_stop_events e
    where e.suppression_id = p_suppression_id and e.action = 'lifted'
    order by e.created_at desc
    limit 1;
    if found
       and public.hugo_has_active_org_access(v_lifted.org_id)
       and v_lifted.org_id in (select public.pipeline_runs_readable_org_ids()) then
      return jsonb_build_object('status', 'already_lifted');
    end if;
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.hugo_has_active_org_access(v_row.org_id)
     or v_row.org_id not in (select public.pipeline_runs_readable_org_ids()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('model_stop_phone:' || v_row.org_id::text || ':' || v_row.phone_e164));

  if v_row.source is distinct from 'model_stop' then
    -- Carrier STOP, DNC, human-confirmed or any other source: never lifted here.
    insert into public.routing_v2_model_stop_events (
      org_id, phone_e164, suppression_id, action, existing_source, actor_user_id, detail
    ) values (
      v_row.org_id, v_row.phone_e164, v_row.id, 'lift_refused', v_row.source, v_actor,
      jsonb_build_object('note', v_note)
    );
    return jsonb_build_object('status', 'not_model_stop');
  end if;

  delete from public.sms_phone_suppressions
  where id = v_row.id and source = 'model_stop';

  insert into public.routing_v2_model_stop_events (
    org_id, phone_e164, suppression_id, inbound_message_id, property_id, contact_id,
    action, actor_user_id, detail
  ) values (
    v_row.org_id, v_row.phone_e164, v_row.id,
    nullif(v_row.source_detail ->> 'inboundMessageId', '')::uuid,
    nullif(v_row.source_detail ->> 'propertyId', '')::uuid,
    v_row.first_contact_id,
    'lifted', v_actor,
    jsonb_build_object(
      'note', v_note,
      'suppressedAt', v_row.suppressed_at,
      'sourceDetail', v_row.source_detail
    )
  );
  return jsonb_build_object('status', 'lifted', 'phone', v_row.phone_e164);
end;
$$;

revoke all on function public.fn_lift_model_stop_suppression(uuid, text) from public, anon;
grant execute on function public.fn_lift_model_stop_suppression(uuid, text) to authenticated;

commit;
