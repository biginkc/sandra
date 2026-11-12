-- 20261112120100_multi_number_sender_rpcs.sql
-- Multi-number SMS campaigns, PR 1 of 4: predicates, settings trigger and RPCs
-- (plan §3.1, §3.2, §3.3, §3.8). Additive only; nothing in the application calls these
-- in PR 1 except is_sendable_sender (campaign create/revive). With no
-- sms_sender_settings row every resolution answers 'pinning_off' and every admission 'ok'.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Raise unless the caller may act for p_org_id. Service role / postgres pass; an
-- authenticated caller must be a member.
create or replace function public.sms_sender_assert_org_access(p_org_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org_id is null then
    raise exception 'org id is required' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if auth.uid() is null or not exists (
      select 1 from public.memberships m where m.user_id = auth.uid() and m.org_id = p_org_id
    ) then
      raise exception 'not a member of this organization' using errcode = '42501';
    end if;
  end if;
end;
$$;

create or replace function public.sms_sender_settings_lock_key(p_org_id uuid)
returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$ select hashtextextended(p_org_id::text || ':sms_sender_settings', 0) $$;

create or replace function public.sms_sender_seller_lock_key(p_org_id uuid, p_seller_phone text)
returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$ select hashtextextended(p_org_id::text || ':sendillo:' || p_seller_phone, 0) $$;

-- §3.1 Sendable number: synced active row, Sendillo messaging status Active, attached to a
-- real campaign, and (when the org names one) attached to the org's brand.
create or replace function public.is_sendable_sender(p_org_id uuid, p_provider text, p_phone text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_brand text;
begin
  perform public.sms_sender_assert_org_access(p_org_id);
  if p_phone is null or p_provider is null then
    return false;
  end if;
  select nullif(trim(o.sendillo_brand_name), '') into v_brand
  from public.organizations o where o.id = p_org_id;

  return exists (
    select 1
    from public.provider_sender_numbers p
    where p.org_id = p_org_id
      and p.provider = p_provider
      and p.phone_e164 = trim(p_phone)
      and p.status = 'active'
      and lower(trim(coalesce(p.messaging_status, ''))) = 'active'
      and nullif(trim(coalesce(p.attached_campaign, '')), '') is not null
      and lower(trim(p.attached_campaign)) <> 'not assigned'
      and (v_brand is null or lower(trim(coalesce(p.attached_brand, ''))) = lower(v_brand))
  );
end;
$$;

-- §3.1 Pool number: sendable AND (member of any campaign's number set OR the org default).
create or replace function public.is_pool_sender(p_org_id uuid, p_phone text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_phone is null then
    return false;
  end if;
  if not public.is_sendable_sender(p_org_id, 'sendillo', p_phone) then
    return false;
  end if;
  return exists (
      select 1 from public.campaign_sender_numbers c
      where c.org_id = p_org_id and c.provider = 'sendillo' and c.phone_e164 = trim(p_phone)
    )
    or exists (
      select 1 from public.sms_sender_settings s
      where s.org_id = p_org_id and s.default_sender_phone = trim(p_phone)
    );
end;
$$;

-- §3.3 step 2d: a provider attempt was started and no conclusive provider rejection is
-- recorded. Reads only existing metadata, so it covers historical rows; time never clears it.
--   conclusive rejection = a `failed` status callback (metadata.providerRejection, written by
--   status-events) or a synchronous definitive answer (providerAttempt.outcome
--   'definitively_rejected' / 'not_attempted'). It overrides a retained providerAttempt.
create or replace function public.is_possibly_submitted_sms(p_status text, p_metadata jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_status = 'pending' then true
    when p_status is distinct from 'failed' then false
    when jsonb_typeof(p_metadata) is distinct from 'object' then false
    when p_metadata ? 'providerRejection' then false
    when (p_metadata -> 'providerAttempt' ->> 'outcome') in ('definitively_rejected', 'not_attempted') then false
    when p_metadata ->> 'providerOutcome' = 'provider_unknown' then true
    when jsonb_typeof(p_metadata -> 'providerAttempt') = 'object' then true
    else false
  end
$$;

-- The takeover matcher's "dispatched" qualification (canEstablishRepSmsTakeover,
-- src/lib/messaging/rep-sms-human-takeover.ts): queued/paused/locally-refused rows never count.
create or replace function public.sms_row_dispatched(p_status text, p_metadata jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(trim(lower(p_status)), '') = '' then false
    when lower(p_status) like 'blocked%' then false
    when lower(p_status) in ('failed_not_dispatched', 'queued', 'paused', 'provider_failed', 'delivery_failed') then false
    when lower(p_status) <> 'failed' then true
    else coalesce(p_metadata ->> 'providerOutcome', '') = 'provider_unknown'
  end
$$;

-- §3.1 rep reply: the newest dispatched outbound from the same business number to the same
-- seller phone at or before the inbound (ordered by sent_at ?? created_at) is a rep row.
create or replace function public.is_rep_sms_reply(
  p_org_id uuid,
  p_seller_phone text,
  p_business_phone text,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select (o.metadata ? 'repSms')
    from public.messages o
    where o.org_id = p_org_id
      and o.channel = 'sms'
      and o.direction = 'outbound'
      and o.to_address = p_seller_phone
      and o.from_address = p_business_phone
      and coalesce(o.sent_at, o.created_at) <= p_at
      and public.sms_row_dispatched(o.status, o.metadata)
    order by coalesce(o.sent_at, o.created_at) desc, o.created_at desc, o.id desc
    limit 1
  ), false)
$$;

-- §3.3 step 2a/2b: phone-wide evidence (rep traffic excluded; pool numbers only).
create or replace function public.sms_sender_evidence(p_org_id uuid, p_seller_phone text)
returns table (sender_phone text, source text, message_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select i.to_address, 'evidence_inbound'::text, i.id
  from public.messages i
  where i.org_id = p_org_id
    and i.direction = 'inbound'
    and i.channel = 'sms'
    and i.from_address = p_seller_phone
    and i.provider = 'sendillo'
    and public.is_pool_sender(p_org_id, i.to_address)
    and not public.is_rep_sms_reply(p_org_id, p_seller_phone, i.to_address, coalesce(i.sent_at, i.created_at))
  order by i.created_at desc, i.id desc
  limit 1;
  if found then
    return;
  end if;

  return query
  select o.from_address, 'evidence_outbound'::text, o.id
  from public.messages o
  where o.org_id = p_org_id
    and o.direction = 'outbound'
    and o.channel = 'sms'
    and o.to_address = p_seller_phone
    and o.provider = 'sendillo'
    and o.status in ('sent', 'delivered')
    and not (o.metadata ? 'repSms')
    and public.is_pool_sender(p_org_id, o.from_address)
  order by o.created_at desc, o.id desc
  limit 1;
end;
$$;

-- §3.3 step 2c/2d: distinct pool numbers the seller has outstanding or possibly-submitted
-- (non-rep) work on. Inbox attempts are added in PR 3 (the ledger is not in migrations).
create or replace function public.sms_sender_commitments(p_org_id uuid, p_seller_phone text)
returns table (sender_phone text, message_id uuid, kind text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.from_address, o.id,
    case when o.status in ('queued', 'paused') then 'outstanding' else 'possibly_submitted' end
  from public.messages o
  where o.org_id = p_org_id
    and o.direction = 'outbound'
    and o.channel = 'sms'
    and o.to_address = p_seller_phone
    and o.provider = 'sendillo'
    and not (coalesce(o.metadata, '{}'::jsonb) ? 'repSms')
    and (o.status in ('queued', 'paused') or public.is_possibly_submitted_sms(o.status, o.metadata))
    and public.is_pool_sender(p_org_id, o.from_address)
  order by o.created_at asc, o.id asc
$$;

-- ---------------------------------------------------------------------------
-- sms_sender_settings ordering trigger (§3.2, §3.8)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_sms_sender_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_pinning boolean := false;
  v_old_allocation boolean := false;
  v_old_default text := null;
  v_old_pinning_at timestamptz := null;
begin
  -- Lock protocol: exclusive per-org settings lock BEFORE any check. Resolutions hold the
  -- same key shared until commit, so this waits for every in-flight resolution.
  perform pg_advisory_xact_lock(public.sms_sender_settings_lock_key(new.org_id));

  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception 'sms_sender_settings.org_id cannot change' using errcode = '23514';
    end if;
    -- Re-read under the lock (another writer may have committed while we waited).
    select s.pinning_enabled, s.allocation_enabled, s.default_sender_phone, s.pinning_enabled_at
      into v_old_pinning, v_old_allocation, v_old_default, v_old_pinning_at
    from public.sms_sender_settings s where s.org_id = old.org_id;
  end if;

  new.pinning_enabled := coalesce(new.pinning_enabled, false);
  new.allocation_enabled := coalesce(new.allocation_enabled, false);

  -- default_sender_phone cannot change while pinning is enabled.
  if v_old_pinning and new.default_sender_phone is distinct from v_old_default then
    raise exception 'default_sender_phone cannot change while pinning is enabled' using errcode = '23514';
  end if;

  if new.pinning_enabled and not v_old_pinning then
    if new.default_sender_phone is null
       or not public.is_sendable_sender(new.org_id, 'sendillo', new.default_sender_phone) then
      raise exception 'pinning requires a sendable default_sender_phone' using errcode = '23514';
    end if;
    if new.admission_paused_at is null or new.admission_paused_at > now() - interval '15 minutes' then
      raise exception 'pinning can be enabled only after admission has been paused for 15 minutes'
        using errcode = '23514';
    end if;
    new.pinning_enabled_at := now();
  elsif new.pinning_enabled then
    new.pinning_enabled_at := v_old_pinning_at;
  else
    if v_old_pinning then
      if new.allocation_enabled then
        raise exception 'pinning can be disabled only while allocation is disabled' using errcode = '23514';
      end if;
      if exists (
        select 1 from public.sms_sender_assignments a
        where a.org_id = new.org_id
          and a.sender_phone_e164 is distinct from v_old_default
      ) then
        raise exception 'pinning cannot be disabled while a seller is assigned to a non-default number'
          using errcode = '23514';
      end if;
    end if;
    new.pinning_enabled_at := null;
  end if;

  if new.allocation_enabled and not v_old_allocation then
    if not new.pinning_enabled
       or new.pinning_enabled_at is null
       or new.pinning_enabled_at > now() - interval '1 hour' then
      raise exception 'allocation can be enabled only one hour after pinning' using errcode = '23514';
    end if;
  end if;
  if new.allocation_enabled and not new.pinning_enabled then
    raise exception 'allocation requires pinning' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.enforce_sms_sender_settings() from public, anon, authenticated;

drop trigger if exists sms_sender_settings_enforce on public.sms_sender_settings;
create trigger sms_sender_settings_enforce
before insert or update on public.sms_sender_settings
for each row
execute function public.enforce_sms_sender_settings();

-- ---------------------------------------------------------------------------
-- Resolution core (callers hold both locks). Steps 1-6 of §3.3.
-- p_mode: 'full' (resolve_sms_sender), 'adopt' (evidence + commitments only),
--         'preview' (adopt rules, never writes).
-- ---------------------------------------------------------------------------
create or replace function public.sms_sender_resolve_core(
  p_org_id uuid,
  p_seller_phone text,
  p_settings public.sms_sender_settings,
  p_campaign_id uuid,
  p_allow_default boolean,
  p_requested_sender text,
  p_commitment_sender text,
  p_mode text
)
returns table (sender_phone text, source text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.sms_sender_assignments;
  v_sender text;
  v_source text;
  v_message uuid;
  v_campaign_org uuid;
  v_numbers text[];
  v_n int;
  v_idx bigint;
  v_write boolean := p_mode <> 'preview';
begin
  -- 1. Existing assignment.
  select * into v_existing
  from public.sms_sender_assignments a
  where a.org_id = p_org_id and a.provider = 'sendillo' and a.seller_phone_e164 = p_seller_phone;
  if found then
    if public.is_sendable_sender(p_org_id, 'sendillo', v_existing.sender_phone_e164) then
      return query select v_existing.sender_phone_e164, v_existing.source, 'ok'::text;
    else
      return query select v_existing.sender_phone_e164, v_existing.source, 'assigned_sender_unavailable'::text;
    end if;
    return;
  end if;

  -- 2a/2b. Evidence.
  select e.sender_phone, e.source, e.message_id into v_sender, v_source, v_message
  from public.sms_sender_evidence(p_org_id, p_seller_phone) e;
  if v_sender is not null then
    if v_write then
      insert into public.sms_sender_assignments
        (org_id, provider, seller_phone_e164, sender_phone_e164, source, source_message_id)
      values (p_org_id, 'sendillo', p_seller_phone, v_sender, v_source, v_message);
    end if;
    return query select v_sender, v_source, 'ok'::text;
    return;
  end if;

  -- 2c/2d. Commitments: the supplied stamp (if a pool number) plus every outstanding or
  -- possibly-submitted pool number. More than one distinct number = unresolved conflict.
  select array_agg(distinct x.phone) into v_numbers
  from (
    select c.sender_phone as phone from public.sms_sender_commitments(p_org_id, p_seller_phone) c
    union all
    select trim(p_commitment_sender)
    where p_commitment_sender is not null and public.is_pool_sender(p_org_id, trim(p_commitment_sender))
  ) x;
  if coalesce(array_length(v_numbers, 1), 0) > 1 then
    return query select null::text, null::text, 'sender_conflict_unresolved'::text;
    return;
  elsif coalesce(array_length(v_numbers, 1), 0) = 1 then
    v_sender := v_numbers[1];
    select c.message_id into v_message
    from public.sms_sender_commitments(p_org_id, p_seller_phone) c
    where c.sender_phone = v_sender
    limit 1;
    if v_write then
      insert into public.sms_sender_assignments
        (org_id, provider, seller_phone_e164, sender_phone_e164, source, source_message_id)
      values (p_org_id, 'sendillo', p_seller_phone, v_sender, 'commitment', v_message);
    end if;
    return query select v_sender, 'commitment'::text, 'ok'::text;
    return;
  end if;

  if p_mode <> 'full' then
    return query select null::text, null::text, 'no_sender'::text;
    return;
  end if;

  -- 3. Campaign allocation.
  if p_campaign_id is not null then
    select c.org_id into v_campaign_org from public.campaigns c where c.id = p_campaign_id;
    if v_campaign_org is distinct from p_org_id then
      raise exception 'campaign does not belong to this organization' using errcode = '42501';
    end if;

    -- `for share` serialises against set_campaign_sender_paused (`for update`).
    perform 1 from public.campaign_sender_numbers c
    where c.campaign_id = p_campaign_id
    order by c.phone_e164
    for share;

    select array_agg(c.phone_e164 order by c.phone_e164) into v_numbers
    from public.campaign_sender_numbers c
    where c.campaign_id = p_campaign_id
      and c.paused_at is null
      and c.provider = 'sendillo'
      and public.is_sendable_sender(p_org_id, 'sendillo', c.phone_e164)
      and (
        p_settings.allocation_enabled
        or (c.position = 0 and c.phone_e164 = p_settings.default_sender_phone)
      );
    v_n := coalesce(array_length(v_numbers, 1), 0);
    if v_n = 0 then
      return query select null::text, null::text, 'campaign_has_no_sendable_number'::text;
      return;
    end if;
    v_idx := ((hashtextextended(p_seller_phone, 0) % v_n) + v_n) % v_n;
    v_sender := v_numbers[1 + v_idx::int];
    insert into public.sms_sender_assignments
      (org_id, provider, seller_phone_e164, sender_phone_e164, source, source_campaign_id)
    values (p_org_id, 'sendillo', p_seller_phone, v_sender, 'campaign', p_campaign_id);
    return query select v_sender, 'campaign'::text, 'ok'::text;
    return;
  end if;

  -- 4. Requested sender (composer first contact).
  if p_requested_sender is not null then
    v_sender := trim(p_requested_sender);
    if public.is_pool_sender(p_org_id, v_sender)
       and (p_settings.allocation_enabled or v_sender = p_settings.default_sender_phone) then
      insert into public.sms_sender_assignments
        (org_id, provider, seller_phone_e164, sender_phone_e164, source)
      values (p_org_id, 'sendillo', p_seller_phone, v_sender, 'user_pick');
      return query select v_sender, 'user_pick'::text, 'ok'::text;
    else
      return query select v_sender, null::text, 'requested_sender_not_sendable'::text;
    end if;
    return;
  end if;

  -- 5. Default.
  if p_allow_default
     and p_settings.default_sender_phone is not null
     and public.is_sendable_sender(p_org_id, 'sendillo', p_settings.default_sender_phone) then
    insert into public.sms_sender_assignments
      (org_id, provider, seller_phone_e164, sender_phone_e164, source)
    values (p_org_id, 'sendillo', p_seller_phone, p_settings.default_sender_phone, 'default');
    return query select p_settings.default_sender_phone, 'default'::text, 'ok'::text;
    return;
  end if;

  -- 6.
  return query select null::text, null::text, 'no_sender'::text;
end;
$$;

revoke execute on function public.sms_sender_resolve_core(
  uuid, text, public.sms_sender_settings, uuid, boolean, text, text, text
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- resolve_sms_sender (§3.3) — the single authority for the pinned number.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_sms_sender(
  p_org_id uuid,
  p_seller_phone text,
  p_campaign_id uuid default null,
  p_allow_default boolean default false,
  p_requested_sender text default null,
  p_commitment_sender text default null
)
returns table (sender_phone text, source text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.sms_sender_settings;
  v_seller text := trim(p_seller_phone);
begin
  perform public.sms_sender_assert_org_access(p_org_id);
  if v_seller is null or v_seller !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'seller phone must be E.164' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock_shared(public.sms_sender_settings_lock_key(p_org_id));
  select * into v_settings from public.sms_sender_settings s where s.org_id = p_org_id;
  if not found or not v_settings.pinning_enabled then
    return query select null::text, null::text, 'pinning_off'::text;
    return;
  end if;

  perform pg_advisory_xact_lock(public.sms_sender_seller_lock_key(p_org_id, v_seller));
  return query
  select r.sender_phone, r.source, r.status
  from public.sms_sender_resolve_core(
    p_org_id, v_seller, v_settings, p_campaign_id, coalesce(p_allow_default, false),
    p_requested_sender, p_commitment_sender, 'full'
  ) r;
end;
$$;

-- ---------------------------------------------------------------------------
-- admit_sms_submission (§3.2) — submission fence, called immediately before the provider
-- call by every seller-facing Sendillo path (wired in PR 2/3).
-- ---------------------------------------------------------------------------
create or replace function public.admit_sms_submission(
  p_org_id uuid,
  p_seller_phone text,
  p_from text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.sms_sender_settings;
  v_seller text := trim(p_seller_phone);
  v_from text := trim(p_from);
  v_sender text;
  v_status text;
begin
  perform public.sms_sender_assert_org_access(p_org_id);
  perform pg_advisory_xact_lock_shared(public.sms_sender_settings_lock_key(p_org_id));
  select * into v_settings from public.sms_sender_settings s where s.org_id = p_org_id;
  if not found then
    return 'ok';
  end if;
  if v_settings.admission_paused_at is not null then
    return 'paused';
  end if;
  if not v_settings.pinning_enabled then
    return 'ok';
  end if;
  if v_seller is null or v_seller !~ '^\+[1-9][0-9]{6,14}$' or v_from is null then
    return 'conflict';
  end if;

  perform pg_advisory_xact_lock(public.sms_sender_seller_lock_key(p_org_id, v_seller));
  -- Existing assignment, else evidence, else adopt p_from as a commitment (pool numbers only).
  select r.sender_phone, r.status into v_sender, v_status
  from public.sms_sender_resolve_core(
    p_org_id, v_seller, v_settings, null, false, null, v_from, 'adopt'
  ) r;
  if v_status = 'ok' and v_sender = v_from then
    return 'ok';
  end if;
  return 'conflict';
end;
$$;

-- ---------------------------------------------------------------------------
-- adopt_sms_sender_assignments (§3.2, §6 step 3) — service role, keyset-paged.
-- ---------------------------------------------------------------------------
create or replace function public.adopt_sms_sender_assignments(
  p_org_id uuid,
  p_after_phone text default null,
  p_limit int default 500
)
returns table (seller_phone text, sender_phone text, source text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.sms_sender_settings;
  v_phone text;
  r record;
begin
  perform pg_advisory_xact_lock_shared(public.sms_sender_settings_lock_key(p_org_id));
  select * into v_settings from public.sms_sender_settings s where s.org_id = p_org_id;
  if not found or not v_settings.pinning_enabled then
    raise exception 'adoption requires pinning to be enabled' using errcode = '55000';
  end if;

  for v_phone in
    select distinct x.phone
    from (
      select o.to_address as phone from public.messages o
      where o.org_id = p_org_id and o.channel = 'sms' and o.direction = 'outbound' and o.provider = 'sendillo'
      union
      select i.from_address from public.messages i
      where i.org_id = p_org_id and i.channel = 'sms' and i.direction = 'inbound' and i.provider = 'sendillo'
    ) x
    where x.phone ~ '^\+[1-9][0-9]{6,14}$'
      and (p_after_phone is null or x.phone > p_after_phone)
    order by x.phone
    limit greatest(coalesce(p_limit, 500), 1)
  loop
    perform pg_advisory_xact_lock(public.sms_sender_seller_lock_key(p_org_id, v_phone));
    for r in
      select * from public.sms_sender_resolve_core(
        p_org_id, v_phone, v_settings, null, false, null, null, 'adopt'
      )
    loop
      seller_phone := v_phone;
      sender_phone := r.sender_phone;
      source := r.source;
      status := r.status;
      return next;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- preview_sms_sender_conflicts (§3.2) — read-only activation gate.
-- kinds: outstanding_sender_mismatch, possibly_submitted_mismatch, multiple_outstanding_numbers
-- (inbox attempts are added with the inbox ledger change in PR 3).
-- ---------------------------------------------------------------------------
create or replace function public.preview_sms_sender_conflicts(p_org_id uuid)
returns table (
  kind text,
  seller_phone text,
  message_id uuid,
  sender_phone text,
  expected_sender text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sms_sender_assert_org_access(p_org_id);
  return query
  with work as (
    select o.id, o.to_address as seller, o.from_address as sender, o.status, o.metadata,
      (o.status in ('queued', 'paused')) as outstanding
    from public.messages o
    where o.org_id = p_org_id
      and o.channel = 'sms'
      and o.direction = 'outbound'
      and o.provider = 'sendillo'
      and not (coalesce(o.metadata, '{}'::jsonb) ? 'repSms')
      and (o.status in ('queued', 'paused') or public.is_possibly_submitted_sms(o.status, o.metadata))
  ),
  sellers as (
    select w.seller,
      (select a.sender_phone_e164 from public.sms_sender_assignments a
        where a.org_id = p_org_id and a.provider = 'sendillo' and a.seller_phone_e164 = w.seller) as assigned,
      (select e.sender_phone from public.sms_sender_evidence(p_org_id, w.seller) e) as evidence,
      count(distinct w.sender) as n_numbers,
      min(w.sender) as only_number
    from work w
    group by w.seller
  )
  select 'multiple_outstanding_numbers'::text, s.seller, null::uuid, null::text,
    coalesce(s.assigned, s.evidence)
  from sellers s
  where s.n_numbers > 1
  union all
  select 'outstanding_sender_mismatch'::text, w.seller, w.id, w.sender,
    coalesce(s.assigned, s.evidence, case when s.n_numbers = 1 then s.only_number end)
  from work w join sellers s on s.seller = w.seller
  where w.outstanding
    and w.sender is distinct from coalesce(s.assigned, s.evidence, case when s.n_numbers = 1 then s.only_number end)
  union all
  select 'possibly_submitted_mismatch'::text, w.seller, w.id, w.sender, coalesce(s.assigned, s.evidence)
  from work w join sellers s on s.seller = w.seller
  where not w.outstanding
    and coalesce(s.assigned, s.evidence) is not null
    and w.sender is distinct from coalesce(s.assigned, s.evidence);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_reassign_sms_sender — service role only; not called by any code path in v1.
-- ---------------------------------------------------------------------------
create or replace function public.admin_reassign_sms_sender(
  p_org_id uuid,
  p_seller_phone text,
  p_sender_phone text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seller text := trim(p_seller_phone);
  v_sender text := trim(p_sender_phone);
begin
  if v_seller !~ '^\+[1-9][0-9]{6,14}$' or v_sender !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'phones must be E.164' using errcode = '22023';
  end if;
  if not public.is_sendable_sender(p_org_id, 'sendillo', v_sender) then
    raise exception 'sender is not sendable' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock_shared(public.sms_sender_settings_lock_key(p_org_id));
  perform pg_advisory_xact_lock(public.sms_sender_seller_lock_key(p_org_id, v_seller));
  insert into public.sms_sender_assignments
    (org_id, provider, seller_phone_e164, sender_phone_e164, source)
  values (p_org_id, 'sendillo', v_seller, v_sender, 'admin')
  on conflict (org_id, provider, seller_phone_e164) do update
  set sender_phone_e164 = excluded.sender_phone_e164,
      source = 'admin',
      source_campaign_id = null,
      source_message_id = null,
      assigned_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Campaign number set writers
-- ---------------------------------------------------------------------------
create or replace function public.add_campaign_sender_numbers(p_campaign_id uuid, p_phones text[])
returns setof public.campaign_sender_numbers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_provider text;
  v_phone text;
  v_next int;
  v_count int;
begin
  select c.org_id into v_org from public.campaigns c where c.id = p_campaign_id;
  if v_org is null then
    raise exception 'campaign not found' using errcode = '23503';
  end if;
  perform public.sms_sender_assert_org_access(v_org);

  -- Serialise position assignment per campaign.
  perform pg_advisory_xact_lock(hashtextextended(p_campaign_id::text || ':campaign_sender_numbers', 0));

  select s.provider into v_provider
  from public.campaign_delivery_settings s where s.campaign_id = p_campaign_id and s.org_id = v_org;
  if v_provider is null then
    raise exception 'campaign has no primary sender' using errcode = '23514';
  end if;

  foreach v_phone in array coalesce(p_phones, array[]::text[]) loop
    v_phone := trim(v_phone);
    if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
      raise exception 'sender % is not E.164', v_phone using errcode = '22023';
    end if;
    if exists (select 1 from public.campaign_sender_numbers c
               where c.campaign_id = p_campaign_id and c.phone_e164 = v_phone) then
      continue;
    end if;
    if not public.is_sendable_sender(v_org, v_provider, v_phone) then
      raise exception 'sender % is not sendable', v_phone using errcode = '23514';
    end if;
    select count(*), coalesce(max(c.position), -1) + 1 into v_count, v_next
    from public.campaign_sender_numbers c where c.campaign_id = p_campaign_id;
    if v_count >= 49 then
      raise exception 'a campaign can have at most 49 sending numbers' using errcode = '23514';
    end if;
    insert into public.campaign_sender_numbers (campaign_id, org_id, provider, phone_e164, position)
    values (p_campaign_id, v_org, v_provider, v_phone, greatest(v_next, 1));
  end loop;

  return query
  select * from public.campaign_sender_numbers c
  where c.campaign_id = p_campaign_id
  order by c.position;
end;
$$;

create or replace function public.set_campaign_sender_paused(
  p_campaign_id uuid,
  p_phone text,
  p_paused boolean
)
returns public.campaign_sender_numbers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.campaign_sender_numbers;
begin
  select * into v_row from public.campaign_sender_numbers c
  where c.campaign_id = p_campaign_id and c.phone_e164 = trim(p_phone)
  for update;
  if not found then
    raise exception 'sender is not in this campaign' using errcode = '23503';
  end if;
  perform public.sms_sender_assert_org_access(v_row.org_id);

  update public.campaign_sender_numbers c
  set paused_at = case when p_paused then coalesce(c.paused_at, now()) else null end
  where c.campaign_id = p_campaign_id and c.phone_e164 = v_row.phone_e164
  returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- campaign_kpis_by_sender (§3.2)
-- ---------------------------------------------------------------------------
create or replace function public.campaign_kpis_by_sender(p_campaign_id uuid)
returns table (
  from_address text,
  queued bigint,
  sent_total bigint,
  delivered bigint,
  failed bigint,
  sent_no_receipt bigint,
  repliers bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select c.org_id into v_org from public.campaigns c where c.id = p_campaign_id;
  if v_org is null then
    raise exception 'campaign not found' using errcode = '23503';
  end if;
  perform public.sms_sender_assert_org_access(v_org);

  return query
  select
    m.from_address,
    count(*) filter (where m.status = 'queued'),
    count(*) filter (where m.status in ('sent', 'delivered', 'failed')),
    count(*) filter (where m.status = 'delivered'),
    count(*) filter (where m.status = 'failed'),
    count(*) filter (where m.status = 'sent' and m.sent_at < now() - interval '24 hours'),
    (
      select count(distinct o.to_address)
      from public.messages o
      where o.campaign_id = p_campaign_id
        and o.direction = 'outbound'
        and o.from_address is not distinct from m.from_address
        and exists (
          select 1 from public.messages i
          where i.org_id = v_org
            and i.channel = 'sms'
            and i.direction = 'inbound'
            and i.from_address = o.to_address
            and i.to_address = o.from_address
            and i.created_at > o.created_at
        )
    )
  from public.messages m
  where m.campaign_id = p_campaign_id
    and m.direction = 'outbound'
  group by m.from_address
  order by m.from_address;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: public execute revoked on every new function.
-- ---------------------------------------------------------------------------
revoke execute on function public.sms_sender_assert_org_access(uuid) from public, anon;
revoke execute on function public.sms_sender_settings_lock_key(uuid) from public, anon, authenticated;
revoke execute on function public.sms_sender_seller_lock_key(uuid, text) from public, anon, authenticated;
revoke execute on function public.is_sendable_sender(uuid, text, text) from public, anon;
revoke execute on function public.is_pool_sender(uuid, text) from public, anon, authenticated;
revoke execute on function public.is_possibly_submitted_sms(text, jsonb) from public, anon;
revoke execute on function public.sms_row_dispatched(text, jsonb) from public, anon;
revoke execute on function public.is_rep_sms_reply(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.sms_sender_evidence(uuid, text) from public, anon, authenticated;
revoke execute on function public.sms_sender_commitments(uuid, text) from public, anon, authenticated;
revoke execute on function public.resolve_sms_sender(uuid, text, uuid, boolean, text, text) from public, anon;
revoke execute on function public.admit_sms_submission(uuid, text, text) from public, anon;
revoke execute on function public.adopt_sms_sender_assignments(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.preview_sms_sender_conflicts(uuid) from public, anon;
revoke execute on function public.admin_reassign_sms_sender(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.add_campaign_sender_numbers(uuid, text[]) from public, anon;
revoke execute on function public.set_campaign_sender_paused(uuid, text, boolean) from public, anon;
revoke execute on function public.campaign_kpis_by_sender(uuid) from public, anon;

grant execute on function public.sms_sender_assert_org_access(uuid) to authenticated, service_role;
grant execute on function public.is_sendable_sender(uuid, text, text) to authenticated, service_role;
grant execute on function public.is_pool_sender(uuid, text) to service_role;
grant execute on function public.is_possibly_submitted_sms(text, jsonb) to authenticated, service_role;
grant execute on function public.sms_row_dispatched(text, jsonb) to authenticated, service_role;
grant execute on function public.resolve_sms_sender(uuid, text, uuid, boolean, text, text) to authenticated, service_role;
grant execute on function public.admit_sms_submission(uuid, text, text) to authenticated, service_role;
grant execute on function public.adopt_sms_sender_assignments(uuid, text, int) to service_role;
grant execute on function public.preview_sms_sender_conflicts(uuid) to authenticated, service_role;
grant execute on function public.admin_reassign_sms_sender(uuid, text, text) to service_role;
grant execute on function public.add_campaign_sender_numbers(uuid, text[]) to authenticated, service_role;
grant execute on function public.set_campaign_sender_paused(uuid, text, boolean) to authenticated, service_role;
grant execute on function public.campaign_kpis_by_sender(uuid) to authenticated, service_role;

commit;
