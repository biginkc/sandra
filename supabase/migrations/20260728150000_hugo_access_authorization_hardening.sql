-- Hugo/Sandra forward-only authorization hardening.
--
-- This migration repairs already-hosted databases after the initial lifecycle
-- and request-hash migrations. It makes suspension/expiry effective at the
-- database boundary, reserves operation ids before Auth provisioning, protects
-- the final owner across expiry changes, and closes pristine-delete gaps.

begin;

-- Recreate every helper whose fresh-install definition changed after the
-- original hosted migration. Hosted projects never replay an edited migration,
-- so this file is the authoritative repair path.
create schema if not exists extensions;
do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto'
      and n.nspname <> 'extensions'
  ) then
    alter extension pgcrypto set schema extensions;
  end if;
end;
$$;

create or replace function public.hugo_request_hash(
  p_email text,
  p_requested_role text,
  p_requested_config jsonb,
  p_requested_status text,
  p_requested_expires_at timestamptz
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'email', lower(trim(coalesce(p_email, ''))),
          'role', p_requested_role,
          'config', coalesce(p_requested_config, '{}'::jsonb),
          'status', p_requested_status,
          'access_expires_at', p_requested_expires_at
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function public.hugo_request_hash(text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;

create or replace function public.hugo_config_is_safe(p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from jsonb_each(p_value) as entry(key, value)
      where entry.key not in ('cohort', 'timezone')
         or jsonb_typeof(entry.value) not in ('string', 'null')
    ),
    false
  );
$$;

create or replace function public.hugo_sandra_config_is_safe(p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.hugo_config_is_safe(p_value);
$$;

revoke all on function public.hugo_config_is_safe(jsonb)
  from public, anon, authenticated;
revoke all on function public.hugo_sandra_config_is_safe(jsonb)
  from public, anon, authenticated;

-- Keep normal connector hashing limited to values that are safe to transport.
-- Invalid raw values are hashed in the server adapter and enter the database
-- only through hugo_record_invalid_access_request as a one-way digest.
create or replace function public.hugo_sandra_canonical_request_payload(
  p_operation text,
  p_email text,
  p_requested_role text,
  p_requested_config jsonb,
  p_requested_status text,
  p_requested_expires_at jsonb
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'operation', p_operation,
    'email', lower(trim(coalesce(p_email, ''))),
    'role', p_requested_role,
    'config', case
      when public.hugo_sandra_config_is_safe(coalesce(p_requested_config, '{}'::jsonb))
        then coalesce(p_requested_config, '{}'::jsonb)
      else '{}'::jsonb
    end,
    'status', p_requested_status,
    'access_expires_at', p_requested_expires_at
  );
$$;

revoke all on function public.hugo_sandra_canonical_request_payload(
  text, text, text, jsonb, text, jsonb
) from public, anon, authenticated;

create or replace function public.hugo_find_user_id(p_email text)
returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user_ids uuid[];
begin
  if p_email is null or length(trim(p_email)) = 0 then
    return null;
  end if;
  select array_agg(id order by id) into v_user_ids
  from auth.users
  where lower(email) = lower(trim(p_email));
  if coalesce(array_length(v_user_ids, 1), 0) > 1 then
    raise exception 'HUGO_IDENTITY_AMBIGUOUS' using errcode = 'P0001';
  end if;
  return v_user_ids[1];
end;
$$;

revoke all on function public.hugo_find_user_id(text)
  from public, anon, authenticated;

create or replace function public.hugo_sandra_access_operation_hash()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb;
begin
  if tg_op = 'UPDATE'
     and current_setting('hugo.pseudonymizing', true) = '1' then
    new.request_hash := old.request_hash;
    new.receipt := public.hugo_sandra_receipt_with_request_hash(
      new.receipt, old.request_hash
    );
    return new;
  end if;

  if current_setting('hugo.preserve_request_hash', true) = '1' then
    if new.request_hash is null
       or new.request_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'HUGO_REQUEST_HASH_REQUIRED' using errcode = 'P0001';
    end if;
    new.receipt := public.hugo_sandra_receipt_with_request_hash(
      new.receipt, new.request_hash
    );
    return new;
  end if;

  v_payload := public.hugo_sandra_canonical_request_payload(
    case
      when new.operation in ('grant', 'suspend', 'reactivate', 'revoke')
        then 'hugo_apply_access'
      when new.operation = 'preparePristineDelete'
        then 'hugo_prepare_pristine_delete'
      when new.operation = 'deleteIdentity'
        then 'hugo_delete_identity'
    end,
    new.email,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke')
      then new.requested->>'role' else null end,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke')
      then new.requested->'config' else '{}'::jsonb end,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke')
      then new.requested->>'status' else 'revoked' end,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke')
      then new.requested->'access_expires_at' else null end
  );
  new.request_hash := public.hugo_sandra_request_payload_hash(v_payload);
  new.receipt := public.hugo_sandra_receipt_with_request_hash(
    new.receipt, new.request_hash
  );
  return new;
end;
$$;

revoke all on function public.hugo_sandra_access_operation_hash()
  from public, anon, authenticated, service_role;

create or replace function public.hugo_store_access_operation(
  p_operation_id uuid,
  p_operation text,
  p_email text,
  p_app_user_id uuid,
  p_requested jsonb,
  p_request_hash text,
  p_receipt jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_operation_id is null then
    return;
  end if;
  if p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'HUGO_REQUEST_HASH_REQUIRED' using errcode = 'P0001';
  end if;
  perform set_config('hugo.preserve_request_hash', '1', true);
  insert into public.hugo_access_operations(
    operation_id,
    operation,
    email,
    app_user_id,
    requested,
    request_hash,
    receipt
  ) values (
    p_operation_id,
    p_operation,
    lower(trim(coalesce(p_email, ''))),
    p_app_user_id,
    coalesce(p_requested, '{}'::jsonb),
    p_request_hash,
    public.hugo_sandra_receipt_with_request_hash(p_receipt, p_request_hash)
  )
  on conflict (operation_id) do nothing;
  perform set_config('hugo.preserve_request_hash', '0', true);
end;
$$;

revoke all on function public.hugo_store_access_operation(
  uuid, text, text, uuid, jsonb, text, jsonb
) from public, anon, authenticated, service_role;

-- Connector callers use the reviewed RPC surface. They cannot forge the
-- private raw-request-hash handoff by writing either journal table directly.
revoke all on table public.hugo_access_operations
  from public, anon, authenticated, service_role;

create or replace function public.hugo_record_invalid_access_request(
  p_operation_id uuid,
  p_request_hash text,
  p_email text,
  p_role text,
  p_config jsonb,
  p_status text,
  p_access_expires_at timestamptz,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := case when p_role in ('owner', 'member') then p_role else null end;
  v_status text := case
    when p_status in ('active', 'suspended', 'revoked') then p_status
    else null
  end;
  v_config jsonb := case
    when public.hugo_sandra_config_is_safe(coalesce(p_config, '{}'::jsonb))
      then coalesce(p_config, '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_prior_hash text;
  v_prior jsonb;
  v_message text;
  v_receipt jsonb;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(
    hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
  );
  if p_operation_id is null
     or p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'HUGO_INVALID_REQUEST_BINDING' using errcode = 'P0001';
  end if;
  if v_email <> 'redacted@invalid'
     and v_email !~ '^[^@[:space:]]+@bmhgroupkc\.com$' then
    raise exception 'HUGO_UNSAFE_INVALID_REQUEST_EMAIL' using errcode = 'P0001';
  end if;
  if p_error_code not in (
    'INVALID_EMAIL', 'INVALID_DOMAIN', 'INVALID_ROLE',
    'INVALID_STATUS', 'INVALID_CONFIG'
  ) then
    raise exception 'HUGO_INVALID_REQUEST_ERROR_CODE' using errcode = 'P0001';
  end if;

  select op.request_hash, op.receipt
    into v_prior_hash, v_prior
  from public.hugo_access_operations op
  where op.operation_id = p_operation_id;
  if found then
    if v_prior_hash = p_request_hash then
      return public.hugo_sandra_receipt_with_request_hash(
        v_prior, p_request_hash
      );
    end if;
    return public.hugo_sandra_operation_payload_conflict_receipt(
      p_operation_id, v_role, v_status,
      p_access_expires_at, p_request_hash
    );
  end if;

  v_message := case p_error_code
    when 'INVALID_EMAIL' then 'A valid email is required.'
    when 'INVALID_DOMAIN' then
      'Sandra access is limited to the BMH Group email domain.'
    when 'INVALID_ROLE' then 'Sandra role must be owner or member.'
    when 'INVALID_STATUS' then 'Sandra access status is invalid.'
    else 'Sandra access configuration is invalid.'
  end;
  v_receipt := public.hugo_sandra_receipt_with_request_hash(
    public.hugo_receipt(
      p_operation_id, null, v_role, v_config, v_status,
      p_access_expires_at, null, '{}'::jsonb, 'missing', null,
      false, false, p_error_code, v_message
    ),
    p_request_hash
  );
  perform public.hugo_store_access_operation(
    p_operation_id,
    'grant',
    v_email,
    null,
    jsonb_build_object(
      'role', v_role,
      'config', v_config,
      'status', v_status,
      'access_expires_at', p_access_expires_at
    ),
    p_request_hash,
    v_receipt
  );
  return v_receipt;
end;
$$;

revoke all on function public.hugo_record_invalid_access_request(
  uuid, text, text, text, jsonb, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.hugo_record_invalid_access_request(
  uuid, text, text, text, jsonb, text, timestamptz, text
) to service_role;

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
grant execute on function public.hugo_has_active_org_access(uuid)
  to authenticated;

create or replace function public.hugo_has_any_active_access()
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
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > now())
    );
$$;

revoke all on function public.hugo_has_any_active_access()
  from public, anon, authenticated, service_role;
grant execute on function public.hugo_has_any_active_access()
  to authenticated;

-- These policies did not resolve through memberships and therefore let an old
-- access token continue using direct PostgREST after suspension. Keep their
-- original row ownership/read-only semantics while adding the lifecycle gate.
drop policy if exists skip_trace_cache_authenticated_select
  on public.skip_trace_cache;
create policy skip_trace_cache_authenticated_select
  on public.skip_trace_cache
  for select to authenticated
  using (public.hugo_has_any_active_access());

drop policy if exists saved_filters_read_own_plus_base
  on public.saved_filters;
create policy saved_filters_read_own_plus_base
  on public.saved_filters
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and (user_id = (select auth.uid()) or is_base = true)
  );
drop policy if exists saved_filters_insert_own on public.saved_filters;
create policy saved_filters_insert_own
  on public.saved_filters
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.hugo_has_active_org_access(org_id)
  );
drop policy if exists saved_filters_update_own on public.saved_filters;
create policy saved_filters_update_own
  on public.saved_filters
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and public.hugo_has_active_org_access(org_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.hugo_has_active_org_access(org_id)
  );
drop policy if exists saved_filters_delete_own on public.saved_filters;
create policy saved_filters_delete_own
  on public.saved_filters
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.hugo_has_active_org_access(org_id)
  );

drop policy if exists user_oauth_tokens_self_read
  on public.user_oauth_tokens;
create policy user_oauth_tokens_self_read
  on public.user_oauth_tokens
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.hugo_has_any_active_access()
  );

