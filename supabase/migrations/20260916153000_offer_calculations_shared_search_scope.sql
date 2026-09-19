-- Calculator lead attachment follows the same organization-visible property
-- scope as global search. Active Acquisitions members may attach a calculation
-- to any non-deleted property in their organization, including an unassigned
-- property. Owners retain their existing calculator capability.

create or replace function public.fn_save_offer_calculation(
  p_actor_id uuid,
  p_property_id uuid,
  p_inputs jsonb,
  p_results jsonb,
  p_decision jsonb,
  p_provenance jsonb,
  p_formula_version text,
  p_request_id uuid,
  p_request_hash text,
  p_parent_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.offer_calculations%rowtype;
  v_snapshot public.offer_calculations%rowtype;
  v_property public.properties%rowtype;
  v_parent public.offer_calculations%rowtype;
  v_role text;
  v_acquisitions_enabled boolean;
  v_series_id uuid;
  v_next_version bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'OFFER_CALCULATION_SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  if p_actor_id is null
     or p_property_id is null
     or p_request_id is null
     or p_request_hash is null
     or p_request_hash !~ '^[0-9a-f]{64}$'
     or p_formula_version is null
     or btrim(p_formula_version) = ''
     or p_inputs is null
     or jsonb_typeof(p_inputs) <> 'object'
     or p_results is null
     or jsonb_typeof(p_results) <> 'object'
     or p_decision is null
     or jsonb_typeof(p_decision) <> 'object'
     or not (p_decision ?& array[
       'approach', 'program', 'feeTier', 'proposedOffer', 'terms', 'motivation'
     ])
     or p_provenance is null
     or jsonb_typeof(p_provenance) <> 'object'
     or not (p_provenance ?& array['source', 'leadId'])
     or p_provenance->>'source' not in (
       'lead_calculations', 'lead_search', 'saved_calculation'
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- Serialize requests before reading the receipt. This closes the race where
  -- two service-role retries both observe no receipt and allocate revisions.
  perform pg_advisory_xact_lock(
    hashtextextended('offer-calculation:' || p_request_id::text, 0)
  );

  -- Read the receipt without locking it. Every path locks the property first
  -- and the snapshot second, matching revision allocation and duplicate-lead
  -- merge order. Re-read the receipt under lock after the property lock so a
  -- concurrent merge cannot create a snapshot/property lock inversion.
  select * into v_existing
  from public.offer_calculations c
  where c.request_id = p_request_id;

  if v_existing.id is not null then
    select * into v_property
    from public.properties p
    where p.id = v_existing.property_id
      and p.org_id = v_existing.org_id
    for update;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;

    select * into v_existing
    from public.offer_calculations c
    where c.id = v_existing.id
    for update;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;

    if v_existing.created_by is distinct from p_actor_id
       or v_existing.request_hash is distinct from p_request_hash
       or v_existing.property_id is distinct from p_property_id
       or v_existing.parent_id is distinct from p_parent_id
       or v_existing.formula_version is distinct from p_formula_version
       or v_existing.inputs is distinct from p_inputs
       or v_existing.results is distinct from p_results
       or v_existing.decision is distinct from p_decision
       or v_existing.provenance is distinct from p_provenance then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
    end if;
  else
    select * into v_property
    from public.properties p
    where p.id = p_property_id
    for update;
    if not found then
      raise exception 'NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  select m.role, m.acquisitions_enabled
    into v_role, v_acquisitions_enabled
  from public.memberships m
  where m.org_id = v_property.org_id
    and m.user_id = p_actor_id
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp());
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  -- Global search exposes every non-deleted property in the caller's active
  -- organization. Keep the save boundary aligned with that shared scope.
  if v_property.deleted_at is not null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_role <> 'owner'
     and (v_acquisitions_enabled is distinct from true
     or not exists (
       select 1
       from public.acquisition_org_settings s
       where s.org_id = v_property.org_id
         and s.my_leads_enabled
     )) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_existing.id is not null then
    return to_jsonb(v_existing);
  end if;

  if p_parent_id is null then
    v_series_id := extensions.gen_random_uuid();
    v_next_version := 1;
  else
    select * into v_parent
    from public.offer_calculations c
    where c.id = p_parent_id
    for share;
    if not found
       or v_parent.org_id is distinct from v_property.org_id
       or v_parent.property_id is distinct from v_property.id then
      raise exception 'INVALID_PARENT' using errcode = '22023';
    end if;
    v_series_id := v_parent.series_id;
    select coalesce(max(c.version), 0) + 1 into v_next_version
    from public.offer_calculations c
    where c.org_id = v_property.org_id
      and c.property_id = v_property.id
      and c.series_id = v_series_id;
  end if;

  if v_next_version > 2147483647 then
    raise exception 'VERSION_EXHAUSTED' using errcode = '22003';
  end if;

  insert into public.offer_calculations (
    org_id, property_id, series_id, version, parent_id, created_by,
    formula_version, inputs, results, decision, provenance,
    request_id, request_hash
  ) values (
    v_property.org_id, v_property.id, v_series_id, v_next_version::integer,
    p_parent_id, p_actor_id, btrim(p_formula_version), p_inputs, p_results,
    p_decision, p_provenance, p_request_id, p_request_hash
  ) returning * into v_snapshot;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type,
    payload, source_type, source_id
  ) values (
    v_snapshot.org_id,
    v_snapshot.property_id,
    'user',
    v_snapshot.created_by,
    'calculation_saved',
    jsonb_build_object(
      'calculation_id', v_snapshot.id,
      'series_id', v_snapshot.series_id,
      'version', v_snapshot.version,
      'approach', p_decision->'approach',
      'program', p_decision->'program',
      'fee_tier', p_decision->'feeTier',
      'proposed_offer', p_decision->'proposedOffer'
    ),
    'offer_calculation',
    v_snapshot.id
  );

  return to_jsonb(v_snapshot);
end;
$$;

revoke all on function public.fn_save_offer_calculation(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.fn_save_offer_calculation(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, text, uuid
) to service_role;

