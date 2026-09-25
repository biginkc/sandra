-- Root review of cba0c85d (jev-root-round14-review.md): release-blocking
-- gap — fn_update_jev_automatic_classification used
-- hugo_has_active_org_access(), which permits ANY active member, not
-- just an owner. The server action's isAdminEmail check is UX only and
-- trivially bypassable by calling the RPC directly (any active member
-- could flip a live org's Jev cutover). This is an administrative
-- organization setting, same tier as fn_set_jev_outcome_threshold's
-- owner-role + active-membership check — reuse that exact inline
-- condition here instead of the broader any-active-member helper. Org
-- is still resolved from p_config_id inside the DB (never caller-
-- supplied), and missing/cross-org still raise the SAME FORBIDDEN.

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

  if not exists (
    select 1
    from public.memberships m
    where m.user_id = v_actor
      and m.org_id = v_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    -- Covers cross-org (no membership in the config's actual org at
    -- all), inactive/expired/deletion-prepared membership, AND an
    -- ordinary active member who is not an owner — same indistinguishable
    -- FORBIDDEN in every case.
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
