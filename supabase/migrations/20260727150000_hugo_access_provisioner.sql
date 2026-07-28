-- Hugo v1: Sandra access provisioner connector.
--
-- Hugo owns desired state. Sandra owns the local Auth identity and the
-- membership that authorizes access to this application. The connector is
-- intentionally exposed as service-role-only Postgres RPCs so a browser,
-- anon key, or authenticated app session cannot mutate lifecycle state.

begin;

alter table public.memberships
  add column if not exists access_status text not null default 'active',
  add column if not exists hugo_config jsonb not null default '{}'::jsonb,
  add column if not exists access_expires_at timestamptz,
  add column if not exists deletion_prepared_at timestamptz,
  add column if not exists deletion_operation_id uuid;

alter table public.memberships
  drop constraint if exists memberships_access_status_check;
alter table public.memberships
  add constraint memberships_access_status_check
  check (access_status in ('active', 'suspended', 'revoked'));

comment on column public.memberships.access_status is
  'Hugo desired access state. Expired active rows remain active in desired state but are denied by the app gate.';
comment on column public.memberships.hugo_config is
  'Sanitized, app-local configuration owned by Hugo. Secrets never belong here.';
comment on column public.memberships.deletion_prepared_at is
  'Set only by hugo_prepare_pristine_delete after an atomic pristine + final-owner check.';

create index if not exists idx_memberships_access_status
  on public.memberships (org_id, access_status, access_expires_at);

