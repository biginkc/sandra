-- A provider invocation that returns a definitive HTTP 4xx did not create a
-- template. Record that exact fenced attempt in the existing unknown/manual-
-- reconciliation state so an application rollback remains functional. New
-- code can re-arm only this tagged definitive outcome through the capability
-- RPC below. Ambiguous failures remain non-reinvokable.
create or replace function public.record_definitive_esign_template_provider_create_failure(
  p_org_id uuid,
  p_template_id uuid,
  p_source_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_actor_id uuid
)
returns table (outcome text, template_id uuid, created_by uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
  v_token_hash text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  if coalesce(p_error_code, '') !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'provider create failure error code is invalid'
      using errcode = '22023';
  end if;

  v_token_hash := encode(
    extensions.digest(convert_to(p_claim_token::text, 'utf8'), 'sha256'),
    'hex'
  );
  select * into v_template
  from public.esign_templates template
  where template.id = p_template_id
  for update;

  if not found
     or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null then
    raise exception 'ordinary eSign template provider invocation not found'
      using errcode = 'P0002';
  end if;
  if v_template.provider_create_state = 'attached' then
    return query select 'already_attached'::text, v_template.id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state = 'unknown'
     and v_template.provider_create_claim_token_hash = v_token_hash
     and v_template.provider_create_error_code = 'PROVIDER_REQUEST_REJECTED' then
    return query select 'already_recorded'::text, v_template.id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state <> 'invoking'
     or v_template.provider_create_claim_token_hash is distinct from v_token_hash
     or v_template.lifecycle_state not in ('preparing', 'editing')
     or v_template.finalized_at is not null
     or v_template.deleted_at is not null
     or v_template.abandoned_at is not null then
    raise exception 'ordinary eSign template provider invocation cannot record a definitive failure'
      using errcode = '42501';
  end if;

  update public.esign_templates template
  set provider_create_state = 'unknown',
      provider_create_error_code = 'PROVIDER_REQUEST_REJECTED',
      updated_by = p_actor_id,
      updated_at = now()
  where template.id = p_template_id
    and template.org_id = p_org_id
    and template.provider_create_state = 'invoking'
    and template.provider_create_claim_token_hash = v_token_hash;
  if not found then
    raise exception 'ordinary eSign template provider invocation changed concurrently'
      using errcode = '40001';
  end if;

  return query select 'recorded_failure'::text, v_template.id,
    v_template.created_by;
end;
$$;

revoke all on function public.record_definitive_esign_template_provider_create_failure(
  uuid, uuid, uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.record_definitive_esign_template_provider_create_failure(
  uuid, uuid, uuid, uuid, text, uuid
) to service_role;

-- Definitive failures are genuine unknown/manual-reconciliation rows, not a
-- display-only projection. Old application builds can therefore execute their
-- existing reconciliation action after a rollback.
create or replace function public.list_pending_esign_template_provider_creates(
  p_org_id uuid, p_actor_id uuid
)
returns table (
  template_id uuid,
  source_id uuid,
  name text,
  provider_create_state text,
  provider_create_claimed_at timestamptz,
  provider_create_invocation_started_at timestamptz,
  provider_create_error_code text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  return query
  select template.id, template.staging_source_id, template.name,
    template.provider_create_state,
    template.provider_create_claimed_at,
    template.provider_create_invocation_started_at,
    template.provider_create_error_code, template.created_by,
    template.created_at
  from public.esign_templates template
  left join public.org_esign_integrations integration
    on integration.org_id = template.org_id
   and integration.provider = 'dropbox_sign'
   and integration.provider_account_id = template.provider_account_id
  where template.org_id = p_org_id
    and template.lifecycle_state in ('preparing', 'editing')
    and template.finalized_at is null
    and template.deleted_at is null
    and template.abandoned_at is null
    and template.duplicate_of_template_id is null
    and template.supersedes_template_id is null
    and (
      (template.provider_create_state in (
        'claimed', 'invoking', 'unknown', 'attached'
      ) and integration.org_id is not null)
    )
  order by template.created_at, template.id;
end;
$$;

-- New application builds use a separate capability listing for the retry
-- button. If code deploys first, this call is absent and the runtime stays on
-- the conservative unknown/manual-reconciliation path.
create or replace function public.list_retryable_esign_template_provider_creates(
  p_org_id uuid, p_actor_id uuid
)
returns table (
  template_id uuid,
  source_id uuid,
  name text,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  return query
  select template.id, template.staging_source_id, template.name,
    template.created_by, template.created_at
  from public.esign_templates template
  where template.org_id = p_org_id
    and template.lifecycle_state in ('preparing', 'editing')
    and template.provider_create_state = 'unknown'
    and template.provider_create_error_code = 'PROVIDER_REQUEST_REJECTED'
    and template.provider_create_claim_token_hash is not null
    and template.provider_create_last_released_token_hash is null
    and template.finalized_at is null
    and template.deleted_at is null
    and template.abandoned_at is null
    and template.duplicate_of_template_id is null
    and template.supersedes_template_id is null
  order by template.created_at, template.id;
end;
$$;

revoke all on function public.list_retryable_esign_template_provider_creates(
  uuid, uuid
) from public, anon, authenticated;
grant execute on function public.list_retryable_esign_template_provider_creates(
  uuid, uuid
) to service_role;

-- Keep the ordinary claim function stable for old and rolled-back application
-- builds. Definitive retries use the atomic begin function below instead.
create or replace function public.claim_esign_template_provider_create(
  p_org_id uuid, p_template_id uuid, p_source_id uuid, p_actor_id uuid
)
returns table (
  outcome text,
  template_id uuid,
  provider_create_state text,
  claim_token uuid,
  provider_template_id text,
  provider_account_id text,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
  v_token uuid;
  v_provider_account_id text;
  v_claimed_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_template
  from public.esign_templates template
  where template.id = p_template_id
  for update;
  if not found
     or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null
     or v_template.lifecycle_state not in ('preparing', 'editing')
     or v_template.finalized_at is not null
     or v_template.deleted_at is not null
     or v_template.abandoned_at is not null
     or v_template.provider_create_state is null then
    raise exception 'ordinary eSign template draft claim contract does not match'
      using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.esign_template_staging_sources source
    where source.id = p_source_id
      and source.org_id = p_org_id
      and source.verification_state = 'verified'
      and source.cleanup_outcome = 'pending'
  ) then
    raise exception 'ordinary eSign template source is unavailable'
      using errcode = '55000';
  end if;
  if v_template.provider_create_state <> 'unstarted'
     and v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'provider create account no longer matches current integration'
      using errcode = '23514';
  end if;
  if v_template.provider_create_state = 'attached' then
    return query select 'already_attached'::text, v_template.id,
      v_template.provider_create_state, null::uuid,
      v_template.sign_template_id, v_template.provider_account_id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state = 'claimed'
     and v_template.provider_create_claimed_at + interval '10 minutes'
       > v_claimed_at then
    return query select 'already_in_progress'::text, v_template.id,
      v_template.provider_create_state, null::uuid,
      null::text, v_template.provider_account_id, v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state in ('invoking', 'unknown') then
    return query select 'already_in_progress'::text, v_template.id,
      v_template.provider_create_state, null::uuid,
      null::text, v_template.provider_account_id, v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state = 'claimed' then
    v_token := gen_random_uuid();
    update public.esign_templates template
    set provider_create_claim_token_hash = encode(
          extensions.digest(
            convert_to(v_token::text, 'utf8'), 'sha256'
          ),
          'hex'
        ),
        provider_create_claimed_at = v_claimed_at,
        updated_by = p_actor_id,
        updated_at = v_claimed_at
    where template.id = p_template_id and template.org_id = p_org_id
      and template.provider_create_state = 'claimed'
      and template.provider_create_invocation_started_at is null;
    return query select 'claimed'::text, v_template.id, 'claimed'::text,
      v_token, null::text, v_template.provider_account_id,
      v_template.created_by;
    return;
  end if;
  if v_template.provider_create_state <> 'unstarted' then
    raise exception 'ordinary eSign template provider state is invalid'
      using errcode = '23514';
  end if;
  v_token := gen_random_uuid();
  update public.esign_templates template
  set provider_create_state = 'claimed',
      provider_account_id = v_provider_account_id,
      provider_create_claim_token_hash = encode(
        extensions.digest(convert_to(v_token::text, 'utf8'), 'sha256'),
        'hex'
      ),
      provider_create_last_released_token_hash = null,
      provider_create_claimed_at = v_claimed_at,
      provider_create_invocation_started_at = null,
      provider_create_error_code = null,
      updated_by = p_actor_id,
      updated_at = v_claimed_at
  where template.id = p_template_id and template.org_id = p_org_id
    and template.provider_create_state = 'unstarted';
  if not found then
    raise exception 'ordinary eSign template provider claim changed concurrently'
      using errcode = '40001';
  end if;
  return query select 'claimed'::text, v_template.id, 'claimed'::text,
    v_token, null::text, v_provider_account_id, v_template.created_by;
end;
$$;

-- Retry a definitively rejected invocation by moving the tagged unknown row
-- directly to invoking while returning its fresh token. There is no durable
-- claimed gap: a crash before this transaction leaves retryable unknown, and a
-- crash after it leaves the existing conservative invoking recovery state.
create or replace function public.begin_definitive_esign_template_provider_create_retry(
  p_org_id uuid, p_template_id uuid, p_source_id uuid, p_actor_id uuid
)
returns table (
  outcome text,
  template_id uuid,
  provider_create_state text,
  claim_token uuid,
  provider_template_id text,
  provider_account_id text,
  created_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template public.esign_templates%rowtype;
  v_token uuid;
  v_provider_account_id text;
  v_started_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform public.esign_require_active_owner(p_org_id, p_actor_id);
  select integration.provider_account_id into v_provider_account_id
  from public.org_esign_integrations integration
  where integration.org_id = p_org_id
    and integration.provider = 'dropbox_sign'
  for share;
  if not found then
    raise exception 'current Dropbox Sign integration not found'
      using errcode = 'P0002';
  end if;
  select * into v_template
  from public.esign_templates template
  where template.id = p_template_id
  for update;
  if not found
     or v_template.org_id <> p_org_id
     or v_template.staging_source_id <> p_source_id
     or v_template.duplicate_of_template_id is not null
     or v_template.supersedes_template_id is not null
     or v_template.lifecycle_state not in ('preparing', 'editing')
     or v_template.finalized_at is not null
     or v_template.deleted_at is not null
     or v_template.abandoned_at is not null
     or v_template.sign_template_id is not null then
    raise exception 'definitive eSign template provider retry contract does not match'
      using errcode = 'P0002';
  end if;
  if v_template.provider_account_id is distinct from v_provider_account_id then
    raise exception 'provider create account no longer matches current integration'
      using errcode = '23514';
  end if;
  if v_template.provider_create_state <> 'unknown'
     or v_template.provider_create_error_code <> 'PROVIDER_REQUEST_REJECTED'
     or v_template.provider_create_claim_token_hash is null
     or v_template.provider_create_last_released_token_hash is not null then
    raise exception 'definitive eSign template provider retry is unavailable'
      using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.esign_template_staging_sources source
    where source.id = p_source_id
      and source.org_id = p_org_id
      and source.verification_state = 'verified'
      and source.cleanup_outcome = 'pending'
  ) then
    raise exception 'definitive eSign template source is unavailable'
      using errcode = '55000';
  end if;
  v_token := gen_random_uuid();
  update public.esign_templates template
  set provider_create_state = 'invoking',
      provider_create_claim_token_hash = encode(
        extensions.digest(convert_to(v_token::text, 'utf8'), 'sha256'),
        'hex'
      ),
      provider_create_claimed_at = v_started_at,
      provider_create_invocation_started_at = v_started_at,
      provider_create_error_code = null,
      updated_by = p_actor_id,
      updated_at = v_started_at
  where template.id = p_template_id
    and template.org_id = p_org_id
    and template.provider_create_state = 'unknown'
    and template.provider_create_error_code = 'PROVIDER_REQUEST_REJECTED'
    and template.provider_create_claim_token_hash =
      v_template.provider_create_claim_token_hash
    and template.provider_create_last_released_token_hash is null;
  if not found then
    raise exception 'definitive eSign template provider retry changed concurrently'
      using errcode = '40001';
  end if;
  return query select 'started'::text, v_template.id, 'invoking'::text,
    v_token, null::text, v_provider_account_id, v_template.created_by;
end;
$$;

revoke all on function public.begin_definitive_esign_template_provider_create_retry(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.begin_definitive_esign_template_provider_create_retry(
  uuid, uuid, uuid, uuid
) to service_role;
