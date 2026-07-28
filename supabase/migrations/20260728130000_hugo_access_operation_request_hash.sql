-- Hugo/Sandra forward-only idempotency hardening.
--
-- 20260727150000_hugo_access_provisioner.sql is already present in hosted
-- environments. Keep this migration additive: it binds the existing table and
-- RPCs without requiring that an earlier migration be replayed.

begin;

alter table public.hugo_access_operations
  add column if not exists request_hash text;

comment on column public.hugo_access_operations.request_hash is
  'SHA-256 of the canonical, sanitized Hugo/Sandra request payload. It rejects operation-id reuse with different inputs.';

create or replace function public.hugo_sandra_config_is_safe(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_pair record;
  v_child jsonb;
begin
  if p_value is null then
    return true;
  end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_pair in select * from jsonb_each(p_value) loop
      if v_pair.key ~* '(secret|token|password|passwd|private[_-]?key|access[_-]?key|authorization|cookie)' then
        return false;
      end if;
      if not public.hugo_sandra_config_is_safe(v_pair.value) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      if not public.hugo_sandra_config_is_safe(v_child) then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

revoke all on function public.hugo_sandra_config_is_safe(jsonb) from public, anon, authenticated;

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

revoke all on function public.hugo_sandra_canonical_request_payload(text, text, text, jsonb, text, jsonb)
  from public, anon, authenticated;

create or replace function public.hugo_sandra_request_payload_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    extensions.digest(convert_to(coalesce(p_payload, '{}'::jsonb)::text, 'UTF8'), 'sha256'),
    'hex'
  );
$$;

revoke all on function public.hugo_sandra_request_payload_hash(jsonb) from public, anon, authenticated;

-- Recompute all existing rows so this forward migration also normalizes rows
-- created by an earlier connector implementation. The receipt gets the same
-- binding and never receives the original request payload or any secret.
update public.hugo_access_operations
set request_hash = public.hugo_sandra_request_payload_hash(
  public.hugo_sandra_canonical_request_payload(
    case
      when operation in ('grant', 'suspend', 'reactivate', 'revoke') then 'hugo_apply_access'
      when operation = 'preparePristineDelete' then 'hugo_prepare_pristine_delete'
      when operation = 'deleteIdentity' then 'hugo_delete_identity'
    end,
    email,
    case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->>'role' else null end,
    case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->'config' else '{}'::jsonb end,
    case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->>'status' else 'revoked' end,
    case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->'access_expires_at' else null end
  )
),
receipt = jsonb_set(
  receipt,
  '{request_hash}',
  to_jsonb(public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      case
        when operation in ('grant', 'suspend', 'reactivate', 'revoke') then 'hugo_apply_access'
        when operation = 'preparePristineDelete' then 'hugo_prepare_pristine_delete'
        when operation = 'deleteIdentity' then 'hugo_delete_identity'
      end,
      email,
      case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->>'role' else null end,
      case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->'config' else '{}'::jsonb end,
      case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->>'status' else 'revoked' end,
      case when operation in ('grant', 'suspend', 'reactivate', 'revoke') then requested->'access_expires_at' else null end
    )
  )),
  true
);

alter table public.hugo_access_operations
  drop constraint if exists hugo_access_operations_request_hash_check;
alter table public.hugo_access_operations
  drop constraint if exists hugo_access_operations_sandra_request_hash_check;
alter table public.hugo_access_operations
  add constraint hugo_access_operations_sandra_request_hash_check
  check (request_hash ~ '^[0-9a-f]{64}$');
alter table public.hugo_access_operations
  alter column request_hash set not null;