create table if not exists public.hugo_access_operations (
  operation_id uuid primary key,
  operation text not null check (operation in ('grant', 'suspend', 'reactivate', 'revoke', 'preparePristineDelete', 'deleteIdentity')),
  email text not null,
  app_user_id uuid,
  requested jsonb not null default '{}'::jsonb,
  receipt jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.hugo_access_operations is
  'Idempotency receipts for the service-role-only Hugo/Sandra connector. Receipt fields are sanitized for audit/UI use.';

alter table public.hugo_access_operations enable row level security;
drop policy if exists hugo_access_operations_service_only on public.hugo_access_operations;
create policy hugo_access_operations_service_only
  on public.hugo_access_operations
  for all to service_role
  using (true)
  with check (true);

-- These helpers deliberately return fixed, sanitized messages. Never put an
-- Auth/provider response, secret, token, action link, or raw PII in a receipt.
create or replace function public.hugo_require_service_role()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'HUGO_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.hugo_require_service_role() from public;
revoke execute on function public.hugo_require_service_role() from anon;
revoke execute on function public.hugo_require_service_role() from authenticated;
grant execute on function public.hugo_require_service_role() to service_role;

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

revoke all on function public.hugo_find_user_id(text) from public;

create or replace function public.hugo_has_durable_activity(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.csv_imports where user_id = p_user_id)
      or exists (select 1 from public.jobs where created_by = p_user_id)
      or exists (select 1 from public.property_merges where merged_by = p_user_id)
      or exists (select 1 from public.notifications where user_id = p_user_id)
      or exists (select 1 from public.lead_notes where author_user_id = p_user_id)
      or exists (select 1 from public.lists where created_by = p_user_id)
      or exists (select 1 from public.sms_templates where created_by = p_user_id)
      or exists (select 1 from public.sequences where created_by = p_user_id)
      or exists (select 1 from public.sequence_enrollments where enrolled_by_user_id = p_user_id)
      or exists (select 1 from public.tasks where assignee_id = p_user_id or created_by = p_user_id)
      or exists (select 1 from public.saved_filters where user_id = p_user_id)
      or exists (select 1 from public.user_oauth_tokens where user_id = p_user_id)
      or exists (select 1 from public.user_integration_prefs where user_id = p_user_id);
$$;

revoke all on function public.hugo_has_durable_activity(uuid) from public;

-- Keep the final-owner rule inside the database. The Hugo RPC checks it before
-- changing a row, while this trigger also protects legacy admin actions or a
-- direct service-role DELETE that would otherwise bypass the connector.
create or replace function public.hugo_membership_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_other_owner boolean;
begin
  if old.role = 'owner'
     and (
       tg_op = 'DELETE'
       or (tg_op = 'UPDATE' and (new.role <> 'owner' or new.access_status in ('suspended', 'revoked')))
     ) then
    select exists (
      select 1 from public.memberships m
      where m.org_id = old.org_id
        and m.user_id <> old.user_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and (m.access_expires_at is null or m.access_expires_at > now())
    ) into v_other_owner;
    if not v_other_owner then
      raise exception 'FINAL_OWNER_GUARD' using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.hugo_membership_owner_guard() from public;

drop trigger if exists trg_hugo_membership_owner_guard on public.memberships;
create trigger trg_hugo_membership_owner_guard
  before update or delete on public.memberships
  for each row execute function public.hugo_membership_owner_guard();

create or replace function public.hugo_receipt(
  p_operation_id uuid,
  p_app_user_id uuid,
  p_requested_role text,
  p_requested_config jsonb,
  p_requested_status text,
  p_requested_expires_at timestamptz,
  p_observed_role text,
  p_observed_config jsonb,
  p_observed_status text,
  p_observed_expires_at timestamptz,
  p_has_durable_activity boolean,
  p_ok boolean,
  p_error_code text default null,
  p_error_message text default null
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'operation_id', p_operation_id::text,
    'app_id', 'sandra',
    'app_user_id', p_app_user_id,
    'requested', jsonb_build_object(
      'role', p_requested_role,
      'config', coalesce(p_requested_config, '{}'::jsonb),
      'status', p_requested_status,
      'access_expires_at', p_requested_expires_at
    ),
    'observed', jsonb_build_object(
      'role', p_observed_role,
      'config', coalesce(p_observed_config, '{}'::jsonb),
      'status', p_observed_status,
      'access_expires_at', p_observed_expires_at,
      'has_durable_activity', p_has_durable_activity
    ),
    'ok', p_ok,
    'error_code', p_error_code,
    'error_message', p_error_message
  );
$$;

revoke all on function public.hugo_receipt(uuid, uuid, text, jsonb, text, timestamptz, text, jsonb, text, timestamptz, boolean, boolean, text, text) from public;

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
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_prior jsonb;
  v_operation text;
  v_receipt jsonb;
  v_activity boolean;
  v_other_owner boolean;
begin
  perform public.hugo_require_service_role();

  if p_operation_id is null or v_email = '' then
    return public.hugo_receipt(p_operation_id, null, p_role, p_config, p_status, p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false, 'INVALID_REQUEST', 'A valid operation and email are required.');
  end if;
  if v_email !~ '^[^@[:space:]]+@bmhgroupkc\.com$' then
    return public.hugo_receipt(p_operation_id, null, p_role, p_config, p_status, p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false, 'INVALID_DOMAIN', 'Sandra access is limited to the BMH Group email domain.');
  end if;
  if p_role is null or p_role not in ('owner', 'member') then
    return public.hugo_receipt(p_operation_id, null, p_role, p_config, p_status, p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false, 'INVALID_ROLE', 'Sandra role must be owner or member.');
  end if;
  if p_status is null or p_status not in ('active', 'suspended', 'revoked') then
    return public.hugo_receipt(p_operation_id, null, p_role, p_config, p_status, p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false, 'INVALID_STATUS', 'Sandra access status is invalid.');
  end if;

  select operation, receipt into v_operation, v_prior
  from public.hugo_access_operations
  where operation_id = p_operation_id;
  if found then
    if v_operation not in ('grant', 'suspend', 'reactivate', 'revoke') then
      return public.hugo_receipt(p_operation_id, null, p_role, p_config, p_status, p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false, 'OPERATION_CONFLICT', 'Operation id was already used for another lifecycle action.');
    end if;
    return v_prior;
  end if;

  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is null then
    return public.hugo_receipt(p_operation_id, null, p_role, p_config, p_status, p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, false, 'IDENTITY_NOT_FOUND', 'Sandra identity was not found for this email.');
  end if;

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
  for update;

  if not found then
    if p_status <> 'active' then
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, null, '{}'::jsonb, 'missing', null, false, true);
    else
      insert into public.memberships (user_id, org_id, role, access_status, hugo_config, access_expires_at)
      values (v_user_id, '00000000-0000-0000-0000-000000000bbb'::uuid, p_role, 'active', coalesce(p_config, '{}'::jsonb), p_access_expires_at);
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, p_role, coalesce(p_config, '{}'::jsonb), 'active', p_access_expires_at, false, true);
    end if;
  else
    v_activity := public.hugo_has_durable_activity(v_user_id);
    if v_membership.deletion_prepared_at is not null then
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_activity, false, 'IDENTITY_DELETE_PREPARED', 'Identity is already prepared for deletion.');
    elsif v_membership.access_status = p_status and v_membership.role = p_role then
      -- Repeating the same lifecycle state is a successful no-op, including
      -- a suspended/revoked owner when no replacement owner exists.
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_activity, true);
    elsif v_membership.access_status = 'revoked' and p_status = 'active' then
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_activity, false, 'REVOKED_NOT_REACTIVATABLE', 'A revoked Sandra grant cannot be reactivated.');
    elsif v_membership.role = 'owner' and p_role = 'member' then
      select exists (
        select 1 from public.memberships m
        where m.org_id = v_membership.org_id
          and m.role = 'owner'
          and m.user_id <> v_user_id
          and m.access_status = 'active'
          and (m.access_expires_at is null or m.access_expires_at > now())
      ) into v_other_owner;
      if not v_other_owner then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_activity, false, 'FINAL_OWNER_GUARD', 'Sandra must retain at least one active owner.');
      else
        update public.memberships
        set role = p_role, hugo_config = coalesce(p_config, '{}'::jsonb), access_status = p_status, access_expires_at = p_access_expires_at
        where user_id = v_user_id and org_id = v_membership.org_id;
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, p_role, coalesce(p_config, '{}'::jsonb), p_status, p_access_expires_at, v_activity, true);
      end if;
    elsif v_membership.role = 'owner' and p_status in ('suspended', 'revoked') then
      select exists (
        select 1 from public.memberships m
        where m.org_id = v_membership.org_id
          and m.role = 'owner'
          and m.user_id <> v_user_id
          and m.access_status = 'active'
          and (m.access_expires_at is null or m.access_expires_at > now())
      ) into v_other_owner;
      if not v_other_owner then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_activity, false, 'FINAL_OWNER_GUARD', 'Sandra must retain at least one active owner.');
      else
        update public.memberships
        set hugo_config = coalesce(p_config, '{}'::jsonb), access_status = p_status, access_expires_at = p_access_expires_at
        where user_id = v_user_id and org_id = v_membership.org_id;
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, v_membership.role, coalesce(p_config, '{}'::jsonb), p_status, p_access_expires_at, v_activity, true);
      end if;
    else
      update public.memberships
      set role = p_role, hugo_config = coalesce(p_config, '{}'::jsonb), access_status = p_status, access_expires_at = p_access_expires_at
      where user_id = v_user_id and org_id = v_membership.org_id;
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, p_role, p_config, p_status, p_access_expires_at, p_role, coalesce(p_config, '{}'::jsonb), p_status, p_access_expires_at, v_activity, true);
    end if;
  end if;

  if (v_receipt->>'ok')::boolean then
    v_operation := case
      when p_status = 'suspended' then 'suspend'
      when p_status = 'revoked' then 'revoke'
      when v_membership.access_status = 'suspended' then 'reactivate'
      else 'grant'
    end;
    insert into public.hugo_access_operations(operation_id, operation, email, app_user_id, requested, receipt)
    values (p_operation_id, v_operation, v_email, v_user_id, jsonb_build_object('role', p_role, 'config', coalesce(p_config, '{}'::jsonb), 'status', p_status, 'access_expires_at', p_access_expires_at), v_receipt)
    on conflict (operation_id) do nothing;
  end if;
  return v_receipt;