drop policy if exists user_integration_prefs_self_all
  on public.user_integration_prefs;
create policy user_integration_prefs_self_all
  on public.user_integration_prefs
  for all to authenticated
  using (
    user_id = (select auth.uid())
    and public.hugo_has_any_active_access()
  )
  with check (
    user_id = (select auth.uid())
    and public.hugo_has_any_active_access()
  );

drop policy if exists "authenticated users can read metric snapshots"
  on public.metric_snapshots;
create policy "authenticated users can read metric snapshots"
  on public.metric_snapshots
  for select to authenticated
  using (public.hugo_has_any_active_access());

drop policy if exists counties_authenticated_select on public.counties;
create policy counties_authenticated_select on public.counties
  for select to authenticated
  using (public.hugo_has_any_active_access());

drop policy if exists fips_codes_authenticated_select on public.fips_codes;
create policy fips_codes_authenticated_select on public.fips_codes
  for select to authenticated
  using (public.hugo_has_any_active_access());

drop policy if exists zip_county_xref_authenticated_select
  on public.zip_county_xref;
create policy zip_county_xref_authenticated_select
  on public.zip_county_xref
  for select to authenticated
  using (public.hugo_has_any_active_access());

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

-- Every organization must always have an active owner that never expires.
-- The durable guard row turns concurrent owner mutations into a write/write
-- conflict as well as an advisory-lock conflict. Under REPEATABLE READ or
-- SERIALIZABLE, a waiter with an older snapshot aborts instead of admitting a
-- stale final-owner decision.
create table if not exists public.hugo_owner_guard_serialization (
  guard_key text primary key,
  version bigint not null default 0
);