create or replace function public.hugo_sandra_receipt_with_request_hash(
  p_receipt jsonb,
  p_request_hash text
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_set(coalesce(p_receipt, '{}'::jsonb), '{request_hash}', to_jsonb(p_request_hash), true);
$$;

revoke all on function public.hugo_sandra_receipt_with_request_hash(jsonb, text)
  from public, anon, authenticated;

create or replace function public.hugo_sandra_operation_payload_conflict_receipt(
  p_operation_id uuid,
  p_requested_role text,
  p_requested_status text,
  p_requested_expires_at timestamptz,
  p_request_hash text
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.hugo_sandra_receipt_with_request_hash(
    public.hugo_receipt(
      p_operation_id,
      null,
      p_requested_role,
      '{}'::jsonb,
      p_requested_status,
      p_requested_expires_at,
      null,
      '{}'::jsonb,
      'missing',
      null,
      false,
      false,
      'OPERATION_CONFLICT',
      'Operation id was already used with a different request.'
    ),
    p_request_hash
  );
$$;

revoke all on function public.hugo_sandra_operation_payload_conflict_receipt(uuid, text, text, timestamptz, text)
  from public, anon, authenticated;

-- Keep the stored hash authoritative even when a legacy implementation or a
-- service-role repair writes directly to hugo_access_operations.
create or replace function public.hugo_sandra_access_operation_hash()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb;
begin
  v_payload := public.hugo_sandra_canonical_request_payload(
    case
      when new.operation in ('grant', 'suspend', 'reactivate', 'revoke') then 'hugo_apply_access'
      when new.operation = 'preparePristineDelete' then 'hugo_prepare_pristine_delete'
      when new.operation = 'deleteIdentity' then 'hugo_delete_identity'
    end,
    new.email,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke') then new.requested->>'role' else null end,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke') then new.requested->'config' else '{}'::jsonb end,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke') then new.requested->>'status' else 'revoked' end,
    case when new.operation in ('grant', 'suspend', 'reactivate', 'revoke') then new.requested->'access_expires_at' else null end
  );
  new.request_hash := public.hugo_sandra_request_payload_hash(v_payload);
  new.receipt := public.hugo_sandra_receipt_with_request_hash(new.receipt, new.request_hash);
  return new;
end;
$$;

revoke all on function public.hugo_sandra_access_operation_hash() from public, anon, authenticated;
drop trigger if exists trg_hugo_sandra_access_operation_hash on public.hugo_access_operations;
create trigger trg_hugo_sandra_access_operation_hash
before insert or update of operation, email, requested on public.hugo_access_operations
for each row execute function public.hugo_sandra_access_operation_hash();

-- The old functions are retained as private implementation details. The DO
-- guards make this safe when a branch already contains an in-progress wrapper
-- while hosted production still has only the original function names.
do $$
begin
  if to_regprocedure('public.hugo_apply_access(uuid,text,text,jsonb,text,timestamptz)') is not null
     and to_regprocedure('public.hugo_apply_access_unhashed(uuid,text,text,jsonb,text,timestamptz)') is null then
    alter function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
      rename to hugo_apply_access_unhashed;
  end if;
  if to_regprocedure('public.hugo_prepare_pristine_delete(uuid,text)') is not null
     and to_regprocedure('public.hugo_prepare_pristine_delete_unhashed(uuid,text)') is null then
    alter function public.hugo_prepare_pristine_delete(uuid, text)
      rename to hugo_prepare_pristine_delete_unhashed;
  end if;
  if to_regprocedure('public.hugo_delete_identity(uuid,text)') is not null
     and to_regprocedure('public.hugo_delete_identity_unhashed(uuid,text)') is null then
    alter function public.hugo_delete_identity(uuid, text)
      rename to hugo_delete_identity_unhashed;
  end if;
end;
$$;

revoke execute on function public.hugo_apply_access_unhashed(uuid, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function public.hugo_prepare_pristine_delete_unhashed(uuid, text)
  from public, anon, authenticated, service_role;
revoke execute on function public.hugo_delete_identity_unhashed(uuid, text)
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
  v_prior_hash text;
  v_prior jsonb;
  v_receipt jsonb;
  v_operation text;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0));
  v_hash := public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      'hugo_apply_access', v_email, p_role, v_config, p_status, to_jsonb(p_access_expires_at)
    )
  );
  if p_operation_id is not null then
    select request_hash, receipt into v_prior_hash, v_prior
    from public.hugo_access_operations
    where operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash then
        return public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash);
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, p_role, p_status, p_access_expires_at, v_hash
      );
    end if;
  end if;

  v_receipt := public.hugo_apply_access_unhashed(
    p_operation_id, p_email, p_role, v_config, p_status, p_access_expires_at
  );
  v_receipt := public.hugo_sandra_receipt_with_request_hash(v_receipt, v_hash);
  if p_operation_id is not null and not exists (
    select 1 from public.hugo_access_operations where operation_id = p_operation_id
  ) then
    v_operation := case
      when p_status = 'suspended' then 'suspend'
      when p_status = 'revoked' then 'revoke'
      else 'grant'
    end;
    insert into public.hugo_access_operations(
      operation_id, operation, email, app_user_id, requested, receipt
    ) values (
      p_operation_id,
      v_operation,
      v_email,
      null,
      jsonb_build_object(
        'role', p_role,
        'config', v_config,
        'status', p_status,
        'access_expires_at', p_access_expires_at
      ),
      v_receipt
    );
  end if;
  return v_receipt;
