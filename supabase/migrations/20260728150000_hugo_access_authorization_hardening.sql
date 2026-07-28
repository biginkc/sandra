-- Hugo/Sandra forward-only authorization hardening.
--
-- This migration repairs already-hosted databases after the initial lifecycle
-- and request-hash migrations. It makes suspension/expiry effective at the
-- database boundary, reserves operation ids before Auth provisioning, protects
-- the final owner across expiry changes, and closes pristine-delete gaps.

begin;

-- An authenticated session can only expose its membership while the grant is
-- usable. Every tenant-table RLS policy resolves through this row, so an older
-- access token loses direct PostgREST access immediately on suspend, revoke,
-- expiry, or delete preparation.
drop policy if exists memberships_self_select on public.memberships;
create policy memberships_self_select on public.memberships
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and access_status = 'active'
    and deletion_prepared_at is null
    and (access_expires_at is null or access_expires_at > now())
  );

-- Lifecycle fields are service-owned. This is defense in depth in addition to
-- the absence of an authenticated UPDATE policy after migration 056.
create or replace function public.hugo_membership_lifecycle_service_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'HUGO_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.hugo_membership_lifecycle_service_guard()
  from public, anon, authenticated;

drop trigger if exists trg_hugo_membership_lifecycle_service_guard
  on public.memberships;
create trigger trg_hugo_membership_lifecycle_service_guard
  before update of role, access_status, hugo_config, access_expires_at,
    deletion_prepared_at, deletion_operation_id
  on public.memberships
  for each row execute function public.hugo_membership_lifecycle_service_guard();

-- SECURITY DEFINER RPCs do not inherit the caller's RLS filtering. Every
-- authenticated RPC wrapper below calls this explicit active-grant check.
create or replace function public.hugo_has_active_org_access(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = p_org_id
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > now())
    );
$$;

revoke all on function public.hugo_has_active_org_access(uuid)
  from public, anon, authenticated, service_role;

-- Keep powerful legacy RPC bodies private and put the lifecycle check in front
-- of them. Renaming preserves the exact logic already reviewed for each RPC.
do $$
begin
  if to_regprocedure('public.delete_contact(uuid,text)') is not null
     and to_regprocedure('public.delete_contact_hugo_unchecked(uuid,text)') is null then
    alter function public.delete_contact(uuid, text)
      rename to delete_contact_hugo_unchecked;
  end if;
  if to_regprocedure('public.merge_duplicate_properties(uuid,uuid)') is not null
     and to_regprocedure('public.merge_duplicate_properties_hugo_unchecked(uuid,uuid)') is null then
    alter function public.merge_duplicate_properties(uuid, uuid)
      rename to merge_duplicate_properties_hugo_unchecked;
  end if;
  if to_regprocedure('public.ensure_sms_conversation_id(uuid,uuid)') is not null
     and to_regprocedure('public.ensure_sms_conversation_id_hugo_unchecked(uuid,uuid)') is null then
    alter function public.ensure_sms_conversation_id(uuid, uuid)
      rename to ensure_sms_conversation_id_hugo_unchecked;
  end if;
  if to_regprocedure('public.campaign_kpis(uuid)') is not null
     and to_regprocedure('public.campaign_kpis_hugo_unchecked(uuid)') is null then
    alter function public.campaign_kpis(uuid)
      rename to campaign_kpis_hugo_unchecked;
  end if;
  if to_regprocedure('public.preview_campaign_cadence_reschedule(uuid,integer,integer)') is not null
     and to_regprocedure('public.preview_campaign_cadence_reschedule_hugo_unchecked(uuid,integer,integer)') is null then
    alter function public.preview_campaign_cadence_reschedule(uuid, integer, integer)
      rename to preview_campaign_cadence_reschedule_hugo_unchecked;
  end if;
end;
$$;