insert into public.hugo_owner_guard_serialization(guard_key)
values ('memberships')
on conflict (guard_key) do nothing;

alter table public.hugo_owner_guard_serialization enable row level security;
revoke all on table public.hugo_owner_guard_serialization
  from public, anon, authenticated, service_role;

create or replace function public.hugo_membership_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_old_id uuid;
  v_new_is_permanent_owner boolean;
  v_has_permanent_owner boolean;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('hugo-sandra-permanent-owner-v2', 0)
  );
  update public.hugo_owner_guard_serialization
  set version = version + 1
  where guard_key = 'memberships';

  if tg_op = 'UPDATE' and old.org_id is distinct from new.org_id then
    raise exception 'MEMBERSHIP_ORG_IMMUTABLE' using errcode = 'P0001';
  end if;

  v_org_id := case when tg_op = 'INSERT' then new.org_id else old.org_id end;
  v_old_id := case when tg_op = 'INSERT' then null else old.id end;
  v_new_is_permanent_owner :=
    tg_op <> 'DELETE'
    and new.org_id = v_org_id
    and new.role = 'owner'
    and new.access_status = 'active'
    and new.deletion_prepared_at is null
    and new.access_expires_at is null;

  select exists (
    select 1
    from public.memberships m
    where m.org_id = v_org_id
      and (v_old_id is null or m.id <> v_old_id)
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and m.access_expires_at is null
  ) or v_new_is_permanent_owner
  into v_has_permanent_owner;

  if not v_has_permanent_owner then
    raise exception 'FINAL_OWNER_GUARD' using errcode = 'P0001';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.hugo_membership_owner_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_hugo_membership_owner_guard
  on public.memberships;
create trigger trg_hugo_membership_owner_guard
  before insert or update or delete on public.memberships
  for each row execute function public.hugo_membership_owner_guard();

do $$
begin
  if exists (
    select 1
    from public.memberships any_membership
    group by any_membership.org_id
    having not bool_or(
      any_membership.role = 'owner'
      and any_membership.access_status = 'active'
      and any_membership.deletion_prepared_at is null
      and any_membership.access_expires_at is null
    )
  ) then
    raise exception 'HUGO_PERMANENT_OWNER_REQUIRED' using errcode = 'P0001';
  end if;
end;
$$;

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