end;
$$;

revoke execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hugo_apply_access(uuid, text, text, jsonb, text, timestamptz)
  to service_role;

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
  v_receipt jsonb;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0));
  v_hash := public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      'hugo_prepare_pristine_delete', v_email, null, '{}'::jsonb, 'revoked', null
    )
  );
  if p_operation_id is not null then
    select request_hash, receipt into v_prior_hash, v_prior
    from public.hugo_access_operations
    where operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash then
        return public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash);
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, null, 'revoked', null, v_hash
      );
    end if;
  end if;
  v_receipt := public.hugo_prepare_pristine_delete_unhashed(p_operation_id, p_email);
  v_receipt := public.hugo_sandra_receipt_with_request_hash(v_receipt, v_hash);
  if p_operation_id is not null and not exists (
    select 1 from public.hugo_access_operations where operation_id = p_operation_id
  ) then
    insert into public.hugo_access_operations(
      operation_id, operation, email, app_user_id, requested, receipt
    ) values (
      p_operation_id,
      'preparePristineDelete',
      v_email,
      null,
      '{"status":"revoked"}'::jsonb,
      v_receipt
    );
  end if;
  return v_receipt;
end;
$$;

revoke execute on function public.hugo_prepare_pristine_delete(uuid, text)
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
  v_receipt jsonb;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0));
  v_hash := public.hugo_sandra_request_payload_hash(
    public.hugo_sandra_canonical_request_payload(
      'hugo_delete_identity', v_email, null, '{}'::jsonb, 'revoked', null
    )
  );
  if p_operation_id is not null then
    select request_hash, receipt into v_prior_hash, v_prior
    from public.hugo_access_operations
    where operation_id = p_operation_id;
    if found then
      if v_prior_hash = v_hash then
        return public.hugo_sandra_receipt_with_request_hash(v_prior, v_hash);
      end if;
      return public.hugo_sandra_operation_payload_conflict_receipt(
        p_operation_id, null, 'revoked', null, v_hash
      );
    end if;
  end if;
  v_receipt := public.hugo_delete_identity_unhashed(p_operation_id, p_email);
  v_receipt := public.hugo_sandra_receipt_with_request_hash(v_receipt, v_hash);
  if p_operation_id is not null and not exists (
    select 1 from public.hugo_access_operations where operation_id = p_operation_id
  ) then
    insert into public.hugo_access_operations(
      operation_id, operation, email, app_user_id, requested, receipt
    ) values (
      p_operation_id,
      'deleteIdentity',
      v_email,
      null,
      '{"status":"revoked"}'::jsonb,
      v_receipt
    );
  end if;
  return v_receipt;
end;
$$;

revoke execute on function public.hugo_delete_identity(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hugo_delete_identity(uuid, text)
  to service_role;

commit;
