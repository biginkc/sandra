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

-- Preserve an informational source key on the consent event, but do not use
-- this member-writable table as the authority for import idempotency. An org
-- member could otherwise pre-insert the key and suppress the real audit row.
alter table public.consent_events
  add column if not exists idempotency_key text;

-- This service-only ledger is the import consent authority. Its composite key
-- makes a job/contact/org append exactly once across workflow exhaustion and
-- retry, and the trigger keeps even privileged maintenance from rewriting the
-- historical outcome in place.
create table if not exists public.csv_import_consent_outcomes (
  job_id uuid not null,
  contact_id uuid not null,
  org_id uuid not null,
  consent_event_id uuid not null unique references public.consent_events(id),
  created_at timestamptz not null default now(),
  primary key (job_id, contact_id, org_id),
  constraint csv_import_consent_outcomes_job_org_fkey
    foreign key (job_id, org_id) references public.jobs(id, org_id),
  constraint csv_import_consent_outcomes_contact_org_fkey
    foreign key (contact_id, org_id) references public.contacts(id, org_id)
);

alter table public.csv_import_consent_outcomes enable row level security;
revoke all on public.csv_import_consent_outcomes from anon, authenticated;
grant all on public.csv_import_consent_outcomes to service_role;

create or replace function public.reject_csv_import_consent_outcome_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'CSV import consent outcomes are immutable';
end;
$$;

drop trigger if exists csv_import_consent_outcomes_immutable
  on public.csv_import_consent_outcomes;
create trigger csv_import_consent_outcomes_immutable
  before update or delete on public.csv_import_consent_outcomes
  for each row execute function public.reject_csv_import_consent_outcome_mutation();

create or replace function public.reject_csv_import_consent_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.csv_import_consent_outcomes outcome
    where outcome.consent_event_id = old.id
  ) then
    raise exception 'CSV import consent events are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists csv_import_consent_events_immutable
  on public.consent_events;
create trigger csv_import_consent_events_immutable
  before update or delete on public.consent_events
  for each row execute function public.reject_csv_import_consent_event_mutation();

create or replace function public.lock_csv_import_consent_org(p_org_id uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select pg_advisory_xact_lock(
    hashtextextended(
      'csv-import-consent:' || p_org_id::text,
      0
    )
  );
$$;
revoke all on function public.lock_csv_import_consent_org(uuid)
  from public, anon, authenticated;

create or replace function public.serialize_contact_safety_before_csv_consent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.do_not_contact and not old.do_not_contact)
    or (new.sms_opted_out and not old.sms_opted_out)
  then
    perform public.lock_csv_import_consent_org(new.org_id);
  end if;
  return new;
end;
$$;
drop trigger if exists aa_serialize_contact_safety_before_csv_consent
  on public.contacts;
create trigger aa_serialize_contact_safety_before_csv_consent
  before update on public.contacts
  for each row execute function public.serialize_contact_safety_before_csv_consent();

create or replace function public.serialize_property_safety_before_csv_consent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.homeowner_contact_id is not null
    and (
      (new.is_dnc_locked and not old.is_dnc_locked)
      or new.outreach_dispo in ('wrong_number', 'bad_number', 'dnc', 'opted_out')
    )
  then
    perform public.lock_csv_import_consent_org(new.org_id);
  end if;
  return new;
end;
$$;
drop trigger if exists zz_serialize_property_safety_before_csv_consent
  on public.properties;
create trigger zz_serialize_property_safety_before_csv_consent
  before update on public.properties
  for each row execute function public.serialize_property_safety_before_csv_consent();

create or replace function public.serialize_consent_safety_before_csv_consent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.event_type in ('opt_out', 'provider_auto_opt_out') then
    perform public.lock_csv_import_consent_org(new.org_id);
  end if;
  return new;
end;
$$;
drop trigger if exists aa_serialize_consent_safety_before_csv_consent
  on public.consent_events;
create trigger aa_serialize_consent_safety_before_csv_consent
  before insert or update on public.consent_events
  for each row execute function public.serialize_consent_safety_before_csv_consent();

create or replace function public.serialize_phone_suppression_before_csv_consent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
begin
  if tg_op = 'DELETE' then
    v_org_id := old.org_id;
  else
    v_org_id := new.org_id;
  end if;
  perform public.lock_csv_import_consent_org(v_org_id);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists aa_serialize_phone_suppression_before_csv_consent
  on public.sms_phone_suppressions;
create trigger aa_serialize_phone_suppression_before_csv_consent
  before insert or update or delete on public.sms_phone_suppressions
  for each row execute function public.serialize_phone_suppression_before_csv_consent();

