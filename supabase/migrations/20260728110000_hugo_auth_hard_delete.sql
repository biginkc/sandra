-- Follow-up for the deployed Hugo provisioner. Deletion is still service-role
-- only and remains one transaction: local cleanup and Auth deletion either
-- both commit or both roll back.
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
  v_should_delete_auth boolean := false;
  v_deleted_count integer := 0;
begin
  perform public.hugo_require_service_role();
  perform pg_advisory_xact_lock(hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0));
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
      v_activity := public.hugo_has_durable_activity(v_user_id);
      if v_activity then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, null, '{}'::jsonb, 'revoked', null, null, '{}'::jsonb, 'missing', null, true, false, 'NON_PRISTINE', 'Sandra identity has durable business activity.');
      else
        v_should_delete_auth := true;
      end if;
    elsif v_membership.deletion_prepared_at is null then
      v_activity := public.hugo_has_durable_activity(v_user_id);
      v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, v_activity, false, 'PRISTINE_DELETE_REQUIRED', 'Identity must be prepared for deletion first.');
    else
      v_activity := public.hugo_has_durable_activity(v_user_id);
      if v_activity then
        v_receipt := public.hugo_receipt(p_operation_id, v_user_id, v_membership.role, v_membership.hugo_config, 'revoked', v_membership.access_expires_at, v_membership.role, v_membership.hugo_config, v_membership.access_status, v_membership.access_expires_at, true, false, 'NON_PRISTINE', 'Sandra identity has durable business activity.');
      else
        delete from public.memberships where user_id = v_user_id and org_id = v_membership.org_id;
        v_should_delete_auth := true;
      end if;
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
    -- Zero rows is an idempotent retry or a concurrent already-completed
    -- delete. In either case the safe postcondition is missing/no activity.
    v_receipt := public.hugo_receipt(
      p_operation_id,
      v_user_id,
      case when v_membership.user_id is null then null else v_membership.role end,
      case when v_membership.user_id is null then '{}'::jsonb else v_membership.hugo_config end,
      'revoked',
      case when v_membership.user_id is null then null else v_membership.access_expires_at end,
      null,
      '{}'::jsonb,
      'missing',
      null,
      false,
      true
    );
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
