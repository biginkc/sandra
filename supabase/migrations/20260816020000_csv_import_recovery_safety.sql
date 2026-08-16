-- CSV import retry provenance, terminal failure recovery, and per-row outcome
-- idempotency. All workflow mutations remain service-role-only; authenticated
-- users can claim a retry only through the tenant-checked RPC below.

begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.jobs'::regclass
      and conname = 'jobs_id_org_id_key'
  ) then
    alter table public.jobs
      add constraint jobs_id_org_id_key unique (id, org_id);
  end if;
end
$$;

create table if not exists public.csv_import_job_provenance (
  job_id uuid primary key,
  org_id uuid not null,
  csv_import_id uuid not null,
  storage_path text not null,
  source text not null,
  market text not null,
  county_id uuid not null,
  mapping jsonb not null,
  list_id uuid,
  requested_by uuid,
  sms_consent boolean not null default false,
  sequence_id uuid,
  classify_line_types boolean not null default false,
  request_cass boolean not null default false,
  dataset_sha256 text not null,
  review_contract_sha256 text not null,
  dataset_version integer not null,
  expected_total_rows integer not null,
  expected_dnc_rows integer not null default 0,
  list_name text,
  list_resolution_error text,
  created_at timestamptz not null default now(),
  constraint csv_import_job_provenance_job_org_fkey
    foreign key (job_id, org_id) references public.jobs(id, org_id) on delete cascade,
  constraint csv_import_job_provenance_import_org_fkey
    foreign key (csv_import_id, org_id) references public.csv_imports(id, org_id),
  constraint csv_import_job_provenance_list_fkey
    foreign key (list_id) references public.lists(id),
  constraint csv_import_job_provenance_sequence_fkey
    foreign key (sequence_id) references public.sequences(id),
  constraint csv_import_job_provenance_dataset_sha_check
    check (dataset_sha256 ~ '^[a-f0-9]{64}$'),
  constraint csv_import_job_provenance_review_sha_check
    check (review_contract_sha256 ~ '^[a-f0-9]{64}$'),
  constraint csv_import_job_provenance_storage_scope_check
    check (storage_path like org_id::text || '/%'),
  constraint csv_import_job_provenance_counts_check
    check (
      expected_total_rows >= 0
      and expected_dnc_rows >= 0
      and expected_dnc_rows <= expected_total_rows
    )
);

alter table public.csv_import_job_provenance enable row level security;
drop policy if exists csv_import_job_provenance_org_select
  on public.csv_import_job_provenance;
create policy csv_import_job_provenance_org_select
  on public.csv_import_job_provenance
  for select to authenticated
  using (
    org_id in (
      select m.org_id from public.memberships m where m.user_id = auth.uid()
    )
  );
revoke insert, update, delete on public.csv_import_job_provenance from anon, authenticated;
grant select on public.csv_import_job_provenance to authenticated;
grant all on public.csv_import_job_provenance to service_role;

create table if not exists public.csv_import_row_outcomes (
  job_id uuid not null,
  source_row_index integer not null,
  org_id uuid not null,
  csv_import_id uuid not null,
  property_id uuid not null references public.properties(id),
  original_outcome text not null check (original_outcome in ('inserted', 'duplicate')),
  created_at timestamptz not null default now(),
  primary key (job_id, source_row_index),
  constraint csv_import_row_outcomes_job_org_fkey
    foreign key (job_id, org_id) references public.jobs(id, org_id) on delete cascade,
  constraint csv_import_row_outcomes_import_org_fkey
    foreign key (csv_import_id, org_id) references public.csv_imports(id, org_id)
);

alter table public.csv_import_row_outcomes enable row level security;
revoke all on public.csv_import_row_outcomes from anon, authenticated;
grant all on public.csv_import_row_outcomes to service_role;