create or replace function public.record_csv_import_consents(
  p_job_id uuid,
  p_org_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer := 0;
begin
  if not exists (
    select 1
    from public.jobs j
    join public.csv_import_job_provenance provenance
      on provenance.job_id = j.id
      and provenance.org_id = j.org_id
      and provenance.csv_import_id = j.related_import_id
    where j.id = p_job_id
      and j.org_id = p_org_id
      and j.type = 'csv_import'
      and provenance.sms_consent
  ) then
    raise exception 'CSV consent job identity mismatch';
  end if;

  -- Serialize only consent/safety transitions within this organization. The
  -- triggers above take the same advisory lock for STOP, DNC, disposition, and
  -- durable phone-suppression writes. Re-read every source below after taking
  -- it: a concurrent safety write either commits first and excludes the
  -- contact, or waits until this transaction writes the event and ledger.
  perform public.lock_csv_import_consent_org(p_org_id);

  with eligible as materialized (
    select distinct c.id as contact_id
    from public.csv_import_row_outcomes outcome
    join public.properties p
      on p.id = outcome.property_id and p.org_id = outcome.org_id
    join public.contacts c
      on c.id = p.homeowner_contact_id and c.org_id = p.org_id
    where outcome.job_id = p_job_id
      and outcome.org_id = p_org_id
      and not p.is_dnc_locked
      and (
        p.outreach_dispo is null
        or p.outreach_dispo not in ('wrong_number', 'bad_number', 'dnc', 'opted_out')
      )
      and not c.do_not_contact
      and not c.sms_opted_out
      and not exists (
        select 1
        from public.consent_events prior
        where prior.contact_id = c.id
          and prior.org_id = p_org_id
          and prior.event_type in ('opt_out', 'provider_auto_opt_out')
      )
      and not exists (
        select 1
        from public.sms_phone_suppressions suppression
        where suppression.org_id = p_org_id
          and suppression.channel = 'sms'
          and suppression.phone_e164 in (c.phone_1, c.phone_2, c.phone_3)
      )
      and not exists (
        select 1
        from public.csv_import_consent_outcomes recorded
        where recorded.job_id = p_job_id
          and recorded.contact_id = c.id
          and recorded.org_id = p_org_id
      )
  ), inserted_events as (
    insert into public.consent_events (
      contact_id, org_id, channel, event_type, source, idempotency_key,
      occurred_at
    )
    select
      eligible.contact_id,
      p_org_id,
      'sms',
      'opt_in_marketing_written',
      'import_attestation:job:' || p_job_id::text,
      'csv-import:' || p_job_id::text || ':contact:' || eligible.contact_id::text,
      now()
    from eligible
    returning id, contact_id
  ), inserted_outcomes as (
    insert into public.csv_import_consent_outcomes (
      job_id, contact_id, org_id, consent_event_id
    )
    select p_job_id, event.contact_id, p_org_id, event.id
    from inserted_events event
    returning 1
  )
  select count(*)::integer into v_inserted from inserted_outcomes;

  return v_inserted;
end;
$$;

revoke all on function public.record_csv_import_consents(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.record_csv_import_consents(uuid, uuid)
  to service_role;

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
  v_dnc_locked integer := 0;
  v_reviewed_dnc integer := 0;
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
    count(*)::integer,
    count(*) filter (
      where ji.compliance_locked and ji.property_id is not null
    )::integer
  into v_success, v_skipped, v_failed, v_processed, v_dnc_locked
  from public.job_items ji
  where ji.job_id = p_job_id;

  select coalesce(provenance.expected_dnc_rows, 0)
  into v_reviewed_dnc
  from public.csv_import_job_provenance provenance
  where provenance.job_id = p_job_id
    and provenance.org_id = p_org_id
    and provenance.csv_import_id = p_csv_import_id;

  v_status := case when v_success + v_skipped > 0 then 'partial' else 'failed' end;
  v_summary := coalesce(v_job.result_summary, '{}'::jsonb) || jsonb_build_object(
    'succeeded', v_success,
    'skipped', v_skipped,
    'failed', v_failed,
    'dncRows', v_dnc_locked,
    'reviewedDncRows', coalesce(v_reviewed_dnc, 0),
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
returns table(property_id uuid, original_outcome text, compliance_locked boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.csv_import_row_outcomes%rowtype;
  v_property_id uuid;
  v_outcome text;
  v_property_is_locked boolean;
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
    select p.is_dnc_locked into v_property_is_locked
    from public.properties p
    where p.id = v_existing.property_id and p.org_id = p_org_id;
    return query select
      v_existing.property_id,
      v_existing.original_outcome,
      coalesce(v_property_is_locked, false);
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
    ) returning id, is_dnc_locked into v_property_id, v_property_is_locked;
    v_outcome := 'inserted';
  else
    select p.is_dnc_locked into v_property_is_locked
    from public.properties p
    where p.id = p_existing_property_id and p.org_id = p_org_id
    for no key update;
    if not found then
      raise exception 'Existing CSV property does not belong to the import organization';
    end if;

    if v_property_is_locked then
      -- Contact-DNC propagation may have locked this exact duplicate before
      -- the checkpoint RPC began. The compliance result is already durable;
      -- do not mutate the immutable property, but do preserve the truthful
      -- duplicate outcome so retry is a replay instead of a permanent error.
      v_property_id := p_existing_property_id;
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
      returning p.id, p.is_dnc_locked into v_property_id, v_property_is_locked;
      if v_property_id is null then
        raise exception 'Existing CSV property changed before its outcome checkpoint';
      end if;
    end if;
    v_outcome := 'duplicate';
  end if;

  insert into public.csv_import_row_outcomes (
    job_id, source_row_index, org_id, csv_import_id, property_id, original_outcome
  ) values (
    p_job_id, p_source_row_index, p_org_id, p_csv_import_id, v_property_id, v_outcome
  );

  return query select v_property_id, v_outcome, coalesce(v_property_is_locked, false);
end;
$$;

revoke all on function public.checkpoint_csv_import_property_outcome(
  uuid, uuid, uuid, integer, jsonb, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.checkpoint_csv_import_property_outcome(
  uuid, uuid, uuid, integer, jsonb, uuid, jsonb
) to service_role;

commit;