end;
$$;

revoke execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz) from public;
revoke execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz) from anon;
revoke execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz) from authenticated;
grant execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz) to service_role;

create or replace function public.hugo_inspect_access(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_activity boolean := false;
begin
  perform public.hugo_require_service_role();
  v_user_id := public.hugo_find_user_id(lower(trim(coalesce(p_email, ''))));
  if v_user_id is null then
    return public.hugo_receipt(gen_random_uuid(), null, null, '{}'::jsonb, 'active', null, null, '{}'::jsonb, 'missing', null, false, true);
  end if;
  select * into v_membership from public.memberships
  where user_id = v_user_id and org_id = '00000000-0000-0000-0000-000000000bbb'::uuid;
  if not found then
    return public.hugo_receipt(gen_random_uuid(), v_user_id, null, '{}'::jsonb, 'active', null, null, '{}'::jsonb, 'missing', null, false, true);
  end if;
  v_activity := public.hugo_has_durable_activity(v_user_id);
  return public.hugo_receipt(gen_random_uuid(), v_user_id, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_activity, true);
end;
$$;

revoke execute on function public.hugo_inspect_access(text) from public;
revoke execute on function public.hugo_inspect_access(text) from anon;
revoke execute on function public.hugo_inspect_access(text) from authenticated;
grant execute on function public.hugo_inspect_access(text) to service_role;

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
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_prior jsonb;
  v_operation text;
  v_activity boolean;
  v_receipt jsonb;
  v_other_owner boolean;
begin
  perform public.hugo_require_service_role();
  select operation, receipt into v_operation, v_prior
  from public.hugo_access_operations
  where operation_id = p_operation_id;
  if found then
    if v_operation <> 'preparePristineDelete' then
      return public.hugo_receipt(p_operation_id, null, null, '{}'::jsonb, 'revoked', null, null, '{}'::jsonb, 'missing', null, false, false, 'OPERATION_CONFLICT', 'Operation id was already used for another lifecycle action.');
    end if;
    return v_prior;
  end if;
  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is null then
    v_receipt := public.hugo_receipt(p_operation_id, null, null, '{}'::jsonb, 'revoked', null, null, '{}'::jsonb, 'missing', null, false, true);
  else
    select * into v_membership from public.memberships
    where user_id = v_user_id and org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
    for update;
    if not found then
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, null, '{}'::jsonb, 'revoked', null, null, '{}'::jsonb, 'missing', null, false, true);
    else
      v_activity := public.hugo_has_durable_activity(v_user_id);
      select exists (
        select 1 from public.memberships m
        where m.org_id = v_membership.org_id and m.role = 'owner' and m.user_id <> v_user_id
          and m.access_status = 'active' and (m.access_expires_at is null or m.access_expires_at > now())
      ) into v_other_owner;
      if v_activity then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, true, false, 'NON_PRISTINE', 'Sandra identity has durable business activity.');
      elsif v_membership.deletion_prepared_at is not null then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, false, true);
      elsif v_membership.role = 'owner' and not v_other_owner then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, false, false, 'FINAL_OWNER_GUARD', 'Sandra must retain at least one active owner.');
      else
        update public.memberships
        set access_status = 'revoked', deletion_prepared_at = now(), deletion_operation_id = p_operation_id
        where user_id = v_user_id and org_id = v_membership.org_id;
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, false, true);
      end if;
    end if;
  end if;
  if (v_receipt->>'ok')::boolean then
    insert into public.hugo_access_operations(operation_id, operation, email, app_user_id, requested, receipt)
    values (p_operation_id, 'preparePristineDelete', v_email, v_user_id, jsonb_build_object('status', 'revoked'), v_receipt)
    on conflict (operation_id) do nothing;
  end if;
  return v_receipt;
