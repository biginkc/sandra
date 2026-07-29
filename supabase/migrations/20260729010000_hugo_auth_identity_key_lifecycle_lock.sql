-- Auth identities can be inserted or renamed to a lifecycle target while the
-- lifecycle transaction still sees no matching row. Take the same advisory
-- lock before either identity-key mutation starts, while the row is still
-- invisible to competing snapshots.

set lock_timeout = '10s';

create or replace function public.hugo_lock_auth_identity_key_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
  );
  return null;
end;
$$;

revoke all on function public.hugo_lock_auth_identity_key_lifecycle()
  from public, anon, authenticated, service_role;

-- Resolve and lock every Auth row at the normalized email before testing
-- durable activity. This makes prior sign-in, identity-provider activity, and
-- public foreign-key evidence visible to both prepare and delete.
create or replace function public.hugo_email_has_durable_activity(
  p_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_user_ids uuid[];
  v_has_durable_activity boolean := false;
begin
  select array_agg(auth_user.id order by auth_user.id)
  into v_user_ids
  from auth.users auth_user
  where lower(trim(coalesce(auth_user.email, ''))) = v_email;

  if coalesce(cardinality(v_user_ids), 0) = 0 then
    return false;
  end if;

  perform 1
  from auth.users auth_user
  where auth_user.id = any(v_user_ids)
  order by auth_user.id
  for update;

  select coalesce(bool_or(
    public.hugo_has_durable_activity(user_id)
    or public.hugo_has_prior_sign_in(user_id)
  ), false)
  into v_has_durable_activity
  from unnest(v_user_ids) as matched_user(user_id);

  return v_has_durable_activity;
end;
$$;

revoke all on function public.hugo_email_has_durable_activity(text)
  from public, anon, authenticated, service_role;

-- Preserve the complete hosted lifecycle implementations behind private
-- wrappers. Replays leave this one-hop chain intact.
do $$
begin
  if to_regprocedure(
       'public.hugo_prepare_pristine_delete(uuid,text)'
     ) is not null
     and to_regprocedure(
       'public.hugo_prepare_pristine_delete_without_email_durable_guard(uuid,text)'
     ) is null
  then
    alter function public.hugo_prepare_pristine_delete(uuid, text)
      rename to hugo_prepare_pristine_delete_without_email_durable_guard;
  end if;

  if to_regprocedure(
       'public.hugo_delete_identity(uuid,text)'
     ) is not null
     and to_regprocedure(
       'public.hugo_delete_identity_without_email_durable_guard(uuid,text)'
     ) is null
  then
    alter function public.hugo_delete_identity(uuid, text)
      rename to hugo_delete_identity_without_email_durable_guard;
  end if;
end;
$$;

revoke all on function
  public.hugo_prepare_pristine_delete_without_email_durable_guard(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.hugo_delete_identity_without_email_durable_guard(uuid, text)
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
  v_prior_operation text;
  v_prior jsonb;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_has_membership boolean := false;
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

  if p_operation_id is not null
     and v_email ~ '^[^@[:space:]]+@bmhgroupkc\.com$'
     and public.hugo_email_has_durable_activity(v_email) then
    select auth_user.id
    into v_user_id
    from auth.users auth_user
    where lower(trim(coalesce(auth_user.email, ''))) = v_email
    order by auth_user.id
    limit 1;

    select *
    into v_membership
    from public.memberships membership
    where membership.user_id = v_user_id
      and membership.org_id =
        '00000000-0000-0000-0000-000000000bbb'::uuid
    for update;
    v_has_membership := found;

    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id,
        v_user_id,
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

  return public.hugo_prepare_pristine_delete_without_email_durable_guard(
    p_operation_id,
    v_email
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
  v_prior_operation text;
  v_prior jsonb;
  v_user_id uuid;
  v_membership public.memberships%rowtype;
  v_has_membership boolean := false;
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

  if p_operation_id is not null
     and v_email ~ '^[^@[:space:]]+@bmhgroupkc\.com$'
     and public.hugo_email_has_durable_activity(v_email) then
    select auth_user.id
    into v_user_id
    from auth.users auth_user
    where lower(trim(coalesce(auth_user.email, ''))) = v_email
    order by auth_user.id
    limit 1;

    select *
    into v_membership
    from public.memberships membership
    where membership.user_id = v_user_id
      and membership.org_id =
        '00000000-0000-0000-0000-000000000bbb'::uuid
    for update;
    v_has_membership := found;

    v_receipt := public.hugo_sandra_receipt_with_request_hash(
      public.hugo_receipt(
        p_operation_id,
        v_user_id,
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
  end if;

  return public.hugo_delete_identity_without_email_durable_guard(
    p_operation_id,
    v_email
  );
end;
$$;

revoke all on function public.hugo_delete_identity(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hugo_delete_identity(uuid, text)
  to service_role;

create or replace trigger hugo_auth_users_lifecycle_lock
before insert or update of email on auth.users
for each statement
execute function public.hugo_lock_auth_identity_key_lifecycle();

comment on trigger hugo_auth_users_lifecycle_lock on auth.users is
  'Serializes Auth inserts and email-key updates with Sandra privileged lifecycle proof before identity rows change.';

-- Replay fails closed unless the function still takes exactly one shared lock,
-- tgtype 22 remains BEFORE + INSERT + UPDATE + STATEMENT, and the rendered
-- definition restricts UPDATE to the email identity key.
do $$
declare
  v_function_definition text;
  v_prepare_definition text;
  v_delete_definition text;
  v_lock_count integer;
  v_prepare_guard_count integer;
  v_delete_guard_count integer;
  v_trigger_definition text;
  v_trigger_type smallint;
begin
  v_function_definition := pg_get_functiondef(
    'public.hugo_lock_auth_identity_key_lifecycle()'::regprocedure
  );
  v_lock_count :=
    (
      length(v_function_definition) -
      length(replace(
        v_function_definition,
        'hugo-sandra-privileged-lifecycle-v1',
        ''
      ))
    ) / length('hugo-sandra-privileged-lifecycle-v1');

  v_prepare_definition := pg_get_functiondef(
    'public.hugo_prepare_pristine_delete(uuid,text)'::regprocedure
  );
  v_prepare_guard_count :=
    (
      length(v_prepare_definition) -
      length(replace(
        v_prepare_definition,
        'hugo_email_has_durable_activity',
        ''
      ))
    ) / length('hugo_email_has_durable_activity');

  v_delete_definition := pg_get_functiondef(
    'public.hugo_delete_identity(uuid,text)'::regprocedure
  );
  v_delete_guard_count :=
    (
      length(v_delete_definition) -
      length(replace(
        v_delete_definition,
        'hugo_email_has_durable_activity',
        ''
      ))
    ) / length('hugo_email_has_durable_activity');

  select
    pg_get_triggerdef(trigger_row.oid),
    trigger_row.tgtype
  into
    v_trigger_definition,
    v_trigger_type
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = 'auth.users'::regclass
    and trigger_row.tgname = 'hugo_auth_users_lifecycle_lock'
    and not trigger_row.tgisinternal
    and trigger_row.tgfoid =
      'public.hugo_lock_auth_identity_key_lifecycle()'::regprocedure;

  if v_lock_count <> 1
    or v_prepare_guard_count <> 1
    or v_delete_guard_count <> 1
    or has_function_privilege(
      'service_role',
      'public.hugo_email_has_durable_activity(text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.hugo_prepare_pristine_delete_without_email_durable_guard(uuid,text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.hugo_delete_identity_without_email_durable_guard(uuid,text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.hugo_prepare_pristine_delete(uuid,text)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.hugo_delete_identity(uuid,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.hugo_prepare_pristine_delete(uuid,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.hugo_delete_identity(uuid,text)',
      'execute'
    )
    or v_trigger_type is distinct from 22
    or position(
      'before insert or update of email on auth.users'
      in lower(v_trigger_definition)
    ) = 0
  then
    raise exception
      'Sandra Auth identity-key lifecycle lock trigger shape drifted';
  end if;
end;
$$;