revoke all on table public.hugo_access_operation_claims
  from public, anon, authenticated, service_role;

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
  v_safe_role text := case
    when p_role in ('owner', 'member') then p_role
    else null
  end;
  v_safe_status text := case
    when p_status in ('active', 'suspended', 'revoked') then p_status
    else null
  end;
  v_storage_email text := case
    when lower(trim(coalesce(p_email, '')))
      ~ '^[^@[:space:]]+@bmhgroupkc\.com$'
      then lower(trim(p_email))
    else 'redacted@invalid'
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
          p_operation_id, v_safe_role, v_safe_status,
          p_access_expires_at, v_hash
        )
      );
    end if;
  end if;

  if p_operation_id is null then
    v_error_code := 'INVALID_REQUEST';
    v_error_message := 'A valid operation is required.';
  elsif v_email = ''
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    v_error_code := 'INVALID_EMAIL';
    v_error_message := 'A valid email is required.';
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
        p_operation_id, null, v_safe_role, v_config, v_safe_status,
        p_access_expires_at, null, '{}'::jsonb, 'missing', null,
        false, false, v_error_code, v_error_message
      ),
      v_hash
    );
    if p_operation_id is not null then
      perform public.hugo_store_access_operation(
        p_operation_id,
        'grant',
        v_storage_email,
        null,
        jsonb_build_object(
          'role', v_safe_role,
          'config', v_config,
          'status', v_safe_status,
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
        p_operation_id, v_safe_role, v_safe_status,
        p_access_expires_at, v_hash
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

-- Replace the hosted wrapper with the complete current implementation.
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
  v_prior_hash text;
  v_prior_operation text;
  v_prior_receipt jsonb;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_had_membership boolean := false;
  v_other_owner boolean;
  v_activity boolean := false;
  v_receipt jsonb;
  v_operation text;
  v_requested jsonb;
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
  v_requested := jsonb_build_object(
    'role', p_role,
    'config', v_config,
    'status', p_status,
    'access_expires_at', p_access_expires_at
  );

  -- A stored receipt is authoritative for an exact retry. Check it before
  -- identity lookup, final-owner checks, or any other current-state guard.
  if p_operation_id is not null then
    select op.operation, op.request_hash, op.receipt
      into v_prior_operation, v_prior_hash, v_prior_receipt
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash
         and v_prior_operation in ('grant', 'suspend', 'reactivate', 'revoke') then
        return public.hugo_sandra_receipt_with_request_hash(
          v_prior_receipt, v_hash
        );
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, p_role, p_status, p_access_expires_at, v_hash
      );
    end if;
  end if;

  if p_operation_id is not null then
    select claim.request_hash into v_claim_hash
    from public.hugo_access_operation_claims claim
    where claim.operation_id = p_operation_id;
    if not found then
      return public.hugo_sandra_receipt_with_request_hash(
        public.hugo_receipt(
          p_operation_id, null, p_role, v_config, p_status,
          p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false,
          'OPERATION_PREFLIGHT_REQUIRED',
          'The access operation must be reserved before it is applied.'
        ),
        v_hash
      );
    elsif v_claim_hash <> v_hash then
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, p_role, p_status, p_access_expires_at, v_hash
      );
    end if;
  end if;

  if p_operation_id is null or v_email = '' then
    v_receipt := public.hugo_receipt(
      p_operation_id, null, p_role, v_config, p_status, p_access_expires_at,
      null, '{}'::jsonb, 'missing', null, false, false,
      'INVALID_REQUEST', 'A valid operation and email are required.'
    );
  elsif v_email !~ '^[^@[:space:]]+@bmhgroupkc\.com$' then
    v_receipt := public.hugo_receipt(
      p_operation_id, null, p_role, v_config, p_status, p_access_expires_at,
      null, '{}'::jsonb, 'missing', null, false, false,
      'INVALID_DOMAIN',
      'Sandra access is limited to the BMH Group email domain.'
    );
  elsif p_role is null or p_role not in ('owner', 'member') then
    v_receipt := public.hugo_receipt(
      p_operation_id, null, p_role, v_config, p_status, p_access_expires_at,
      null, '{}'::jsonb, 'missing', null, false, false,
      'INVALID_ROLE', 'Sandra role must be owner or member.'
    );
  elsif p_status is null or p_status not in ('active', 'suspended', 'revoked') then
    v_receipt := public.hugo_receipt(
      p_operation_id, null, p_role, v_config, p_status, p_access_expires_at,
      null, '{}'::jsonb, 'missing', null, false, false,
      'INVALID_STATUS', 'Sandra access status is invalid.'
    );
  elsif not public.hugo_sandra_config_is_safe(
    coalesce(p_config, '{}'::jsonb)
  ) then
    v_receipt := public.hugo_receipt(
      p_operation_id, null, p_role, '{}'::jsonb, p_status,
      p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false,
      'INVALID_CONFIG', 'Sandra access configuration is invalid.'
    );
  end if;

  if v_receipt is not null then
    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      v_receipt, v_hash
    );
    perform public.hugo_store_access_operation(
      p_operation_id, 'grant', v_email, null, v_requested, v_hash, v_receipt
    );
    update public.hugo_access_operation_claims
    set consumed_at = now()
    where operation_id = p_operation_id and request_hash = v_hash;
    return v_receipt;
  end if;

  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is null then
    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id, null, p_role, v_config, p_status,
        p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false,
        'IDENTITY_NOT_FOUND',
        'Sandra identity was not found for this email.'
      ),
      v_hash
    );
    perform public.hugo_store_access_operation(
      p_operation_id, 'grant', v_email, null, v_requested, v_hash, v_receipt
    );
    update public.hugo_access_operation_claims
    set consumed_at = now()
    where operation_id = p_operation_id and request_hash = v_hash;
    return v_receipt;
  end if;

  select * into v_membership
  from public.memberships m
  where m.user_id = v_user_id
    and m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
  for update;
  v_had_membership := found;
  if v_had_membership then
    v_activity := public.hugo_has_durable_activity(v_user_id);
  end if;

  if v_had_membership
     and v_membership.role = 'owner'
     and v_membership.access_status = 'active'
     and v_membership.deletion_prepared_at is null
     and v_membership.access_expires_at is null
     and not (
       p_role = 'owner'
       and p_status = 'active'
       and p_access_expires_at is null
     ) then
    select exists (
      select 1
      from public.memberships m
      where m.org_id = v_membership.org_id
        and m.user_id <> v_user_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and m.access_expires_at is null
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
          v_activity,
          false,
          'FINAL_OWNER_GUARD',
          'Sandra must retain at least one active non-expiring owner.'
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

  if not v_had_membership then
    if p_status <> 'active' then
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id, p_role, v_config, p_status,
        p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, true
      );
    else
      insert into public.memberships(
        user_id, org_id, role, access_status, hugo_config, access_expires_at
      ) values (
        v_user_id,
        '00000000-0000-0000-0000-000000000bbb'::uuid,
        p_role,
        'active',
        v_config,
        p_access_expires_at
      );
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id, p_role, v_config, p_status,
        p_access_expires_at, p_role, v_config, 'active',
        p_access_expires_at, false, true
      );
    end if;
  elsif v_membership.deletion_prepared_at is not null then
    v_receipt := public.hugo_receipt(
      p_operation_id, v_user_id, p_role, v_config, p_status,
      p_access_expires_at, v_membership.role, v_membership.hugo_config,
      v_membership.access_status, v_membership.access_expires_at, v_activity,
      false, 'IDENTITY_DELETE_PREPARED',
      'Identity is already prepared for deletion.'
    );
  elsif v_membership.access_status = p_status
    and v_membership.role = p_role
    and v_membership.hugo_config = v_config
    and v_membership.access_expires_at is not distinct from p_access_expires_at
  then
    v_receipt := public.hugo_receipt(
      p_operation_id, v_user_id, p_role, v_config, p_status,
      p_access_expires_at, v_membership.role, v_membership.hugo_config,
      v_membership.access_status, v_membership.access_expires_at, v_activity,
      true
    );
  elsif v_membership.access_status = 'revoked' and p_status = 'active' then
    v_receipt := public.hugo_receipt(
      p_operation_id, v_user_id, p_role, v_config, p_status,
      p_access_expires_at, v_membership.role, v_membership.hugo_config,
      'revoked', v_membership.access_expires_at, v_activity, false,
      'REVOKED_NOT_REACTIVATABLE',
      'A revoked Sandra grant cannot be reactivated.'
    );
  else
    update public.memberships
    set role = p_role,
        hugo_config = v_config,
        access_status = p_status,
        access_expires_at = p_access_expires_at
    where user_id = v_user_id
      and org_id = v_membership.org_id;
    v_receipt := public.hugo_receipt(
      p_operation_id, v_user_id, p_role, v_config, p_status,
      p_access_expires_at, p_role, v_config, p_status,
      p_access_expires_at, v_activity, true
    );
  end if;

  v_operation := case
    when p_status = 'suspended' then 'suspend'
    when p_status = 'revoked' then 'revoke'
    when v_had_membership
      and v_membership.access_status = 'suspended'
      and p_status = 'active' then 'reactivate'
    else 'grant'
  end;
  v_receipt := public.hugo_sandra_receipt_with_request_hash(
    v_receipt, v_hash
  );
  perform public.hugo_store_access_operation(
    p_operation_id, v_operation, v_email, v_user_id, v_requested, v_hash,
    v_receipt
  );
  update public.hugo_access_operation_claims
  set consumed_at = now()
  where operation_id = p_operation_id and request_hash = v_hash;
  return v_receipt;
