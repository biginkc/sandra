-- Durable, per-number checkpoints for paid Telnyx classification during CSV
-- imports. A workflow replay reuses terminal outcomes; a request whose paid
-- boundary is ambiguous is quarantined; an explicit provider rejection can be
-- attempted again only after the job's atomic retry_count advances.

begin;

create table if not exists public.csv_import_line_type_outcomes (
  job_id uuid not null,
  org_id uuid not null,
  phone_e164 text not null,
  state text not null
    check (state in ('submitting', 'completed', 'retryable', 'ambiguous')),
  line_type text
    check (line_type is null or line_type in ('mobile', 'landline', 'unknown')),
  outcome text
    check (
      outcome is null
      or outcome in (
        'classified',
        'definitive_unknown',
        'provider_rejected',
        'transport_unknown'
      )
    ),
  provider_http_status integer,
  job_retry_count integer not null check (job_retry_count >= 0),
  lookup_attempts integer not null default 1 check (lookup_attempts > 0),
  last_error text,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (job_id, phone_e164),
  constraint csv_import_line_type_outcomes_job_org_fkey
    foreign key (job_id, org_id)
    references public.jobs(id, org_id)
    on delete cascade,
  constraint csv_import_line_type_outcomes_phone_check
    check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint csv_import_line_type_outcomes_terminal_check
    check (
      (state = 'submitting' and line_type is null and outcome is null and completed_at is null)
      or (state = 'completed' and line_type is not null and outcome in ('classified', 'definitive_unknown') and completed_at is not null)
      or (state = 'retryable' and line_type = 'unknown' and outcome = 'provider_rejected' and completed_at is not null)
      or (state = 'ambiguous' and line_type = 'unknown' and outcome = 'transport_unknown' and completed_at is not null)
    )
);

alter table public.csv_import_line_type_outcomes enable row level security;
revoke all on public.csv_import_line_type_outcomes from public, anon, authenticated;
grant all on public.csv_import_line_type_outcomes to service_role;

create index if not exists csv_import_line_type_outcomes_job_state_idx
  on public.csv_import_line_type_outcomes(job_id, state);