revoke all on function public.delete_contact_hugo_unchecked(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.merge_duplicate_properties_hugo_unchecked(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ensure_sms_conversation_id_hugo_unchecked(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.campaign_kpis_hugo_unchecked(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_campaign_cadence_reschedule_hugo_unchecked(uuid, integer, integer)
  from public, anon, authenticated, service_role;

create or replace function public.delete_contact(p_contact_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
begin
  select c.org_id into v_org_id
  from public.contacts c
  where c.id = p_contact_id;
  if v_org_id is null then
    raise exception 'delete_contact: contact not found (%)', p_contact_id
      using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_org_id) then
    raise exception 'delete_contact: active access required'
      using errcode = '42501';
  end if;
  perform public.delete_contact_hugo_unchecked(p_contact_id, p_reason);
end;
$$;

revoke all on function public.delete_contact(uuid, text) from public, anon;
grant execute on function public.delete_contact(uuid, text)
  to authenticated, service_role;

create or replace function public.merge_duplicate_properties(
  keeper_id uuid,
  loser_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keeper_org_id uuid;
  v_loser_org_id uuid;
begin
  select p.org_id into v_keeper_org_id
  from public.properties p where p.id = keeper_id;
  select p.org_id into v_loser_org_id
  from public.properties p where p.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;
  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;

revoke all on function public.merge_duplicate_properties(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.merge_duplicate_properties(uuid, uuid)
  to authenticated;

create or replace function public.ensure_sms_conversation_id(
  p_contact_id uuid,
  p_property_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
begin
  v_org_id := public.sms_thread_org_id(p_contact_id, p_property_id);
  if v_org_id is null then
    raise exception 'contact/property thread scope not found'
      using errcode = '42501';
  end if;
  if not public.hugo_has_active_org_access(v_org_id) then
    raise exception 'active access required for contact/property thread'
      using errcode = '42501';
  end if;
  return public.ensure_sms_conversation_id_hugo_unchecked(
    p_contact_id, p_property_id
  );
end;
$$;

revoke all on function public.ensure_sms_conversation_id(uuid, uuid)
  from public, anon;
grant execute on function public.ensure_sms_conversation_id(uuid, uuid)
  to authenticated, service_role;

create or replace function public.campaign_kpis(p_campaign_id uuid)
returns table (
  audience bigint,
  attempted bigint,
  delivered bigint,
  delivered_rate double precision,
  failed bigint,
  failed_rate double precision,
  replied bigint,
  reply_rate double precision,
  opted_out bigint,
  opt_out_rate double precision
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
begin
  select c.org_id into v_org_id
  from public.campaigns c where c.id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign_kpis: campaign % not found', p_campaign_id
      using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_org_id) then
    raise exception 'campaign_kpis: active access required'
      using errcode = '42501';
  end if;
  return query
    select *
    from public.campaign_kpis_hugo_unchecked(p_campaign_id);
end;
$$;

revoke all on function public.campaign_kpis(uuid) from public, anon;
grant execute on function public.campaign_kpis(uuid)
  to authenticated, service_role;

create or replace function public.preview_campaign_cadence_reschedule(
  p_campaign_id uuid,
  p_pace_seconds integer,
  p_start_after_seconds integer default 300
)
returns table (
  affected_count bigint,
  first_scheduled_for timestamptz,
  last_scheduled_for timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
begin
  select c.org_id into v_org_id
  from public.campaigns c where c.id = p_campaign_id;
  if v_org_id is null then
    raise exception 'preview_campaign_cadence_reschedule: campaign % not found',
      p_campaign_id using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_org_id) then
    raise exception 'preview_campaign_cadence_reschedule: active access required'
      using errcode = '42501';
  end if;
  return query
    select *
    from public.preview_campaign_cadence_reschedule_hugo_unchecked(
      p_campaign_id, p_pace_seconds, p_start_after_seconds
    );
end;
$$;

revoke all on function public.preview_campaign_cadence_reschedule(uuid, integer, integer)
  from public, anon;
grant execute on function public.preview_campaign_cadence_reschedule(uuid, integer, integer)
  to authenticated, service_role;

-- Discover all durable public references instead of relying on a hand-written
-- list that becomes stale when a future attribution column is added.
create or replace function public.hugo_has_durable_activity(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference record;
  v_exists boolean;
begin
  for v_reference in
    select c.conrelid::regclass as relation_name, a.attname as column_name
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'auth.users'::regclass
      and array_length(c.conkey, 1) = 1
      and n.nspname = 'public'
      and rel.relname <> 'memberships'
  loop
    execute format(
      'select exists (select 1 from %s where %I = $1)',
      v_reference.relation_name,
      v_reference.column_name
    ) into v_exists using p_user_id;
    if v_exists then return true; end if;
  end loop;

  if to_regclass('storage.objects') is not null then
    if exists (
      select 1 from pg_attribute
      where attrelid = 'storage.objects'::regclass
        and attname = 'owner_id' and not attisdropped
    ) then
      execute 'select exists (select 1 from storage.objects where owner_id::text = $1::text)'
        into v_exists using p_user_id;
      if v_exists then return true; end if;
    end if;
    if exists (
      select 1 from pg_attribute
      where attrelid = 'storage.objects'::regclass
        and attname = 'owner' and not attisdropped
    ) then
      execute 'select exists (select 1 from storage.objects where owner::text = $1::text)'
        into v_exists using p_user_id;
      if v_exists then return true; end if;
    end if;
  end if;
  return false;
end;
$$;

revoke all on function public.hugo_has_durable_activity(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.hugo_has_prior_sign_in(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = auth, pg_temp
as $$
  select coalesce(
    (select u.last_sign_in_at is not null from auth.users u where u.id = p_user_id),
    false
  ) or exists (
    select 1
    from auth.identities i
    where i.user_id = p_user_id
      and i.last_sign_in_at is not null
  );
$$;

revoke all on function public.hugo_has_prior_sign_in(uuid)
  from public, anon, authenticated, service_role;

-- The final owner must remain active beyond any newly configured expiration.
create or replace function public.hugo_membership_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_other_owner boolean;
  v_required_until timestamptz;
begin
  if old.role = 'owner' then
    perform pg_advisory_xact_lock(
      hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
    );
  end if;
  if old.role = 'owner' and (
    tg_op = 'DELETE'
    or (
      tg_op = 'UPDATE'
      and (
        new.role <> 'owner'
        or new.access_status <> 'active'
        or (
          new.deletion_prepared_at is not null
          and new.deletion_prepared_at is distinct from old.deletion_prepared_at
        )
        or (
          new.access_expires_at is not null
          and new.access_expires_at is distinct from old.access_expires_at
        )
      )
    )
  ) then
    v_required_until := case
      when tg_op = 'UPDATE'
        and new.role = 'owner'
        and new.access_status = 'active'
        and new.deletion_prepared_at is null
        and new.access_expires_at is not null
        then greatest(new.access_expires_at, now())
      else now()
    end;
    select exists (
      select 1
      from public.memberships m
      where m.org_id = old.org_id
        and m.user_id <> old.user_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (
          m.access_expires_at is null
          or m.access_expires_at > v_required_until
        )
    ) into v_other_owner;
    if not v_other_owner then
      raise exception 'FINAL_OWNER_GUARD' using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.hugo_membership_owner_guard()
  from public, anon, authenticated, service_role;

-- Reserve an operation id before the TypeScript adapter creates an Auth user.
-- A changed retry therefore fails before producing an orphan identity.
create table if not exists public.hugo_access_operation_claims (
  operation_id uuid primary key,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  email text not null,
  requested jsonb not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

alter table public.hugo_access_operation_claims enable row level security;
drop policy if exists hugo_access_operation_claims_service_only
  on public.hugo_access_operation_claims;
create policy hugo_access_operation_claims_service_only
  on public.hugo_access_operation_claims
  for all to service_role
  using (true)
  with check (true);

create or replace function public.hugo_preflight_access_operation(
  p_operation_id uuid,
  p_email text,
  p_role text,
  p_config jsonb,
  p_status text,
  p_access_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_config jsonb := case
    when public.hugo_sandra_config_is_safe(coalesce(p_config, '{}'::jsonb))
      then coalesce(p_config, '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_error_code text;
  v_error_message text;
  v_receipt jsonb;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(
    hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
  );
  v_hash := public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      'hugo_apply_access',
      v_email,
      p_role,
      v_config,
      p_status,
      to_jsonb(p_access_expires_at)
    )
  );

  if p_operation_id is not null then
    select op.request_hash, op.receipt
      into v_prior_hash, v_prior
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash then
        return jsonb_build_object(
          'proceed', false,
          'receipt', public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash)
        );
      end if;
      return jsonb_build_object(
        'proceed', false,
        'receipt', public.hugo_sandra_operation_payload_conflict_receipt(
          p_operation_id, p_role, p_status, p_access_expires_at, v_hash
        )
      );
    end if;
  end if;

  if p_operation_id is null or v_email = '' then
    v_error_code := 'INVALID_REQUEST';
    v_error_message := 'A valid operation and email are required.';
  elsif v_email !~ '^[^@[:space:]]+@bmhgroupkc\.com$' then
    v_error_code := 'INVALID_DOMAIN';
    v_error_message := 'Sandra access is limited to the BMH Group email domain.';
  elsif p_role is null or p_role not in ('owner', 'member') then
    v_error_code := 'INVALID_ROLE';
    v_error_message := 'Sandra role must be owner or member.';
  elsif p_status is null or p_status not in ('active', 'suspended', 'revoked') then
    v_error_code := 'INVALID_STATUS';
    v_error_message := 'Sandra access status is invalid.';
  elsif not public.hugo_sandra_config_is_safe(coalesce(p_config, '{}'::jsonb)) then
    v_error_code := 'INVALID_CONFIG';
    v_error_message := 'Sandra access configuration is invalid.';
  end if;

  if v_error_code is not null then
    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id, null, p_role, v_config, p_status,
        p_access_expires_at, null, '{}'::jsonb, 'missing', null,
        false, false, v_error_code, v_error_message
      ),
      v_hash
    );
    if p_operation_id is not null then
      perform public.hugo_store_access_operation(
        p_operation_id,
        'grant',
        v_email,
        null,
        jsonb_build_object(
          'role', p_role,
          'config', v_config,
          'status', p_status,
          'access_expires_at', p_access_expires_at
        ),
        v_hash,
        v_receipt
      );
    end if;
    return jsonb_build_object('proceed', false, 'receipt', v_receipt);
  end if;

  select claim.request_hash into v_prior_hash
  from public.hugo_access_operation_claims claim
  where claim.operation_id = p_operation_id;
  if found then
    if v_prior_hash = v_hash then
      return jsonb_build_object('proceed', true, 'request_hash', v_hash);
    end if;
    return jsonb_build_object(
      'proceed', false,
      'receipt', public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, p_role, p_status, p_access_expires_at, v_hash
      )
    );
  end if;

  insert into public.hugo_access_operation_claims(
    operation_id, request_hash, email, requested
  ) values (
    p_operation_id,
    v_hash,
    v_email,
    jsonb_build_object(
      'role', p_role,
      'config', v_config,
      'status', p_status,
      'access_expires_at', p_access_expires_at
    )
  );
  return jsonb_build_object('proceed', true, 'request_hash', v_hash);
end;
$$;

revoke all on function public.hugo_preflight_access_operation(uuid, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hugo_preflight_access_operation(uuid, text, text, jsonb, text, timestamptz)
  to service_role;

-- Add claim verification and a receipt-producing final-owner check in front of
-- the hosted request-hash wrapper.
do $$
begin
  if to_regprocedure('public.hugo_apply_access(uuid,text,text,jsonb,text,timestamptz)') is not null
     and to_regprocedure('public.hugo_apply_access_claimed_unchecked(uuid,text,text,jsonb,text,timestamptz)') is null then
    alter function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
      rename to hugo_apply_access_claimed_unchecked;
  end if;
end;
$$;

revoke all on function public.hugo_apply_access_claimed_unchecked(uuid, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.hugo_apply_access(
  p_operation_id uuid,
  p_email text,
  p_role text,
  p_config jsonb,
  p_status text,
  p_access_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_config jsonb := case
    when public.hugo_sandra_config_is_safe(coalesce(p_config, '{}'::jsonb))
      then coalesce(p_config, '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_hash text;
  v_claim_hash text;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_other_owner boolean;
  v_required_until timestamptz;
  v_receipt jsonb;
  v_operation text;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(
    hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
  );
  v_hash := public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      'hugo_apply_access',
      v_email,
      p_role,
      v_config,
      p_status,
      to_jsonb(p_access_expires_at)
    )
  );

  if p_operation_id is not null then
    select claim.request_hash into v_claim_hash
    from public.hugo_access_operation_claims claim
    where claim.operation_id = p_operation_id;
    if found and v_claim_hash <> v_hash then
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, p_role, p_status, p_access_expires_at, v_hash
      );
    elsif not found then
      insert into public.hugo_access_operation_claims(
        operation_id, request_hash, email, requested
      ) values (
        p_operation_id,
        v_hash,
        v_email,
        jsonb_build_object(
          'role', p_role,
          'config', v_config,
          'status', p_status,
          'access_expires_at', p_access_expires_at
        )
      );
    end if;
  end if;

  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is not null then
    select * into v_membership
    from public.memberships m
    where m.user_id = v_user_id
      and m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
    for update;
  end if;

  if v_membership.user_id is not null
     and v_membership.role = 'owner'
     and (
       p_role <> 'owner'
       or p_status <> 'active'
       or (
         p_access_expires_at is not null
         and p_access_expires_at is distinct from v_membership.access_expires_at
       )
     ) then
    v_required_until := case
      when p_role = 'owner'
        and p_status = 'active'
        and p_access_expires_at is not null
        then greatest(p_access_expires_at, now())
      else now()
    end;
    select exists (
      select 1
      from public.memberships m
      where m.org_id = v_membership.org_id
        and m.user_id <> v_user_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (
          m.access_expires_at is null
          or m.access_expires_at > v_required_until
        )
    ) into v_other_owner;
    if not v_other_owner then
      v_receipt := public.hugo_sandra_receipt_with_request_hash(
        public.hugo_receipt(
          p_operation_id,
          v_user_id,
          p_role,
          v_config,
          p_status,
          p_access_expires_at,
          v_membership.role,
          v_membership.hugo_config,
          v_membership.access_status,
          v_membership.access_expires_at,
          public.hugo_has_durable_activity(v_user_id),
          false,
          'FINAL_OWNER_GUARD',
          'Sandra must retain at least one active owner.'
        ),
        v_hash
      );
      v_operation := case
        when p_status = 'suspended' then 'suspend'
        when p_status = 'revoked' then 'revoke'
        else 'grant'
      end;
      perform public.hugo_store_access_operation(
        p_operation_id,
        v_operation,
        v_email,
        v_user_id,
        jsonb_build_object(
          'role', p_role,
          'config', v_config,
          'status', p_status,
          'access_expires_at', p_access_expires_at
        ),
        v_hash,
        v_receipt
      );
      update public.hugo_access_operation_claims
      set consumed_at = now()
      where operation_id = p_operation_id and request_hash = v_hash;
      return v_receipt;
    end if;
  end if;

  v_receipt := public.hugo_apply_access_claimed_unchecked(
    p_operation_id,
    p_email,
    p_role,
    p_config,
    p_status,
    p_access_expires_at
  );
  update public.hugo_access_operation_claims
  set consumed_at = now()
  where operation_id = p_operation_id and request_hash = v_hash;
  return public.hugo_sandra_receipt_with_request_hash(v_receipt, v_hash);
end;
$$;

revoke all on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
  to service_role;

-- Add prior-sign-in and prepare-proof gates around the hosted delete wrappers.
do $$
begin
  if to_regprocedure('public.hugo_prepare_pristine_delete(uuid,text)') is not null
     and to_regprocedure('public.hugo_prepare_pristine_delete_authorization_unchecked(uuid,text)') is null then
    alter function public.hugo_prepare_pristine_delete(uuid, text)
      rename to hugo_prepare_pristine_delete_authorization_unchecked;
  end if;
  if to_regprocedure('public.hugo_delete_identity(uuid,text)') is not null
     and to_regprocedure('public.hugo_delete_identity_authorization_unchecked(uuid,text)') is null then
    alter function public.hugo_delete_identity(uuid, text)
      rename to hugo_delete_identity_authorization_unchecked;
  end if;
end;
$$;

revoke all on function public.hugo_prepare_pristine_delete_authorization_unchecked(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hugo_delete_identity_authorization_unchecked(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.hugo_prepare_pristine_delete(
  p_operation_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_receipt jsonb;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(
    hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
  );
  v_hash := public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      'hugo_prepare_pristine_delete',
      v_email,
      null,
      '{}'::jsonb,
      'revoked',
      null
    )
  );
  if p_operation_id is not null then
    select op.request_hash, op.receipt into v_prior_hash, v_prior
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash then
        return public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash);
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, null, 'revoked', null, v_hash
      );
    end if;
  end if;

  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is not null
     and (
       public.hugo_has_durable_activity(v_user_id)
       or public.hugo_has_prior_sign_in(v_user_id)
     ) then
    select * into v_membership
    from public.memberships m
    where m.user_id = v_user_id
      and m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid;
    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id,
        v_user_id,
        v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb),
        'revoked',
        v_membership.access_expires_at,
        v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb),
        coalesce(v_membership.access_status, 'missing'),
        v_membership.access_expires_at,
        true,
        false,
        'NON_PRISTINE',
        'Sandra identity has prior sign-in or durable business activity.'
      ),
      v_hash
    );
    perform public.hugo_store_access_operation(
      p_operation_id,
      'preparePristineDelete',
      v_email,
      v_user_id,
      '{"status":"revoked"}'::jsonb,
      v_hash,
      v_receipt
    );
    return v_receipt;
  end if;
  return public.hugo_prepare_pristine_delete_authorization_unchecked(
    p_operation_id, p_email
  );
end;
$$;

revoke all on function public.hugo_prepare_pristine_delete(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hugo_prepare_pristine_delete(uuid, text)
  to service_role;

create or replace function public.hugo_delete_identity(
  p_operation_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_has_prepare boolean := false;
  v_receipt jsonb;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(
    hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
  );
  v_hash := public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      'hugo_delete_identity',
      v_email,
      null,
      '{}'::jsonb,
      'revoked',
      null
    )
  );
  if p_operation_id is not null then
    select op.request_hash, op.receipt into v_prior_hash, v_prior
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash then
        return public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash);
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, null, 'revoked', null, v_hash
      );
    end if;
  end if;

  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is not null then
    select * into v_membership
    from public.memberships m
    where m.user_id = v_user_id
      and m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid;
    select exists (
      select 1
      from public.hugo_access_operations op
      where op.operation = 'preparePristineDelete'
        and op.email = v_email
        and op.app_user_id = v_user_id
        and op.receipt->>'ok' = 'true'
    ) into v_has_prepare;

    if public.hugo_has_durable_activity(v_user_id)
       or public.hugo_has_prior_sign_in(v_user_id) then
      v_receipt := public.hugo_sandra_receipt_with_request_hash(
        public.hugo_receipt(
          p_operation_id,
          v_user_id,
          v_membership.role,
          coalesce(v_membership.hugo_config, '{}'::jsonb),
          'revoked',
          v_membership.access_expires_at,
          v_membership.role,
          coalesce(v_membership.hugo_config, '{}'::jsonb),
          coalesce(v_membership.access_status, 'missing'),
          v_membership.access_expires_at,
          true,
          false,
          'NON_PRISTINE',
          'Sandra identity has prior sign-in or durable business activity.'
        ),
        v_hash
      );
      perform public.hugo_store_access_operation(
        p_operation_id,
        'deleteIdentity',
        v_email,
        v_user_id,
        '{"status":"revoked"}'::jsonb,
        v_hash,
        v_receipt
      );
      return v_receipt;
    elsif v_membership.user_id is null and not v_has_prepare then
      v_receipt := public.hugo_sandra_receipt_with_request_hash(
        public.hugo_receipt(
          p_operation_id,
          v_user_id,
          null,
          '{}'::jsonb,
          'revoked',
          null,
          null,
          '{}'::jsonb,
          'missing',
          null,
          false,
          false,
          'PRISTINE_DELETE_REQUIRED',
          'Identity must be prepared for deletion first.'
        ),
        v_hash
      );
      perform public.hugo_store_access_operation(
        p_operation_id,
        'deleteIdentity',
        v_email,
        v_user_id,
        '{"status":"revoked"}'::jsonb,
        v_hash,
        v_receipt
      );
      return v_receipt;
    end if;
  end if;
  return public.hugo_delete_identity_authorization_unchecked(
    p_operation_id, p_email
  );
end;
$$;

revoke all on function public.hugo_delete_identity(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hugo_delete_identity(uuid, text)
  to service_role;

commit;
