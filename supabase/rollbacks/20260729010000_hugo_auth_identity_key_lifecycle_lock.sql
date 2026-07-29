-- MANUAL ONLY: emergency rollback for the exact pending delta in
-- 20260729010000_hugo_auth_identity_key_lifecycle_lock.sql.
--
-- This file is deliberately outside supabase/migrations. It is not included
-- in `supabase db push`, is never called by the app, and must only be run by
-- an operator with database-owner privileges after reviewing the incident.
-- It reverses one refactor only: the shared
-- hugo_store_non_pristine_email_receipt helper is removed and the two public
-- lifecycle functions regain their exact pre-refactor inline receipt paths.
-- No table rows, Auth identities, memberships, grants, or trigger objects are
-- deleted. The transaction and fail-closed preflight refuse to overwrite a
-- database that is not at the exact post-forward shape this delta produced.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
select pg_advisory_xact_lock(
  hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
);

do $$
declare
  v_helper text;
  v_prepare text;
  v_delete text;
  v_trigger_type smallint;
  v_trigger_function regprocedure;
begin
  if to_regprocedure(
       'public.hugo_store_non_pristine_email_receipt(uuid,text,text,text)'
     ) is null then
    raise exception 'HUGO_ROLLBACK_REFUSED_HELPER_MISSING';
  end if;
  if to_regprocedure(
       'public.hugo_prepare_pristine_delete_without_email_durable_guard(uuid,text)'
     ) is null
     or to_regprocedure(
       'public.hugo_delete_identity_without_email_durable_guard(uuid,text)'
     ) is null then
    raise exception 'HUGO_ROLLBACK_REFUSED_PRIVATE_WRAPPER_MISSING';
  end if;
  if to_regprocedure('public.hugo_prepare_pristine_delete(uuid,text)') is null
     or to_regprocedure('public.hugo_delete_identity(uuid,text)') is null then
    raise exception 'HUGO_ROLLBACK_REFUSED_PUBLIC_FUNCTION_MISSING';
  end if;

  v_helper := pg_get_functiondef(
    'public.hugo_store_non_pristine_email_receipt(uuid,text,text,text)'::regprocedure
  );
  v_prepare := pg_get_functiondef(
    'public.hugo_prepare_pristine_delete(uuid,text)'::regprocedure
  );
  v_delete := pg_get_functiondef(
    'public.hugo_delete_identity(uuid,text)'::regprocedure
  );

  if position('public.hugo_receipt(' in v_helper) = 0
     or position('public.hugo_store_access_operation(' in v_helper) = 0
     or position('hugo_store_non_pristine_email_receipt' in v_prepare) = 0
     or position('hugo_store_non_pristine_email_receipt' in v_delete) = 0 then
    raise exception 'HUGO_ROLLBACK_REFUSED_UNEXPECTED_FORWARD_SHAPE';
  end if;
  if not has_function_privilege(
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
     ) then
    raise exception 'HUGO_ROLLBACK_REFUSED_PUBLIC_ACCESS_SHAPE';
  end if;

  select trigger_row.tgtype, trigger_row.tgfoid::regprocedure
  into v_trigger_type, v_trigger_function
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = 'auth.users'::regclass
    and trigger_row.tgname = 'hugo_auth_users_lifecycle_lock'
    and not trigger_row.tgisinternal;
  if v_trigger_type is distinct from 22
     or v_trigger_function is distinct from
          'public.hugo_lock_auth_identity_key_lifecycle()'::regprocedure then
    raise exception 'HUGO_ROLLBACK_REFUSED_TRIGGER_SHAPE';
  end if;
end;
$$;

-- Restore the exact pre-refactor public prepare implementation. The private
-- unguarded wrapper remains untouched; only the durable-email receipt branch
-- moves back inline.
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

-- Restore the exact pre-refactor public delete implementation.
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

-- This is the only object removed by the rollback. It is a helper introduced
-- by the pending delta and has no remaining dependents after the replacements.
drop function public.hugo_store_non_pristine_email_receipt(
  uuid, text, text, text
);

do $$
declare
  v_prepare text;
  v_delete text;
  v_trigger_type smallint;
  v_trigger_function regprocedure;
begin
  if to_regprocedure(
       'public.hugo_store_non_pristine_email_receipt(uuid,text,text,text)'
     ) is not null then
    raise exception 'HUGO_ROLLBACK_FAILED_HELPER_REMAINS';
  end if;
  v_prepare := pg_get_functiondef(
    'public.hugo_prepare_pristine_delete(uuid,text)'::regprocedure
  );
  v_delete := pg_get_functiondef(
    'public.hugo_delete_identity(uuid,text)'::regprocedure
  );
  if position('hugo_store_non_pristine_email_receipt' in v_prepare) <> 0
     or position('hugo_store_non_pristine_email_receipt' in v_delete) <> 0
     or position('public.hugo_receipt(' in v_prepare) = 0
     or position('public.hugo_receipt(' in v_delete) = 0
     or position('public.hugo_store_access_operation(' in v_prepare) = 0
     or position('public.hugo_store_access_operation(' in v_delete) = 0 then
    raise exception 'HUGO_ROLLBACK_FAILED_INLINE_RECEIPT_PATH';
  end if;
  if not has_function_privilege(
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
     ) then
    raise exception 'HUGO_ROLLBACK_FAILED_PUBLIC_ACCESS_SHAPE';
  end if;
  select trigger_row.tgtype, trigger_row.tgfoid::regprocedure
  into v_trigger_type, v_trigger_function
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = 'auth.users'::regclass
    and trigger_row.tgname = 'hugo_auth_users_lifecycle_lock'
    and not trigger_row.tgisinternal;
  if v_trigger_type is distinct from 22
     or v_trigger_function is distinct from
          'public.hugo_lock_auth_identity_key_lifecycle()'::regprocedure then
    raise exception 'HUGO_ROLLBACK_FAILED_TRIGGER_SHAPE';
  end if;
end;
$$;

commit;