end;
$$;

revoke all on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
  to service_role;

-- Auth provisioning happens outside Postgres. Persist its sanitized terminal
-- failure against the preflight claim so an exact retry is stable and a changed
-- retry conflicts before another Auth lookup/create attempt.
create or replace function public.hugo_record_identity_provision_failure(
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
  v_prior_hash text;
  v_prior_operation text;
  v_prior_receipt jsonb;
  v_user_id uuid;
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
    select op.operation, op.request_hash, op.receipt
      into v_prior_operation, v_prior_hash, v_prior_receipt
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash
         and v_prior_operation in ('grant', 'reactivate') then
        return public.hugo_sandra_receipt_with_request_hash(
          v_prior_receipt, v_hash
        );
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, p_role, p_status, p_access_expires_at, v_hash
      );
    end if;
  end if;

  select claim.request_hash into v_claim_hash
  from public.hugo_access_operation_claims claim
  where claim.operation_id = p_operation_id;
  if not found or v_claim_hash <> v_hash then
    return public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id, null, p_role, v_config, p_status,
        p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false,
        case when v_claim_hash is null
          then 'OPERATION_PREFLIGHT_REQUIRED'
          else 'OPERATION_CONFLICT'
        end,
        case when v_claim_hash is null
          then 'The access operation must be reserved before Auth provisioning.'
          else 'Operation id was already used with a different request.'
        end
      ),
      v_hash
    );
  end if;

  -- Auth creation can commit even when its API response or the adapter's
  -- immediate re-read is lost. Reconcile a unique identity inside the same
  -- database authority boundary before terminalizing the claim.
  begin
    v_user_id := public.hugo_find_user_id(v_email);
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'HUGO_IDENTITY_AMBIGUOUS' then
        raise;
      end if;
      v_user_id := null;
  end;
  if v_user_id is not null then
    return public.hugo_apply_access(
      p_operation_id,
      v_email,
      p_role,
      v_config,
      p_status,
      p_access_expires_at
    );
  end if;

  v_receipt := public.hugo_sandra_receipt_with_request_hash(
    public.hugo_receipt(
      p_operation_id, null, p_role, v_config, p_status, p_access_expires_at,
      null, '{}'::jsonb, 'missing', null, false, false,
      'IDENTITY_PROVISION_FAILED',
      'Sandra identity could not be provisioned.'
    ),
    v_hash
  );
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
  update public.hugo_access_operation_claims
  set consumed_at = now()
  where operation_id = p_operation_id and request_hash = v_hash;
  return v_receipt;
