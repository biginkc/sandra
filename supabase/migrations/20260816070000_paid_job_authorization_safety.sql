-- Trusted paid-CASS creation/start receipts, retry authorization hardening,
-- and structural tenant agreement for per-job property results.

begin;

-- A job row is not, by itself, authority to spend provider credits.  Every
-- CASS job must have a server-created receipt whose tenant and targets are
-- immutable and whose start can be claimed only once.
create table if not exists public.cass_job_authorizations (
  job_id uuid primary key,
  org_id uuid not null,
  request_key uuid not null,
  purpose text not null check (purpose in ('standalone', 'import', 'retry', 'legacy')),
  property_ids uuid[] not null check (cardinality(property_ids) > 0),
  requested_by uuid references auth.users(id) on delete set null,
  source_job_id uuid,
  authorized_at timestamptz not null default now(),
  start_claim_token uuid unique,
  start_claimed_at timestamptz,
  constraint cass_job_authorizations_job_org_fkey
    foreign key (job_id, org_id) references public.jobs(id, org_id) on delete cascade,
  constraint cass_job_authorizations_source_org_fkey
    foreign key (source_job_id, org_id) references public.jobs(id, org_id),
  constraint cass_job_authorizations_org_request_key_key unique (org_id, request_key)
);

alter table public.cass_job_authorizations enable row level security;
revoke all on public.cass_job_authorizations from public, anon, authenticated;
revoke all on public.cass_job_authorizations from service_role;
grant select on public.cass_job_authorizations to service_role;

create or replace function public.require_authorized_cass_job_shape()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.type = 'cass_dsf2_ncoa'
    and (tg_op = 'INSERT' or old.type is distinct from 'cass_dsf2_ncoa')
    and current_user not in ('postgres', 'supabase_admin', 'service_role')
  then
    raise exception using
      errcode = '42501',
      message = 'CASS_JOB_AUTHORIZATION_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_require_authorized_cass_shape on public.jobs;
create trigger jobs_require_authorized_cass_shape
  before insert or update of type on public.jobs
  for each row execute function public.require_authorized_cass_job_shape();