end;
$$;

revoke execute on function public.hugo_prepare_pristine_delete(uuid, text) from public;
revoke execute on function public.hugo_prepare_pristine_delete(uuid, text) from anon;
revoke execute on function public.hugo_prepare_pristine_delete(uuid, text) from authenticated;
grant execute on function public.hugo_prepare_pristine_delete(uuid, text) to service_role;

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
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_prior jsonb;
  v_operation text;
  v_receipt jsonb;
  v_activity boolean;
begin
  perform public.hugo_require_service_role();
  select operation, receipt into v_operation, v_prior
  from public.hugo_access_operations
  where operation_id = p_operation_id;
  if found then
    if v_operation <> 'deleteIdentity' then
      return public.hugo_receipt(p_operation_id, null, null, '{}'::jsonb, 'revoked', null, null, '{}'::jsonb, 'missing', null, false, false, 'OPERATION_CONFLICT', 'Operation id was already used for another lifecycle action.');
    end if;
    return v_prior;
  end if;
  v_user_id := public.hugo_find_user_id(v_email);
  if v_user_id is null then
    v_receipt := public.hugo_receipt(p_operation_id, null, null, '{}'::jsonb, 'revoked', null, null, '{}'::jsonb, 'missing', null, false, true);
  else
    select * into v_membership from public.memberships
    where user_id = v_user_id and org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
    for update;
    if not found then
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, null, '{}'::jsonb, 'revoked', null, null, '{}'::jsonb, 'missing', null, false, true);
    elsif v_membership.deletion_prepared_at is null then
      v_activity := public.hugo_has_durable_activity(v_user_id);
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_activity, false, 'PRISTINE_DELETE_REQUIRED', 'Identity must be prepared for deletion first.');
    else
      v_activity := public.hugo_has_durable_activity(v_user_id);
      if v_activity then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, true, false, 'NON_PRISTINE', 'Sandra identity has durable business activity.');
      else
        delete from public.memberships where user_id = v_user_id and org_id = v_membership.org_id;
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, null, '{}'::jsonb, 'missing', null, false, true);
      end if;
    end if;
  end if;
  if (v_receipt->>'ok')::boolean then
    insert into public.hugo_access_operations(operation_id, operation, email, app_user_id, requested, receipt)
    values (p_operation_id, 'deleteIdentity', v_email, v_user_id, jsonb_build_object('status', 'revoked'), v_receipt)
    on conflict (operation_id) do nothing;
  end if;
  return v_receipt;
end;
$$;

revoke execute on function public.hugo_delete_identity(uuid, text) from public;
revoke execute on function public.hugo_delete_identity(uuid, text) from anon;
revoke execute on function public.hugo_delete_identity(uuid, text) from authenticated;
grant execute on function public.hugo_delete_identity(uuid, text) to service_role;

commit;