create or replace function public.claim_csv_import_retry(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
begin
  select j.* into v_job
  from public.jobs j
  where j.id = p_job_id
  for update;

  if v_job.id is null
    or v_job.type <> 'csv_import'
    or not exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid() and m.org_id = v_job.org_id
    )
    or not exists (
      select 1 from public.csv_import_job_provenance p
      where p.job_id = v_job.id
        and p.org_id = v_job.org_id
        and p.csv_import_id = v_job.related_import_id
    )
  then
    return false;
  end if;

  if v_job.status not in ('failed', 'partial', 'partially_completed') then
    return false;
  end if;
  if v_job.error_class in ('validation', 'authorization') then
    return false;
  end if;

  update public.jobs j
  set status = 'queued',
      error_class = null,
      error_message = null,
      completed_at = null,
      retry_count = j.retry_count + 1,
      worker_heartbeat_at = now()
  where j.id = v_job.id and j.org_id = v_job.org_id;
  return true;
end;
$$;

revoke all on function public.claim_csv_import_retry(uuid) from public, anon;
grant execute on function public.claim_csv_import_retry(uuid) to authenticated;

create or replace function public.fail_csv_import_workflow(
  p_job_id uuid,
  p_csv_import_id uuid,
  p_org_id uuid,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_success integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
  v_processed integer := 0;
  v_status text;
  v_summary jsonb;
begin
  select j.* into v_job
  from public.jobs j
  where j.id = p_job_id
    and j.org_id = p_org_id
    and j.type = 'csv_import'
    and j.related_import_id = p_csv_import_id
  for update;
  if v_job.id is null then
    raise exception 'CSV import job identity mismatch';
  end if;
  if v_job.status = 'failed' and v_job.error_class in ('validation', 'authorization') then
    return coalesce(v_job.result_summary, '{}'::jsonb) ||
      jsonb_build_object('status', v_job.status, 'retryable', false);
  end if;

  select
    count(*) filter (where ji.status = 'success')::integer,
    count(*) filter (where ji.status = 'skipped')::integer,
    count(*) filter (where ji.status = 'error')::integer,
    count(*)::integer
  into v_success, v_skipped, v_failed, v_processed
  from public.job_items ji
  where ji.job_id = p_job_id;

  v_status := case when v_success + v_skipped > 0 then 'partial' else 'failed' end;
  v_summary := coalesce(v_job.result_summary, '{}'::jsonb) || jsonb_build_object(
    'succeeded', v_success,
    'skipped', v_skipped,
    'failed', v_failed,
    'workflowFailure', jsonb_build_object(
      'retryable', true,
      'message', left(coalesce(p_message, 'CSV import workflow failed'), 2000)
    )
  );

  update public.jobs j
  set status = v_status,
      processed_items = v_processed,
      succeeded_items = v_success,
      failed_items = v_failed,
      error_class = 'transient',
      error_message = left(coalesce(p_message, 'CSV import workflow failed'), 2000),
      result_summary = v_summary,
      worker_heartbeat_at = now(),
      completed_at = now()
  where j.id = p_job_id and j.org_id = p_org_id and j.type = 'csv_import';

  update public.csv_imports i
  set inserted_properties = v_success,
      skipped_duplicates = v_skipped,
      failed_rows = v_failed
  where i.id = p_csv_import_id and i.org_id = p_org_id;

  return v_summary || jsonb_build_object('status', v_status);
end;
$$;

revoke all on function public.fail_csv_import_workflow(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_csv_import_workflow(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.checkpoint_csv_import_property_outcome(
  p_job_id uuid,
  p_csv_import_id uuid,
  p_org_id uuid,
  p_source_row_index integer,
  p_property jsonb,
  p_existing_property_id uuid default null,
  p_existing_patch jsonb default '{}'::jsonb
)
returns table(property_id uuid, original_outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.csv_import_row_outcomes%rowtype;
  v_property_id uuid;
  v_outcome text;
begin
  if p_source_row_index < 0 then
    raise exception 'CSV source row index must be non-negative';
  end if;
  if not exists (
    select 1 from public.jobs j
    join public.csv_imports i
      on i.id = j.related_import_id and i.org_id = j.org_id
    where j.id = p_job_id
      and j.org_id = p_org_id
      and j.type = 'csv_import'
      and i.id = p_csv_import_id
  ) then
    raise exception 'CSV import row identity mismatch';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_job_id::text || ':' || p_source_row_index::text, 0)
  );
  select o.* into v_existing
  from public.csv_import_row_outcomes o
  where o.job_id = p_job_id and o.source_row_index = p_source_row_index;
  if v_existing.job_id is not null then
    return query select v_existing.property_id, v_existing.original_outcome;
    return;
  end if;

  if p_existing_property_id is null then
    insert into public.properties (
      org_id, status, address, city, state, zip, market, county_id,
      fips_code, apn, apn_normalized, zpid, mls_number,
      address_normalized, beds, baths, sqft, year_built, listing_price,
      arv, repair_estimate, mortgage_balance, equity_estimate, lat, lon,
      source, source_import_id, source_imported_at,
      homeowner_contact_id, agent_contact_id, outreach_dispo
    ) values (
      p_org_id,
      coalesce(nullif(p_property->>'status', ''), 'prospect'),
      p_property->>'address',
      nullif(p_property->>'city', ''),
      p_property->>'state',
      nullif(p_property->>'zip', ''),
      nullif(p_property->>'market', ''),
      nullif(p_property->>'county_id', '')::uuid,
      nullif(p_property->>'fips_code', ''),
      nullif(p_property->>'apn', ''),
      nullif(p_property->>'apn_normalized', ''),
      nullif(p_property->>'zpid', ''),
      nullif(p_property->>'mls_number', ''),
      nullif(p_property->>'address_normalized', ''),
      nullif(p_property->>'beds', '')::numeric,
      nullif(p_property->>'baths', '')::numeric,
      nullif(p_property->>'sqft', '')::numeric,
      nullif(p_property->>'year_built', '')::integer,
      nullif(p_property->>'listing_price', '')::numeric,
      nullif(p_property->>'arv', '')::numeric,
      nullif(p_property->>'repair_estimate', '')::numeric,
      nullif(p_property->>'mortgage_balance', '')::numeric,
      nullif(p_property->>'equity_estimate', '')::numeric,
      nullif(p_property->>'lat', '')::numeric,
      nullif(p_property->>'lon', '')::numeric,
      nullif(p_property->>'source', ''),
      p_csv_import_id,
      coalesce(nullif(p_property->>'source_imported_at', '')::timestamptz, now()),
      nullif(p_property->>'homeowner_contact_id', '')::uuid,
      nullif(p_property->>'agent_contact_id', '')::uuid,
      nullif(p_property->>'outreach_dispo', '')
    ) returning id into v_property_id;
    v_outcome := 'inserted';
  else
    update public.properties p
    set source_import_id = p_csv_import_id,
        source_imported_at = coalesce(
          nullif(p_existing_patch->>'source_imported_at', '')::timestamptz,
          now()
        ),
        homeowner_contact_id = coalesce(
          p.homeowner_contact_id,
          nullif(p_existing_patch->>'homeowner_contact_id', '')::uuid
        ),
        agent_contact_id = coalesce(
          p.agent_contact_id,
          nullif(p_existing_patch->>'agent_contact_id', '')::uuid
        ),
        outreach_dispo = case
          when p_existing_patch->>'outreach_dispo' = 'dnc' then 'dnc'
          else p.outreach_dispo
        end
    where p.id = p_existing_property_id and p.org_id = p_org_id
    returning p.id into v_property_id;
    if v_property_id is null then
      raise exception 'Existing CSV property does not belong to the import organization';
    end if;
    v_outcome := 'duplicate';
  end if;

  insert into public.csv_import_row_outcomes (
    job_id, source_row_index, org_id, csv_import_id, property_id, original_outcome
  ) values (
    p_job_id, p_source_row_index, p_org_id, p_csv_import_id, v_property_id, v_outcome
  );

  return query select v_property_id, v_outcome;
end;
$$;

revoke all on function public.checkpoint_csv_import_property_outcome(
  uuid, uuid, uuid, integer, jsonb, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.checkpoint_csv_import_property_outcome(
  uuid, uuid, uuid, integer, jsonb, uuid, jsonb
) to service_role;

commit;
