-- A provider invocation that returns a definitive HTTP 4xx did not create a
-- template. Return that exact fenced attempt to unstarted so a corrected or
-- later retry can safely claim it again. Ambiguous failures still use
-- mark_esign_template_provider_create_unknown and remain non-reinvokable.
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
  if v_template.provider_create_state = 'unstarted'
     and v_template.provider_create_last_released_token_hash = v_token_hash then
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
  set provider_create_state = 'unstarted',
      provider_account_id = null,
      provider_create_claim_token_hash = null,
      provider_create_last_released_token_hash = v_token_hash,
      provider_create_claimed_at = null,
      provider_create_invocation_started_at = null,
      -- unstarted deliberately carries no error marker: unlike unknown, this
      -- state is safe to claim again under the existing table invariant.
      provider_create_error_code = null,
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
