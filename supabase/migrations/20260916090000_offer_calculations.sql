-- Offer calculator persistence: immutable, tenant-scoped calculation snapshots.
--
-- The trusted server calculates the worksheet results and supplies the
-- canonical request hash. This migration owns storage, authorization,
-- idempotency, revision allocation, and the activity-ledger transaction. It
-- deliberately does not implement calculator formulas in SQL.

begin;

create table public.offer_calculations (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  series_id uuid not null,
  version integer not null check (version >= 1),
  parent_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  formula_version text not null check (btrim(formula_version) <> ''),
  worksheet_sha256 text not null default '1017cc7835ae7f41a8d32e3228b9510fe01697c4a018f22b86df7c1061a4bdf8'
    check (worksheet_sha256 ~ '^[0-9a-f]{64}$'),
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object'),
  results jsonb not null check (jsonb_typeof(results) = 'object'),
  decision jsonb not null check (
    jsonb_typeof(decision) = 'object'
    and decision ?& array[
      'approach', 'program', 'feeTier', 'proposedOffer', 'terms', 'motivation'
    ]
  ),
  provenance jsonb not null check (
    jsonb_typeof(provenance) = 'object'
    and provenance ?& array['source', 'leadId']
    and provenance->>'source' in (
      'lead_calculations', 'lead_search', 'saved_calculation'
    )
  ),
  request_id uuid not null unique,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint offer_calculations_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id)
    on delete restrict,
  constraint offer_calculations_id_org_property_series_key
    unique (id, org_id, property_id, series_id),
  constraint offer_calculations_revision_key
    unique (org_id, property_id, series_id, version),
  constraint offer_calculations_parent_org_property_series_fkey
    foreign key (parent_id, org_id, property_id, series_id)
    references public.offer_calculations(id, org_id, property_id, series_id)
    on delete restrict
    deferrable initially deferred
);

comment on table public.offer_calculations is
  'Immutable completed offer-calculator snapshots. The only property_id rewrite is the authenticated duplicate-lead merge path, which preserves the snapshot and its revision lineage.';
comment on column public.offer_calculations.inputs is
  'Full calculator inputs, including editable listingPercentage at the precision submitted by the trusted server.';
comment on column public.offer_calculations.results is
  'Full trusted-server calculator outputs. Browser-calculated values are never authoritative.';
comment on column public.offer_calculations.decision is
  'Negotiated/proposed decision fields kept separate from calculated anchors.';
comment on column public.offer_calculations.request_hash is
  'SHA-256 hash of the canonical save request, including actor and all snapshot inputs supplied by the trusted server.';
comment on column public.offer_calculations.worksheet_sha256 is
  'SHA-256 checksum of the trusted worksheet source used for this snapshot.';

create index offer_calculations_property_created_idx
  on public.offer_calculations (org_id, property_id, created_at desc, id desc);
create index offer_calculations_series_version_idx
  on public.offer_calculations (org_id, property_id, series_id, version desc);
create index offer_calculations_created_by_idx
  on public.offer_calculations (org_id, created_by, created_at desc);

alter table public.offer_calculations enable row level security;

-- The browser may read a calculation when the viewer has the same active org
-- access used by the lead detail and the property is not soft-deleted. Saved
-- history is useful to every teammate who can already read that lead; creation
-- remains restricted by the service-role save RPC below. There are deliberately
-- no browser write policies.
create policy offer_calculations_authenticated_select
  on public.offer_calculations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.memberships m
      where m.org_id = offer_calculations.org_id
        and m.user_id = auth.uid()
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
        and exists (
          select 1
          from public.properties p
          where p.id = offer_calculations.property_id
            and p.org_id = offer_calculations.org_id
            and p.deleted_at is null
          )
    )
  );

revoke all on table public.offer_calculations
  from public, anon, authenticated, service_role;
grant select on table public.offer_calculations to authenticated, service_role;

-- Prevent all ordinary UPDATE/DELETE paths. The current merge wrapper sets a
-- transaction-local marker after it has authenticated same-org access and
-- locked both properties; only property_id may change in that path. Keeping
-- this exception in a trigger lets the snapshot itself remain immutable while
-- retaining history when the loser property is removed by a merge.
create or replace function public.offer_calculations_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'OFFER_CALCULATION_IMMUTABLE' using errcode = '55000';
  end if;

  if current_setting('offer_calculations.merge_repoint', true) is distinct from 'true' then
    raise exception 'OFFER_CALCULATION_IMMUTABLE' using errcode = '55000';
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.series_id is distinct from old.series_id
     or new.version is distinct from old.version
     or new.parent_id is distinct from old.parent_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.formula_version is distinct from old.formula_version
     or new.worksheet_sha256 is distinct from old.worksheet_sha256
     or new.inputs is distinct from old.inputs
     or new.results is distinct from old.results
     or new.decision is distinct from old.decision
     or new.provenance is distinct from old.provenance
     or new.request_id is distinct from old.request_id
     or new.request_hash is distinct from old.request_hash
     or new.property_id is null then
    raise exception 'OFFER_CALCULATION_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function public.offer_calculations_immutable_guard() from public, anon, authenticated, service_role;

create trigger offer_calculations_immutable_trigger
before update or delete on public.offer_calculations
for each row execute function public.offer_calculations_immutable_guard();

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

  -- Calculator saves attach to an active lead. A soft-deleted row and the
  -- unqualified prospect intake state are rejected at the database boundary
  -- as well as by the server-side lead chooser.
  if v_property.deleted_at is not null or v_property.status = 'prospect' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if not v_acquisitions_enabled
     or not exists (
       select 1
       from public.acquisition_org_settings s
       where s.org_id = v_property.org_id
         and s.my_leads_enabled
     ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_role <> 'owner' then
    if v_property.assigned_user_id is distinct from p_actor_id then
      raise exception 'STALE_ASSIGNMENT' using errcode = '40001';
    end if;
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

-- Extend the latest complete merge wrapper. The private Hugo helper still owns
-- the historical loser snapshot/delete sequence; this wrapper only adds the
-- calculator dependency and locks both properties before repointing rows.
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
  select property.org_id into v_keeper_org_id
  from public.properties property where property.id = keeper_id;
  select property.org_id into v_loser_org_id
  from public.properties property where property.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;

  -- Deterministic locking makes a concurrent save either complete before the
  -- merge or fail cleanly before the loser is removed.
  perform 1
  from public.properties property
  where property.id in (keeper_id, loser_id)
  order by property.id
  for update;

  update public.lead_events
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.ai_disposition_reviews
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.esign_requests
  set property_id = keeper_id,
      updated_at = now()
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.lead_files
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  perform set_config('offer_calculations.merge_repoint', 'true', true);
  set constraints offer_calculations_parent_org_property_series_fkey deferred;
  update public.offer_calculations
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  -- The trigger marker is transaction-local and only covers the repoint above.
  -- Clear it before invoking the private merge body so no later maintenance
  -- statement can accidentally inherit calculator write authority.
  perform set_config('offer_calculations.merge_repoint', '', true);

  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;

revoke all on function public.merge_duplicate_properties(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.merge_duplicate_properties(uuid, uuid)
  to authenticated;

commit;