end;
$$;

revoke all on function public.hugo_record_identity_provision_failure(
  uuid, text, text, jsonb, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.hugo_record_identity_provision_failure(
  uuid, text, text, jsonb, text, timestamptz
) to service_role;

-- Replace both hosted delete wrappers with complete current implementations.
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
  v_prior_operation text;
  v_prior jsonb;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_has_membership boolean := false;
  v_activity boolean := false;
  v_other_owner boolean := false;
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
    select op.operation, op.request_hash, op.receipt
      into v_prior_operation, v_prior_hash, v_prior
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash
         and v_prior_operation = 'preparePristineDelete' then
        return public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash);
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, null, 'revoked', null, v_hash
      );
    end if;
  end if;

  if p_operation_id is null or v_email = '' then
    return public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id, null, null, '{}'::jsonb, 'revoked', null,
        null, '{}'::jsonb, 'missing', null, false, false,
        'INVALID_REQUEST', 'A valid operation and email are required.'
      ),
      v_hash
    );
  elsif v_email !~ '^[^@[:space:]]+@bmhgroupkc\.com$' then
    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id, null, null, '{}'::jsonb, 'revoked', null,
        null, '{}'::jsonb, 'missing', null, false, false,
        'INVALID_DOMAIN',
        'Sandra access is limited to the BMH Group email domain.'
      ),
      v_hash
    );
    perform public.hugo_store_access_operation(
      p_operation_id, 'preparePristineDelete', v_email, null,
      '{"status":"revoked"}'::jsonb, v_hash, v_receipt
    );
    return v_receipt;
  end if;

  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is null then
    v_receipt := public.hugo_receipt(
      p_operation_id, null, null, '{}'::jsonb, 'revoked', null,
      null, '{}'::jsonb, 'missing', null, false, true
    );
  else
    select * into v_membership
    from public.memberships m
    where m.user_id = v_user_id
      and m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
    for update;
    v_has_membership := found;
    v_activity := public.hugo_has_durable_activity(v_user_id)
      or public.hugo_has_prior_sign_in(v_user_id);

    if not v_has_membership then
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id, null, '{}'::jsonb, 'revoked', null,
        null, '{}'::jsonb, 'missing', null, false, true
      );
    elsif v_activity then
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id, v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb), 'revoked',
        v_membership.access_expires_at, v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb),
        v_membership.access_status, v_membership.access_expires_at, true,
        false, 'NON_PRISTINE',
        'Sandra identity has prior sign-in or durable business activity.'
      );
    elsif v_membership.deletion_prepared_at is not null then
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id, v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb), 'revoked',
        v_membership.access_expires_at, v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb), 'revoked',
        v_membership.access_expires_at, false, true
      );
    else
      if v_membership.role = 'owner'
         and v_membership.access_status = 'active'
         and v_membership.deletion_prepared_at is null
         and v_membership.access_expires_at is null then
        select exists (
          select 1
          from public.memberships m
          where m.org_id = v_membership.org_id
            and m.user_id <> v_user_id
            and m.role = 'owner'
            and m.access_status = 'active'
            and m.deletion_prepared_at is null
            and m.access_expires_at is null
        ) into v_other_owner;
      else
        v_other_owner := true;
      end if;

      if not v_other_owner then
        v_receipt := public.hugo_receipt(
          p_operation_id, v_user_id, v_membership.role,
          coalesce(v_membership.hugo_config, '{}'::jsonb), 'revoked',
          v_membership.access_expires_at, v_membership.role,
          coalesce(v_membership.hugo_config, '{}'::jsonb),
          v_membership.access_status, v_membership.access_expires_at, false,
          false, 'FINAL_OWNER_GUARD',
          'Sandra must retain at least one active non-expiring owner.'
        );
      else
        update public.memberships
        set access_status = 'revoked',
            deletion_prepared_at = now(),
            deletion_operation_id = p_operation_id
        where user_id = v_user_id
          and org_id = v_membership.org_id;
        v_receipt := public.hugo_receipt(
          p_operation_id, v_user_id, v_membership.role,
          coalesce(v_membership.hugo_config, '{}'::jsonb), 'revoked',
          v_membership.access_expires_at, v_membership.role,
          coalesce(v_membership.hugo_config, '{}'::jsonb), 'revoked',
          v_membership.access_expires_at, false, true
        );
      end if;
    end if;
  end if;

  v_receipt := public.hugo_sandra_receipt_with_request_hash(v_receipt, v_hash);
  perform public.hugo_store_access_operation(
    p_operation_id, 'preparePristineDelete', v_email, v_user_id,
    '{"status":"revoked"}'::jsonb, v_hash, v_receipt
  );
  return v_receipt;