create or replace function public.claim_csv_import_line_type_lookup(
  p_job_id uuid,
  p_org_id uuid,
  p_phone_e164 text
)
returns table(action text, line_type text, outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_existing public.csv_import_line_type_outcomes%rowtype;
begin
  select j.* into v_job
  from public.jobs j
  where j.id = p_job_id and j.org_id = p_org_id
  for update;

  if v_job.id is null
    or v_job.type <> 'csv_import'
    or v_job.status not in ('queued', 'running')
    or not exists (
      select 1
      from public.csv_import_job_provenance provenance
      where provenance.job_id = v_job.id
        and provenance.org_id = v_job.org_id
        and provenance.classify_line_types = true
    )
  then
    raise exception 'CSV_IMPORT_LINE_TYPE_JOB_NOT_ELIGIBLE';
  end if;

  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'CSV_IMPORT_LINE_TYPE_PHONE_INVALID';
  end if;

  select ledger.* into v_existing
  from public.csv_import_line_type_outcomes ledger
  where ledger.job_id = p_job_id and ledger.phone_e164 = p_phone_e164
  for update;

  if v_existing.job_id is null then
    insert into public.csv_import_line_type_outcomes (
      job_id,
      org_id,
      phone_e164,
      state,
      job_retry_count,
      lookup_attempts
    ) values (
      v_job.id,
      v_job.org_id,
      p_phone_e164,
      'submitting',
      v_job.retry_count,
      1
    );
    return query select 'claimed'::text, null::text, null::text;
    return;
  end if;

  if v_existing.org_id <> v_job.org_id then
    raise exception 'CSV_IMPORT_LINE_TYPE_ORG_MISMATCH';
  end if;

  if v_existing.state = 'completed' then
    return query
      select 'reused'::text, v_existing.line_type, v_existing.outcome;
    return;
  end if;

  if v_existing.state in ('submitting', 'ambiguous') then
    return query
      select 'ambiguous'::text, 'unknown'::text, 'transport_unknown'::text;
    return;
  end if;

  if v_existing.state = 'retryable'
    and v_job.retry_count > v_existing.job_retry_count
  then
    update public.csv_import_line_type_outcomes ledger
    set state = 'submitting',
        line_type = null,
        outcome = null,
        provider_http_status = null,
        job_retry_count = v_job.retry_count,
        lookup_attempts = ledger.lookup_attempts + 1,
        last_error = null,
        claimed_at = now(),
        completed_at = null
    where ledger.job_id = p_job_id and ledger.phone_e164 = p_phone_e164;
    return query select 'claimed'::text, null::text, null::text;
    return;
  end if;

  return query
    select 'retry_blocked'::text, 'unknown'::text, v_existing.outcome;
end;
$$;

revoke all on function public.claim_csv_import_line_type_lookup(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_csv_import_line_type_lookup(uuid, uuid, text)
  to service_role;

create or replace function public.complete_csv_import_line_type_lookup(
  p_job_id uuid,
  p_org_id uuid,
  p_phone_e164 text,
  p_state text,
  p_line_type text,
  p_outcome text,
  p_provider_http_status integer default null,
  p_last_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_existing public.csv_import_line_type_outcomes%rowtype;
begin
  if p_state not in ('completed', 'retryable', 'ambiguous')
    or p_line_type not in ('mobile', 'landline', 'unknown')
    or (p_state = 'completed' and p_outcome not in ('classified', 'definitive_unknown'))
    or (p_state = 'retryable' and (p_line_type <> 'unknown' or p_outcome <> 'provider_rejected'))
    or (p_state = 'ambiguous' and (p_line_type <> 'unknown' or p_outcome <> 'transport_unknown'))
  then
    raise exception 'CSV_IMPORT_LINE_TYPE_OUTCOME_INVALID';
  end if;

  select j.* into v_job
  from public.jobs j
  where j.id = p_job_id and j.org_id = p_org_id
  for update;
  if v_job.id is null or v_job.type <> 'csv_import' then
    raise exception 'CSV_IMPORT_LINE_TYPE_JOB_NOT_FOUND';
  end if;

  select ledger.* into v_existing
  from public.csv_import_line_type_outcomes ledger
  where ledger.job_id = p_job_id
    and ledger.org_id = p_org_id
    and ledger.phone_e164 = p_phone_e164
  for update;
  if v_existing.job_id is null then
    raise exception 'CSV_IMPORT_LINE_TYPE_CLAIM_NOT_FOUND';
  end if;

  if v_existing.state <> 'submitting' then
    if v_existing.state = p_state
      and v_existing.line_type = p_line_type
      and v_existing.outcome = p_outcome
      and v_existing.provider_http_status is not distinct from p_provider_http_status
    then
      return;
    end if;
    raise exception 'CSV_IMPORT_LINE_TYPE_OUTCOME_CONFLICT';
  end if;

  if v_existing.job_retry_count <> v_job.retry_count then
    raise exception 'CSV_IMPORT_LINE_TYPE_RETRY_FENCE_LOST';
  end if;

  update public.csv_import_line_type_outcomes ledger
  set state = p_state,
      line_type = p_line_type,
      outcome = p_outcome,
      provider_http_status = p_provider_http_status,
      last_error = left(p_last_error, 1000),
      completed_at = now()
  where ledger.job_id = p_job_id
    and ledger.org_id = p_org_id
    and ledger.phone_e164 = p_phone_e164;
end;
$$;

revoke all on function public.complete_csv_import_line_type_lookup(
  uuid, uuid, text, text, text, text, integer, text
) from public, anon, authenticated;
grant execute on function public.complete_csv_import_line_type_lookup(
  uuid, uuid, text, text, text, text, integer, text
) to service_role;

commit;