create or replace function public.create_authorized_cass_job(
  p_org_id uuid,
  p_property_ids uuid[],
  p_purpose text,
  p_parent_job_id uuid,
  p_related_import_id uuid,
  p_source_job_id uuid,
  p_created_by uuid,
  p_auto_start boolean,
  p_blocked_reason text,
  p_request_key uuid
)
returns table(job_id uuid, claim_token uuid, created boolean, job_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(auth.role(), '');
  v_actor uuid := auth.uid();
  v_property_ids uuid[];
  v_job_id uuid;
  v_claim_token uuid;
  v_existing public.cass_job_authorizations%rowtype;
  v_existing_job public.jobs%rowtype;
  v_parent public.jobs%rowtype;
  v_source public.jobs%rowtype;
  v_requested_by uuid;
begin
  if p_request_key is null then
    raise exception using errcode = '22023', message = 'CASS_REQUEST_KEY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_request_key::text, 0));

  if p_purpose not in ('standalone', 'import', 'retry') then
    raise exception using errcode = '22023', message = 'CASS_PURPOSE_INVALID';
  end if;

  select array_agg(distinct target order by target)
    into v_property_ids
  from unnest(coalesce(p_property_ids, array[]::uuid[])) target;
  if coalesce(cardinality(v_property_ids), 0) = 0 then
    raise exception using errcode = '22023', message = 'CASS_PROPERTIES_REQUIRED';
  end if;

  if v_role = 'authenticated' then
    if not exists (
      select 1 from public.memberships membership
      where membership.user_id = v_actor
        and membership.org_id = p_org_id
        and membership.access_status = 'active'
        and membership.deletion_prepared_at is null
        and (membership.access_expires_at is null or membership.access_expires_at > now())
    ) then
      raise exception using errcode = '42501', message = 'CASS_ACTIVE_MEMBERSHIP_REQUIRED';
    end if;
  elsif v_role <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception using errcode = '42501', message = 'CASS_CALLER_NOT_AUTHORIZED';
  end if;

  -- A workflow retry may recompute a smaller eligible set after some saved
  -- results were already applied. The request receipt, not mutable property
  -- state, remains authoritative for this request key.
  select receipt.* into v_existing
  from public.cass_job_authorizations receipt
  where receipt.org_id = p_org_id and receipt.request_key = p_request_key
  for update;
  if found then
    select existing_job.* into v_existing_job
    from public.jobs existing_job
    where existing_job.id = v_existing.job_id and existing_job.org_id = p_org_id
    for update;
    if v_existing_job.id is null
      or v_existing.purpose <> p_purpose
      or (
        (p_purpose = 'import' and not (v_property_ids <@ v_existing.property_ids))
        or (p_purpose <> 'import' and v_property_ids is distinct from v_existing.property_ids)
      )
      or v_existing.source_job_id is distinct from p_source_job_id
      or v_existing_job.parent_job_id is distinct from p_parent_job_id
      or v_existing_job.related_import_id is distinct from p_related_import_id
    then
      raise exception using errcode = '23514', message = 'CASS_REQUEST_KEY_CONFLICT';
    end if;
    return query select v_existing.job_id, v_existing.start_claim_token,
      false, v_existing_job.status;
    return;
  end if;

  if (
    select count(*) from public.properties property
    where property.id = any(v_property_ids)
      and property.org_id = p_org_id
      and property.deleted_at is null
      and not property.is_dnc_locked
  ) <> cardinality(v_property_ids) then
    raise exception using errcode = '23514', message = 'CASS_PROPERTY_SCOPE_OR_DNC_MISMATCH';
  end if;

  if p_purpose = 'standalone' then
    if v_role <> 'authenticated'
      or p_parent_job_id is not null
      or p_related_import_id is not null
      or p_source_job_id is not null
      or p_created_by is distinct from v_actor
    then
      raise exception using errcode = '42501', message = 'CASS_STANDALONE_PROVENANCE_INVALID';
    end if;
  elsif p_purpose = 'import' then
    if v_role <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
      raise exception using errcode = '42501', message = 'CASS_IMPORT_SERVICE_ROLE_REQUIRED';
    end if;
    select parent.* into v_parent
    from public.jobs parent
    where parent.id = p_parent_job_id and parent.org_id = p_org_id
    for key share;
    if v_parent.id is null
      or v_parent.type <> 'csv_import'
      or v_parent.related_import_id is distinct from p_related_import_id
      or p_source_job_id is not null
      or exists (
        select 1 from unnest(v_property_ids) target
        where not exists (
          select 1 from public.job_items item
          where item.job_id = v_parent.id
            and item.property_id = target
            and item.status in ('success', 'skipped')
        )
      )
    then
      raise exception using errcode = '23514', message = 'CASS_IMPORT_PROVENANCE_INVALID';
    end if;
  else
    select source.* into v_source
    from public.jobs source
    where source.id = p_source_job_id and source.org_id = p_org_id
    for key share;
    if v_source.id is null
      or v_source.type <> 'cass_dsf2_ncoa'
      or p_parent_job_id is distinct from coalesce(v_source.parent_job_id, v_source.id)
      or p_related_import_id is distinct from v_source.related_import_id
      or exists (
        select 1 from unnest(v_property_ids) target
        where not exists (
          select 1 from public.job_items item
          where item.job_id = v_source.id
            and item.property_id = target
            and item.status = 'error'
        )
      )
    then
      raise exception using errcode = '23514', message = 'CASS_RETRY_PROVENANCE_INVALID';
    end if;
  end if;

  v_requested_by := case
    when p_purpose in ('standalone', 'retry') then v_actor
    else p_created_by
  end;

  v_claim_token := case when p_auto_start then gen_random_uuid() else null end;

  insert into public.jobs (
    type, org_id, status, parent_job_id, related_import_id, created_by,
    total_items, title, description, provider, input_params, result_summary,
    started_at, worker_heartbeat_at
  ) values (
    'cass_dsf2_ncoa', p_org_id, case when p_auto_start then 'running' else 'queued' end,
    p_parent_job_id, p_related_import_id,
    v_requested_by, cardinality(v_property_ids),
    format('CASS verify %s %s', cardinality(v_property_ids),
      case when cardinality(v_property_ids) = 1 then 'property' else 'properties' end),
    case
      when p_purpose = 'standalone' then 'Bulk verify from /properties'
      when p_auto_start then 'Auto-triggered after CSV import'
      else format('Awaiting manual start (%s)', coalesce(p_blocked_reason, 'budget cap'))
    end,
    'smartystreets', jsonb_build_object('property_ids', to_jsonb(v_property_ids)),
    case when p_auto_start then null else
      jsonb_build_object('awaiting_manual_start', true, 'reason', p_blocked_reason)
    end,
    case when p_auto_start then now() else null end,
    case when p_auto_start then now() else null end
  ) returning id into v_job_id;

  insert into public.cass_job_authorizations (
    job_id, org_id, request_key, purpose, property_ids, requested_by,
    source_job_id, start_claim_token, start_claimed_at
  ) values (
    v_job_id, p_org_id, p_request_key, p_purpose, v_property_ids, v_requested_by,
    p_source_job_id, v_claim_token, case when p_auto_start then now() else null end
  );

  return query select v_job_id, v_claim_token, true,
    case when p_auto_start then 'running' else 'queued' end;
end;
$$;

revoke all on function public.create_authorized_cass_job(
  uuid, uuid[], text, uuid, uuid, uuid, uuid, boolean, text, uuid
) from public, anon;
grant execute on function public.create_authorized_cass_job(
  uuid, uuid[], text, uuid, uuid, uuid, uuid, boolean, text, uuid
) to authenticated, service_role;

-- Preserve startability of structurally valid CASS jobs created before this
-- receipt existed. Malformed or cross-tenant legacy jobs intentionally remain
-- unstartable and require operator reconciliation.
with legacy_targets as (
  select job.id as job_id, job.org_id, job.created_by,
    array_agg(distinct target.value::uuid order by target.value::uuid) as property_ids
  from public.jobs job
  cross join lateral jsonb_array_elements_text(
    case
      when jsonb_typeof(job.input_params->'property_ids') = 'array'
        then job.input_params->'property_ids'
      else '[]'::jsonb
    end
  ) target(value)
  where job.type = 'cass_dsf2_ncoa'
    and jsonb_typeof(job.input_params->'property_ids') = 'array'
    and target.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  group by job.id, job.org_id, job.created_by, job.input_params
  having count(*) = jsonb_array_length(job.input_params->'property_ids')
    and count(distinct target.value::uuid) = jsonb_array_length(job.input_params->'property_ids')
    and count(*) = (
      select count(*) from public.properties property
      where property.id = any(array_agg(distinct target.value::uuid))
        and property.org_id = job.org_id
    )
)
insert into public.cass_job_authorizations (
  job_id, org_id, request_key, purpose, property_ids, requested_by
)
select job_id, org_id, job_id, 'legacy', property_ids, created_by
from legacy_targets
on conflict (job_id) do nothing;

create or replace function public.claim_authorized_cass_job_start(
  p_job_id uuid,
  p_org_id uuid,
  p_claim_token uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(auth.role(), '');
  v_job public.jobs%rowtype;
  v_authorization public.cass_job_authorizations%rowtype;
  v_input_ids uuid[];
  v_token uuid;
begin
  select job.* into v_job
  from public.jobs job
  where job.id = p_job_id and job.org_id = p_org_id
  for update;
  if v_job.id is null or v_job.type <> 'cass_dsf2_ncoa' then
    raise exception using errcode = '23514', message = 'CASS_JOB_NOT_AUTHORIZED';
  end if;

  select receipt.* into v_authorization
  from public.cass_job_authorizations receipt
  where receipt.job_id = v_job.id and receipt.org_id = v_job.org_id
  for update;
  if v_authorization.job_id is null then
    raise exception using errcode = '42501', message = 'CASS_JOB_RECEIPT_REQUIRED';
  end if;

  if v_role = 'authenticated' then
    if not exists (
      select 1 from public.memberships membership
      where membership.user_id = auth.uid()
        and membership.org_id = v_job.org_id
        and membership.access_status = 'active'
        and membership.deletion_prepared_at is null
        and (membership.access_expires_at is null or membership.access_expires_at > now())
    ) then
      raise exception using errcode = '42501', message = 'CASS_ACTIVE_MEMBERSHIP_REQUIRED';
    end if;
  elsif v_role <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception using errcode = '42501', message = 'CASS_CALLER_NOT_AUTHORIZED';
  end if;

  begin
    select array_agg(distinct value::uuid order by value::uuid)
      into v_input_ids
    from jsonb_array_elements_text(v_job.input_params->'property_ids') value;
  exception when others then
    raise exception using errcode = '23514', message = 'CASS_JOB_INPUT_INVALID';
  end;

  if v_input_ids is distinct from v_authorization.property_ids
    or (
      select count(*) from public.properties property
      where property.id = any(v_authorization.property_ids)
        and property.org_id = v_job.org_id
        and property.deleted_at is null
    ) <> cardinality(v_authorization.property_ids)
  then
    raise exception using errcode = '23514', message = 'CASS_JOB_TARGETS_INVALID';
  end if;

  if v_authorization.start_claim_token is not null then
    if p_claim_token = v_authorization.start_claim_token
      and v_job.status = 'running'
    then
      return v_authorization.start_claim_token;
    end if;
    raise exception using errcode = '55000', message = 'CASS_JOB_ALREADY_CLAIMED';
  end if;
  if v_job.status <> 'queued' then
    raise exception using errcode = '55000', message = 'CASS_JOB_NOT_QUEUED';
  end if;

  v_token := coalesce(p_claim_token, gen_random_uuid());
  update public.cass_job_authorizations
  set start_claim_token = v_token, start_claimed_at = now()
  where job_id = v_job.id;
  update public.jobs
  set status = 'running', started_at = now(), worker_heartbeat_at = now(),
      total_items = cardinality(v_authorization.property_ids), result_summary = null
  where id = v_job.id and org_id = v_job.org_id;
  return v_token;
end;
$$;

revoke all on function public.claim_authorized_cass_job_start(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.claim_authorized_cass_job_start(uuid, uuid, uuid)
  to authenticated, service_role;

create or replace function public.fail_authorized_cass_job_start(
  p_job_id uuid,
  p_org_id uuid,
  p_claim_token uuid,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.cass_job_authorizations receipt
    where receipt.job_id = p_job_id
      and receipt.org_id = p_org_id
      and receipt.start_claim_token = p_claim_token
  ) then
    return false;
  end if;
  update public.jobs
  set status = 'failed', error_class = 'database', error_message = left(p_message, 2000),
      completed_at = now(), worker_heartbeat_at = now()
  where id = p_job_id and org_id = p_org_id and status = 'running';
  return found;
end;
$$;

revoke all on function public.fail_authorized_cass_job_start(uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.fail_authorized_cass_job_start(uuid, uuid, uuid, text)
  to authenticated, service_role;

-- A job/property lookup crosses a paid provider boundary exactly once. The
-- immutable row survives workflow replay and lets a retry job reuse a saved
-- provider response without charging again.
create table if not exists public.cass_property_lookup_outcomes (
  job_id uuid not null,
  org_id uuid not null,
  property_key uuid not null,
  property_id uuid,
  state text not null check (state in ('submitting', 'completed', 'retryable', 'ambiguous')),
  provider_id text not null,
  outcome text,
  result_payload jsonb,
  error_message text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (job_id, property_key),
  constraint cass_property_lookup_outcomes_job_org_fkey
    foreign key (job_id, org_id) references public.jobs(id, org_id) on delete cascade,
  constraint cass_property_lookup_outcomes_property_org_fkey
    foreign key (property_id, org_id) references public.properties(id, org_id)
      on delete set null (property_id),
  constraint cass_property_lookup_outcomes_property_key_check
    check (property_id is null or property_id = property_key)
);

alter table public.cass_property_lookup_outcomes enable row level security;
revoke all on public.cass_property_lookup_outcomes from public, anon, authenticated;

create or replace function public.claim_cass_property_lookup(
  p_job_id uuid,
  p_org_id uuid,
  p_property_id uuid,
  p_provider_id text
)
returns table(action text, outcome text, result_payload jsonb, error_message text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.cass_job_authorizations%rowtype;
  v_current public.cass_property_lookup_outcomes%rowtype;
  v_source public.cass_property_lookup_outcomes%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and current_user not in ('postgres', 'supabase_admin')
  then
    raise exception using errcode = '42501', message = 'CASS_LOOKUP_SERVICE_ROLE_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text || ':' || p_property_id::text, 0));

  select receipt.* into v_receipt
  from public.cass_job_authorizations receipt
  join public.jobs job on job.id = receipt.job_id and job.org_id = receipt.org_id
  where receipt.job_id = p_job_id
    and receipt.org_id = p_org_id
    and p_property_id = any(receipt.property_ids)
    and job.type = 'cass_dsf2_ncoa'
    and job.status = 'running'
  for update of receipt;
  if v_receipt.job_id is null then
    raise exception using errcode = '42501', message = 'CASS_LOOKUP_RECEIPT_REQUIRED';
  end if;

  select saved.* into v_current
  from public.cass_property_lookup_outcomes saved
  where saved.job_id = p_job_id and saved.property_key = p_property_id
  for update;
  if found then
    return query select
      case
        when v_current.state = 'completed' then 'reused'
        when v_current.state = 'retryable' then 'retry_blocked'
        else 'ambiguous'
      end,
      v_current.outcome, v_current.result_payload, v_current.error_message;
    return;
  end if;

  if v_receipt.source_job_id is not null then
    select saved.* into v_source
    from public.cass_property_lookup_outcomes saved
    where saved.job_id = v_receipt.source_job_id
      and saved.org_id = p_org_id
      and saved.property_key = p_property_id
    for key share;
    if found and v_source.state in ('completed', 'submitting', 'ambiguous') then
      insert into public.cass_property_lookup_outcomes (
        job_id, org_id, property_key, property_id, state, provider_id,
        outcome, result_payload, error_message, completed_at
      ) values (
        p_job_id, p_org_id, p_property_id, p_property_id,
        case when v_source.state = 'completed' then 'completed' else 'ambiguous' end,
        v_source.provider_id, v_source.outcome, v_source.result_payload,
        v_source.error_message,
        case when v_source.state = 'completed' then now() else null end
      );
      return query select
        case when v_source.state = 'completed' then 'reused' else 'ambiguous' end,
        v_source.outcome, v_source.result_payload, v_source.error_message;
      return;
    end if;
  end if;

  if not public.claim_paid_property_enrichment(p_property_id, p_org_id) then
    return query select 'dnc_locked'::text, null::text, null::jsonb, null::text;
    return;
  end if;

  insert into public.cass_property_lookup_outcomes (
    job_id, org_id, property_key, property_id, state, provider_id
  ) values (
    p_job_id, p_org_id, p_property_id, p_property_id, 'submitting', p_provider_id
  );
  return query select 'claimed'::text, null::text, null::jsonb, null::text;
end;
$$;

revoke all on function public.claim_cass_property_lookup(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_cass_property_lookup(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.complete_cass_property_lookup(
  p_job_id uuid,
  p_org_id uuid,
  p_property_id uuid,
  p_state text,
  p_outcome text,
  p_result_payload jsonb,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved public.cass_property_lookup_outcomes%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and current_user not in ('postgres', 'supabase_admin')
  then
    raise exception using errcode = '42501', message = 'CASS_LOOKUP_SERVICE_ROLE_REQUIRED';
  end if;
  if p_state not in ('completed', 'retryable', 'ambiguous') then
    raise exception using errcode = '22023', message = 'CASS_LOOKUP_STATE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_job_id::text || ':' || p_property_id::text, 0));
  select saved.* into v_saved
  from public.cass_property_lookup_outcomes saved
  where saved.job_id = p_job_id
    and saved.org_id = p_org_id
    and saved.property_key = p_property_id
  for update;
  if v_saved.job_id is null then
    raise exception using errcode = '23514', message = 'CASS_LOOKUP_CLAIM_REQUIRED';
  end if;
  if v_saved.state <> 'submitting' then
    return v_saved.state = p_state
      and v_saved.outcome is not distinct from p_outcome
      and v_saved.result_payload is not distinct from p_result_payload;
  end if;
  update public.cass_property_lookup_outcomes
  set state = p_state, outcome = p_outcome, result_payload = p_result_payload,
      error_message = left(p_error_message, 2000), completed_at = now()
  where job_id = p_job_id and property_key = p_property_id;
  return true;
end;
$$;

revoke all on function public.complete_cass_property_lookup(
  uuid, uuid, uuid, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.complete_cass_property_lookup(
  uuid, uuid, uuid, text, text, jsonb, text
) to service_role;

-- A permanent-DNC false->true ratchet may alter only the flag itself (plus
-- the ordinary timestamp). It cannot smuggle a phone/name/org mutation past
-- the locked-contact guard in the same statement.
create or replace function public.reject_locked_property_contact_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  linked_is_locked boolean;
begin
  if tg_op = 'UPDATE'
    and new.do_not_contact is true
    and old.do_not_contact is false
  then
    if (to_jsonb(new) - array['do_not_contact', 'updated_at'])
      is distinct from (to_jsonb(old) - array['do_not_contact', 'updated_at'])
    then
      raise exception using errcode = 'P0001', message = 'DNC_RATCHET_ONLY';
    end if;
    return new;
  end if;

  perform 1 from public.properties property
  where property.homeowner_contact_id = old.id and property.org_id = old.org_id
  order by property.id
  for no key update;
  select exists (
    select 1 from public.properties property
    where property.homeowner_contact_id = old.id
      and property.org_id = old.org_id
      and property.is_dnc_locked
  ) into linked_is_locked;
  if linked_is_locked then
    raise exception using errcode = 'P0001', message = 'DNC_LOCKED: linked contact is read-only';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Retry authorization is a single row-lock transaction: membership lifecycle,
-- provenance, terminal status, and the row's own configurable retry budget are
-- all checked before the increment.
create or replace function public.claim_csv_import_retry(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
begin
  select job.* into v_job
  from public.jobs job
  where job.id = p_job_id
  for update;

  if v_job.id is null
    or v_job.type <> 'csv_import'
    or not exists (
      select 1 from public.memberships membership
      where membership.user_id = auth.uid()
        and membership.org_id = v_job.org_id
        and membership.access_status = 'active'
        and membership.deletion_prepared_at is null
        and (membership.access_expires_at is null or membership.access_expires_at > now())
    )
    or not exists (
      select 1 from public.csv_import_job_provenance provenance
      where provenance.job_id = v_job.id
        and provenance.org_id = v_job.org_id
        and provenance.csv_import_id = v_job.related_import_id
    )
    or v_job.status not in ('failed', 'partial', 'partially_completed')
    or v_job.error_class in ('validation', 'authorization')
    or v_job.retry_count >= v_job.max_retries
  then
    return false;
  end if;

  update public.jobs job
  set status = 'queued', error_class = null, error_message = null,
      completed_at = null, retry_count = job.retry_count + 1,
      worker_heartbeat_at = now()
  where job.id = v_job.id
    and job.org_id = v_job.org_id
    and job.retry_count < job.max_retries;
  return found;
end;
$$;

revoke all on function public.claim_csv_import_retry(uuid) from public, anon;
grant execute on function public.claim_csv_import_retry(uuid) to authenticated;

-- Browser clients may create a queued CSV job, but they may not manufacture a
-- retry budget or advance the retry state directly. SECURITY DEFINER workflow
-- RPCs and service workers remain the only authorities for these fields.
create or replace function public.protect_csv_import_job_controlled_fields()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.type = 'csv_import'
      and (
        new.status <> 'queued'
        or new.retry_count <> 0
        or new.max_retries <> 3
        or new.error_class is not null
      )
    then
      raise exception using errcode = '42501', message = 'CSV_IMPORT_JOB_CONTROLLED_FIELDS';
    end if;
    return new;
  end if;

  if (old.type = 'csv_import' or new.type = 'csv_import')
    and (
      new.type is distinct from old.type
      or new.status is distinct from old.status
      or new.retry_count is distinct from old.retry_count
      or new.max_retries is distinct from old.max_retries
      or new.error_class is distinct from old.error_class
    )
  then
    raise exception using errcode = '42501', message = 'CSV_IMPORT_JOB_CONTROLLED_FIELDS';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_protect_csv_import_controlled_fields on public.jobs;
create trigger jobs_protect_csv_import_controlled_fields
  before insert or update of type, status, retry_count, max_retries, error_class on public.jobs
  for each row execute function public.protect_csv_import_job_controlled_fields();

-- Resolve and create one skip-trace retry child in the same transaction. The
-- parent id is the stable request key: concurrent clicks and lost responses
-- return the same child, while a different target set is rejected instead of
-- acknowledging the wrong paid request.
create or replace function public.create_skip_trace_retry_job(
  p_parent_job_id uuid,
  p_property_ids uuid[]
)
returns table(job_id uuid, created boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(auth.role(), '');
  v_actor uuid := auth.uid();
  v_parent public.jobs%rowtype;
  v_existing public.jobs%rowtype;
  v_property_ids uuid[];
  v_authoritative_ids uuid[];
  v_existing_ids uuid[];
  v_has_error_items boolean;
  v_job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('skip-trace-retry:' || p_parent_job_id::text, 0));

  select parent.* into v_parent
  from public.jobs parent
  where parent.id = p_parent_job_id
  for update;

  if v_parent.id is null
    or v_parent.type <> 'skip_trace'
    or v_parent.status not in ('failed', 'partial')
  then
    raise exception using errcode = '55000', message = 'SKIP_TRACE_RETRY_PARENT_INVALID';
  end if;

  if v_role = 'authenticated' then
    if not exists (
      select 1 from public.memberships membership
      where membership.user_id = v_actor
        and membership.org_id = v_parent.org_id
        and membership.access_status = 'active'
        and membership.deletion_prepared_at is null
        and (membership.access_expires_at is null or membership.access_expires_at > now())
    ) then
      raise exception using errcode = '42501', message = 'SKIP_TRACE_ACTIVE_MEMBERSHIP_REQUIRED';
    end if;
  elsif v_role <> 'service_role' and current_user not in ('postgres', 'supabase_admin') then
    raise exception using errcode = '42501', message = 'SKIP_TRACE_RETRY_CALLER_NOT_AUTHORIZED';
  end if;

  select array_agg(distinct target order by target)
    into v_property_ids
  from unnest(coalesce(p_property_ids, array[]::uuid[])) target;
  if coalesce(cardinality(v_property_ids), 0) = 0 then
    raise exception using errcode = '22023', message = 'SKIP_TRACE_RETRY_PROPERTIES_REQUIRED';
  end if;

  select exists (
    select 1 from public.job_items item
    where item.job_id = v_parent.id and item.status = 'error' and item.property_id is not null
  ) into v_has_error_items;

  if v_has_error_items then
    select array_agg(distinct item.property_id order by item.property_id)
      into v_authoritative_ids
    from public.job_items item
    where item.job_id = v_parent.id
      and item.status = 'error'
      and item.property_id is not null
      and (
        item.error_class is null
        or item.error_class in (
          'provider_transient', 'provider_unknown', 'provider',
          'database', 'internal', 'transient'
        )
      );
  else
    if jsonb_typeof(v_parent.input_params->'submission_attempt_token') = 'string'
      or jsonb_typeof(v_parent.result_summary->'submit_phase') = 'string'
      or v_parent.provider_run_id is not null
      or v_parent.error_class = 'submission_unknown'
    then
      raise exception using errcode = '55000', message = 'SKIP_TRACE_RETRY_MANUAL_RECONCILIATION';
    end if;
    begin
      select array_agg(distinct value::uuid order by value::uuid)
        into v_authoritative_ids
      from jsonb_array_elements_text(v_parent.input_params->'property_ids') value;
    exception when others then
      raise exception using errcode = '22023', message = 'SKIP_TRACE_RETRY_LEGACY_INPUT_INVALID';
    end;
  end if;

  if v_authoritative_ids is null
    or v_property_ids is distinct from v_authoritative_ids
    or (
      select count(*) from public.properties property
      where property.id = any(v_property_ids)
        and property.org_id = v_parent.org_id
        and property.deleted_at is null
    ) <> cardinality(v_property_ids)
  then
    raise exception using errcode = '23514', message = 'SKIP_TRACE_RETRY_TARGETS_MISMATCH';
  end if;

  select child.* into v_existing
  from public.jobs child
  where child.org_id = v_parent.org_id
    and child.type = 'skip_trace'
    and (
      child.idempotency_key = v_parent.id
      or (child.parent_job_id = v_parent.id and child.status in ('queued', 'running'))
    )
  order by (child.idempotency_key = v_parent.id) desc, child.created_at asc
  limit 1
  for update;
  if found then
    begin
      select array_agg(distinct value::uuid order by value::uuid)
        into v_existing_ids
      from jsonb_array_elements_text(v_existing.input_params->'property_ids') value;
    exception when others then
      raise exception using errcode = '23514', message = 'SKIP_TRACE_RETRY_EXISTING_INPUT_INVALID';
    end;
    if v_existing.parent_job_id is distinct from v_parent.id
      or v_existing_ids is distinct from v_property_ids
    then
      raise exception using errcode = '23514', message = 'SKIP_TRACE_RETRY_REQUEST_CONFLICT';
    end if;
    return query select v_existing.id, false;
    return;
  end if;

  insert into public.jobs (
    type, provider, status, org_id, parent_job_id, created_by, total_items,
    title, description, input_params, idempotency_key
  ) values (
    'skip_trace', 'tracerfy', 'queued', v_parent.org_id, v_parent.id,
    case when v_role = 'authenticated' then v_actor else v_parent.created_by end,
    cardinality(v_property_ids),
    format('Retry skip-trace %s %s', cardinality(v_property_ids),
      case when cardinality(v_property_ids) = 1 then 'property' else 'properties' end),
    format('Retry of %s', left(v_parent.id::text, 8)),
    jsonb_build_object('property_ids', to_jsonb(v_property_ids)), v_parent.id
  ) returning id into v_job_id;

  return query select v_job_id, true;
end;
$$;

revoke all on function public.create_skip_trace_retry_job(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.create_skip_trace_retry_job(uuid, uuid[]) to service_role;

-- Make job/property tenant agreement structural. Composite FKs prevent a
-- later parent org transfer from invalidating an already-checked job item.
alter table public.job_items add column if not exists org_id uuid;
update public.job_items item
set org_id = job.org_id
from public.jobs job
where job.id = item.job_id and item.org_id is null;

do $$
begin
  if exists (
    select 1 from public.job_items item
    join public.jobs job on job.id = item.job_id
    left join public.properties property on property.id = item.property_id
    where item.org_id is distinct from job.org_id
      or (item.property_id is not null and property.org_id is distinct from job.org_id)
  ) then
    raise exception using errcode = '23514', message = 'EXISTING_JOB_ITEM_ORG_MISMATCH';
  end if;
end;
$$;

alter table public.job_items alter column org_id set not null;
-- The BEFORE trigger always derives this value. An explicit NULL default keeps
-- generated Insert types optional without inventing a tenant sentinel.
alter table public.job_items alter column org_id set default null;
alter table public.job_items drop constraint if exists job_items_job_id_fkey;
alter table public.job_items drop constraint if exists job_items_property_id_fkey;
alter table public.job_items drop constraint if exists job_items_job_org_fkey;
alter table public.job_items drop constraint if exists job_items_property_org_fkey;
alter table public.job_items add constraint job_items_job_org_fkey
  foreign key (job_id, org_id) references public.jobs(id, org_id) on delete cascade;
alter table public.job_items add constraint job_items_property_org_fkey
  foreign key (property_id, org_id) references public.properties(id, org_id)
    on delete set null (property_id);

-- Workflow steps may replay a whole chunk. A stable item key makes the result
-- row an idempotent ledger instead of incrementing counts twice.
drop index if exists public.idx_job_items_job_item_key;
create unique index idx_job_items_job_item_key
  on public.job_items (job_id, item_key);

create or replace function public.enforce_job_item_property_org()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  job_org_id uuid;
  property_org_id uuid;
begin
  select job.org_id into job_org_id
  from public.jobs job where job.id = new.job_id for key share;
  if not found then raise exception using errcode = '23503', message = 'JOB_NOT_FOUND'; end if;
  if new.org_id is not null and new.org_id is distinct from job_org_id then
    raise exception using errcode = '23514', message = 'JOB_ITEM_ORG_MISMATCH';
  end if;
  new.org_id := job_org_id;

  if new.property_id is not null then
    select property.org_id into property_org_id
    from public.properties property where property.id = new.property_id for key share;
    if not found then raise exception using errcode = '23503', message = 'PROPERTY_NOT_FOUND'; end if;
    if property_org_id is distinct from job_org_id then
      raise exception using errcode = '23514', message = 'JOB_ITEM_PROPERTY_ORG_MISMATCH';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_job_item_property_org on public.job_items;
create trigger enforce_job_item_property_org
  before insert or update of job_id, property_id, org_id on public.job_items
  for each row execute function public.enforce_job_item_property_org();

commit;
