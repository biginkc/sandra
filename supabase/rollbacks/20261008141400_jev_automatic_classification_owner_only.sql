-- Rollback for 20261008141400_jev_automatic_classification_owner_only.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration replaced: restore the prior body (and grants).
-- fn_update_jev_automatic_classification(uuid, boolean): restore body from 20261008141300_jev_automatic_classification_active_access_rpc.sql
create or replace function public.fn_update_jev_automatic_classification(
  p_config_id uuid,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_row public.ai_responder_configs%rowtype;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_config_id is null or p_enabled is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select org_id into v_org_id
  from public.ai_responder_configs
  where id = p_config_id;
  if not found then
    -- Missing/stale config id fails closed with the SAME error as a
    -- genuine authorization failure — never a distinguishable "not
    -- found" that would let a caller probe for valid ids.
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not public.hugo_has_active_org_access(v_org_id) then
    -- Covers cross-org (caller has no active membership in the config's
    -- actual org) and inactive/expired/deletion-prepared membership —
    -- same helper every other authenticated RPC in this app uses.
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.ai_responder_configs
  set classifier_provider = case when p_enabled then 'jev' else 'legacy' end,
      classifier_mode = case when p_enabled then 'automatic' else 'shadow' end,
      updated_at = now()
  where id = p_config_id and org_id = v_org_id
  returning * into v_row;

  if not found then
    -- Defense in depth: the row was already confirmed to exist and be
    -- in an authorized org above, so this should be unreachable, but a
    -- truthful mutation result never silently reports success here.
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'classifierProvider', v_row.classifier_provider,
    'classifierMode', v_row.classifier_mode
  );
end;
$$;
revoke all on function public.fn_update_jev_automatic_classification(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.fn_update_jev_automatic_classification(uuid, boolean)
  to authenticated;

commit;