end;
$$;

revoke all on function public.hugo_prepare_pristine_delete(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hugo_prepare_pristine_delete(uuid, text)
  to service_role;

create or replace function public.hugo_pseudonymize_deleted_identity(
  p_email text,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_pseudonym_id uuid := gen_random_uuid();
  v_pseudonym_email text :=
    'deleted+' || replace(gen_random_uuid()::text, '-', '') ||
    '@redacted.invalid';
  v_original_id text := coalesce(p_user_id::text, '__no_auth_user__');
begin
  perform set_config('hugo.pseudonymizing', '1', true);
  update public.hugo_access_operations op
  set email = v_pseudonym_email,
      app_user_id = v_pseudonym_id,
      requested = replace(
        replace(op.requested::text, v_email, v_pseudonym_email),
        v_original_id,
        v_pseudonym_id::text
      )::jsonb,
      receipt = jsonb_set(
        replace(
          replace(op.receipt::text, v_email, v_pseudonym_email),
          v_original_id,
          v_pseudonym_id::text
        )::jsonb,
        '{app_user_id}',
        to_jsonb(v_pseudonym_id),
        true
      )
  where lower(op.email) = v_email
     or (
       p_user_id is not null
       and (
         op.app_user_id = p_user_id
         or position(p_user_id::text in op.requested::text) > 0
         or position(p_user_id::text in op.receipt::text) > 0
       )
     )
     or position(v_email in op.requested::text) > 0
     or position(v_email in op.receipt::text) > 0;

  update public.hugo_access_operation_claims claim
  set email = v_pseudonym_email,
      requested = replace(
        replace(claim.requested::text, v_email, v_pseudonym_email),
        v_original_id,
        v_pseudonym_id::text
      )::jsonb
  where lower(claim.email) = v_email
     or position(v_email in claim.requested::text) > 0
     or (
       p_user_id is not null
       and position(p_user_id::text in claim.requested::text) > 0
     );

  if exists (
    select 1
    from public.hugo_access_operations op
    where lower(op.email) = v_email
       or (
         p_user_id is not null
         and (
           op.app_user_id = p_user_id
           or position(p_user_id::text in op.requested::text) > 0
           or position(p_user_id::text in op.receipt::text) > 0
         )
       )
       or position(v_email in op.requested::text) > 0
       or position(v_email in op.receipt::text) > 0
  ) or exists (
    select 1
    from public.hugo_access_operation_claims claim
    where lower(claim.email) = v_email
       or position(v_email in claim.requested::text) > 0
       or (
         p_user_id is not null
         and position(p_user_id::text in claim.requested::text) > 0
       )
  ) then
    raise exception 'HUGO_IDENTITY_PSEUDONYMIZATION_FAILED'
      using errcode = 'P0001';
  end if;
  perform set_config('hugo.pseudonymizing', '0', true);
end;
$$;

revoke all on function public.hugo_pseudonymize_deleted_identity(text, uuid)
  from public, anon, authenticated, service_role;

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
  v_prior_operation text;
  v_prior jsonb;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_has_membership boolean := false;
  v_has_prepare boolean := false;
  v_activity boolean := false;
  v_should_delete_auth boolean := false;
  v_deleted_count integer := 0;
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
    select op.operation, op.request_hash, op.receipt
      into v_prior_operation, v_prior_hash, v_prior
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash and v_prior_operation = 'deleteIdentity' then
        return public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash);
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, null, 'revoked', null, v_hash
      );
    end if;
  end if;

  if p_operation_id is null or v_email = '' then
    return public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id, null, null, '{}'::jsonb, 'revoked', null,
        null, '{}'::jsonb, 'missing', null, false, false,
        'INVALID_REQUEST', 'A valid operation and email are required.'
      ),
      v_hash
    );
  elsif v_email !~ '^[^@[:space:]]+@bmhgroupkc\.com$' then
    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id, null, null, '{}'::jsonb, 'revoked', null,
        null, '{}'::jsonb, 'missing', null, false, false,
        'INVALID_DOMAIN',
        'Sandra access is limited to the BMH Group email domain.'
      ),
      v_hash
    );
    perform public.hugo_store_access_operation(
      p_operation_id, 'deleteIdentity', v_email, null,
      '{"status":"revoked"}'::jsonb, v_hash, v_receipt
    );
    return v_receipt;
  end if;

  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is null then
    v_receipt := public.hugo_receipt(
      p_operation_id, null, null, '{}'::jsonb, 'revoked', null,
      null, '{}'::jsonb, 'missing', null, false, true
    );
  else
    -- A referencing insert takes a KEY SHARE lock on auth.users. Lock the Auth
    -- identity first so every in-flight durable reference either commits before
    -- the final pristine check or fails after this deletion commits.
    perform 1
    from auth.users u
    where u.id = v_user_id
    for update;

    select * into v_membership
    from public.memberships m
    where m.user_id = v_user_id
      and m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
    for update;
    v_has_membership := found;
    select exists (
      select 1
      from public.hugo_access_operations op
      where op.operation = 'preparePristineDelete'
        and op.email = v_email
        and op.app_user_id = v_user_id
        and op.receipt->>'ok' = 'true'
    ) into v_has_prepare;

    v_activity := public.hugo_has_durable_activity(v_user_id)
      or public.hugo_has_prior_sign_in(v_user_id);
    if v_activity then
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id,
        case when v_has_membership then v_membership.role else null end,
        case when v_has_membership
          then coalesce(v_membership.hugo_config, '{}'::jsonb)
          else '{}'::jsonb
        end,
        'revoked',
        case when v_has_membership
          then v_membership.access_expires_at
          else null
        end,
        case when v_has_membership then v_membership.role else null end,
        case when v_has_membership
          then coalesce(v_membership.hugo_config, '{}'::jsonb)
          else '{}'::jsonb
        end,
        case when v_has_membership
          then v_membership.access_status
          else 'missing'
        end,
        case when v_has_membership
          then v_membership.access_expires_at
          else null
        end,
        true, false, 'NON_PRISTINE',
        'Sandra identity has prior sign-in or durable business activity.'
      );
    elsif not v_has_membership and not v_has_prepare then
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id, null, '{}'::jsonb, 'revoked', null,
        null, '{}'::jsonb, 'missing', null, false, false,
        'PRISTINE_DELETE_REQUIRED',
        'Identity must be prepared for deletion first.'
      );
    elsif v_has_membership
      and v_membership.deletion_prepared_at is null then
      v_receipt := public.hugo_receipt(
        p_operation_id, v_user_id, v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb), 'revoked',
        v_membership.access_expires_at, v_membership.role,
        coalesce(v_membership.hugo_config, '{}'::jsonb),
        v_membership.access_status, v_membership.access_expires_at, false,
        false, 'PRISTINE_DELETE_REQUIRED',
        'Identity must be prepared for deletion first.'
      );
    else
      if v_has_membership then
        delete from public.memberships
        where user_id = v_user_id and org_id = v_membership.org_id;
      end if;
      v_should_delete_auth := true;
    end if;
  end if;

  if v_should_delete_auth then
    begin
      delete from auth.users where id = v_user_id;
      get diagnostics v_deleted_count = row_count;
    exception when others then
      raise exception 'HUGO_AUTH_DELETE_FAILED' using errcode = 'P0001';
    end;
    if v_deleted_count not in (0, 1) then
      raise exception 'HUGO_AUTH_DELETE_FAILED' using errcode = 'P0001';
    end if;
    v_receipt := public.hugo_receipt(
      p_operation_id, v_user_id,
      case when v_has_membership then v_membership.role else null end,
      case when v_has_membership
        then coalesce(v_membership.hugo_config, '{}'::jsonb)
        else '{}'::jsonb
      end,
      'revoked',
      case when v_has_membership
        then v_membership.access_expires_at
        else null
      end,
      null, '{}'::jsonb, 'missing', null, false, true
    );
  end if;

  v_receipt := public.hugo_sandra_receipt_with_request_hash(
    v_receipt, v_hash
  );
  perform public.hugo_store_access_operation(
    p_operation_id, 'deleteIdentity', v_email, v_user_id,
    '{"status":"revoked"}'::jsonb, v_hash, v_receipt
  );

  if (v_receipt->>'ok')::boolean then
    perform public.hugo_pseudonymize_deleted_identity(v_email, v_user_id);
    select op.receipt into v_receipt
    from public.hugo_access_operations op
    where op.operation_id = p_operation_id;
  end if;

  return public.hugo_sandra_receipt_with_request_hash(v_receipt, v_hash);
end;
$$;

revoke all on function public.hugo_delete_identity(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hugo_delete_identity(uuid, text)
  to service_role;

create or replace function public.hugo_list_access()
returns table (
  email text,
  app_user_id uuid,
  role text,
  config jsonb,
  status text,
  access_expires_at timestamptz,
  has_durable_activity boolean
)
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  perform public.hugo_require_service_role();
  return query
    select lower(trim(coalesce(u.email, ''))),
           m.user_id,
           m.role,
           case
             when public.hugo_config_is_safe(
               coalesce(m.hugo_config, '{}'::jsonb)
             )
               then coalesce(m.hugo_config, '{}'::jsonb)
             else '{}'::jsonb
           end,
           m.access_status,
           m.access_expires_at,
           public.hugo_has_durable_activity(m.user_id)
             or public.hugo_has_prior_sign_in(m.user_id)
      from public.memberships as m
      join auth.users as u on u.id = m.user_id
     where m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
     order by lower(trim(coalesce(u.email, ''))), m.user_id;
end;
$$;

revoke all on function public.hugo_list_access()
  from public, anon, authenticated;
grant execute on function public.hugo_list_access() to service_role;

commit;
