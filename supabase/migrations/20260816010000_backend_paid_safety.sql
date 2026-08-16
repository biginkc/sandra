-- Final backend safety hardening for tenant-owned compliance rows, paid
-- enrichment boundaries, and permanent-DNC sequence history.

-- Ambiguous provider outcomes must be persisted as terminal/manual states.
-- Keep the database taxonomy aligned with the runner so the safety write
-- cannot itself be rejected after a provider may already have accepted work.
alter table public.jobs
  drop constraint if exists jobs_error_class_check;
alter table public.jobs
  add constraint jobs_error_class_check check (
    error_class is null or error_class = any (array[
      'validation', 'transient', 'provider', 'database',
      'authorization', 'configuration', 'submission_unknown'
    ])
  );

alter table public.job_items
  drop constraint if exists job_items_error_class_check;
alter table public.job_items
  add constraint job_items_error_class_check check (
    error_class is null or error_class = any (array[
      'validation', 'transient', 'provider', 'database',
      'authorization', 'configuration', 'internal',
      'provider_no_data', 'address_unverified', 'provider_transient',
      'provider_unknown', 'dnc_locked', 'submission_unknown',
      'provider_persist_failed'
    ])
  );

-- Contact-owned rows must always carry the contact's real organization.
-- This protects service-role/webhook writers as well as older application
-- code that still relies on the historical default org_id.
create or replace function public.sync_contact_owned_org_id()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  authoritative_org_id uuid;
begin
  select c.org_id into authoritative_org_id
  from public.contacts c
  where c.id = new.contact_id;
  if not found then
    raise exception using errcode = '23503', message = 'CONTACT_NOT_FOUND';
  end if;
  new.org_id := authoritative_org_id;
  return new;
end;
$$;

do $$
declare
  target text;
begin
  foreach target in array array['homeowner_details', 'agent_details', 'consent_events']
  loop
    if to_regclass('public.' || target) is not null then
      execute format('drop trigger if exists a_sync_contact_org on public.%I', target);
      execute format(
        'create trigger a_sync_contact_org before insert or update of contact_id, org_id on public.%I '
        || 'for each row execute function public.sync_contact_owned_org_id()',
        target
      );
    end if;
  end loop;
end;
$$;

-- Serialize paid enrichment with the permanent-DNC ratchet. The claim is a
-- short transaction at the actual provider boundary: contact first, property
-- second, matching contacts_propagate_true_dnc_lock's canonical lock order.
create or replace function public.claim_paid_property_enrichment(
  p_property_id uuid,
  p_org_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  initial_contact_id uuid;
  locked_contact_id uuid;
  property_locked boolean;
  contact_dnc boolean := false;
begin
  select p.homeowner_contact_id into initial_contact_id
  from public.properties p
  where p.id = p_property_id
    and p.org_id = p_org_id
    and p.deleted_at is null;
  if not found then return false; end if;

  if initial_contact_id is not null then
    perform 1 from public.contacts c
    where c.id = initial_contact_id and c.org_id = p_org_id
    for no key update;
  end if;

  select p.homeowner_contact_id, p.is_dnc_locked
    into locked_contact_id, property_locked
  from public.properties p
  where p.id = p_property_id
    and p.org_id = p_org_id
    and p.deleted_at is null
  for no key update;
  if not found or locked_contact_id is distinct from initial_contact_id then
    return false;
  end if;

  if locked_contact_id is not null then
    select coalesce(c.do_not_contact, false) into contact_dnc
    from public.contacts c
    where c.id = locked_contact_id and c.org_id = p_org_id;
    if not found then return false; end if;
  end if;
  return not coalesce(property_locked, true) and not contact_dnc;
end;
$$;

revoke all on function public.claim_paid_property_enrichment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_paid_property_enrichment(uuid, uuid)
  to service_role;

-- A skip-trace finalizer updates contacts after its provider response. Lock
-- every linked property in the same canonical order and reject the mutation
-- once true DNC has ratcheted. The DNC ratchet itself remains permitted.
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
    return new;
  end if;

  perform 1 from public.properties p
  where p.homeowner_contact_id = old.id and p.org_id = old.org_id
  order by p.id
  for no key update;
  select exists (
    select 1 from public.properties p
    where p.homeowner_contact_id = old.id
      and p.org_id = old.org_id
      and p.is_dnc_locked
  ) into linked_is_locked;
  if linked_is_locked then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: linked contact is read-only';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists contacts_reject_dnc_locked_property on public.contacts;
create trigger contacts_reject_dnc_locked_property
  before update or delete on public.contacts
  for each row execute function public.reject_locked_property_contact_mutation();

create or replace function public.reject_locked_property_contact_sidecar()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  candidate_contact_id uuid;
  candidate_org_id uuid;
  property_is_locked boolean;
begin
  for candidate_contact_id, candidate_org_id in
    select distinct candidate.contact_id, candidate.org_id
    from (values
      (
        case when tg_op <> 'INSERT' then old.contact_id else null end,
        case when tg_op <> 'INSERT' then old.org_id else null end
      ),
      (
        case when tg_op <> 'DELETE' then new.contact_id else null end,
        case when tg_op <> 'DELETE' then new.org_id else null end
      )
    ) as candidate(contact_id, org_id)
    where candidate.contact_id is not null and candidate.org_id is not null
    order by candidate.contact_id, candidate.org_id
  loop
    perform 1 from public.contacts c
    where c.id = candidate_contact_id and c.org_id = candidate_org_id
    for no key update;
    perform 1 from public.properties p
    where p.homeowner_contact_id = candidate_contact_id
      and p.org_id = candidate_org_id
    order by p.id
    for no key update;
    select exists (
      select 1 from public.properties p
      where p.homeowner_contact_id = candidate_contact_id
        and p.org_id = candidate_org_id
        and p.is_dnc_locked
    ) into property_is_locked;
    if property_is_locked then
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: linked contact details are read-only';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
declare
  target text;
begin
  foreach target in array array['homeowner_details', 'agent_details']
  loop
    if to_regclass('public.' || target) is not null then
      execute format('drop trigger if exists z_reject_dnc_locked_property on public.%I', target);
      execute format(
        'create trigger z_reject_dnc_locked_property before insert or update or delete on public.%I '
        || 'for each row execute function public.reject_locked_property_contact_sidecar()',
        target
      );
    end if;
  end loop;
end;
$$;

-- Handle INSERT/UPDATE/DELETE without dereferencing an unavailable NEW row.
-- On a locked property the only permitted mutation is the exact compliance
-- stop: active/paused -> opted_out with a DNC/consent-revoked reason. No
-- linkage, sequencing, progress, or historical fields may change.
create or replace function public.guard_locked_property_sequence_enrollment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  property_id uuid;
  property_is_locked boolean;
begin
  for property_id in
    select distinct candidate
    from unnest(array[
      case when tg_op <> 'INSERT' then old.property_id else null end,
      case when tg_op <> 'DELETE' then new.property_id else null end
    ]) as candidates(candidate)
    where candidate is not null
    order by candidate
  loop
    select p.is_dnc_locked into property_is_locked
    from public.properties p
    where p.id = property_id
    for no key update;
    if coalesce(property_is_locked, false) then
      if tg_op = 'UPDATE'
        and old.status in ('active', 'paused')
        and new.status = 'opted_out'
        and new.pause_reason in ('dnc', 'consent_revoked')
        and new.next_run_at is null
        and (
          to_jsonb(new) - array['status', 'pause_reason', 'next_run_at', 'updated_at']::text[]
        ) = (
          to_jsonb(old) - array['status', 'pause_reason', 'next_run_at', 'updated_at']::text[]
        )
      then
        return new;
      end if;
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: sequence enrollment is immutable except for the compliance opt-out';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
begin
  if to_regclass('public.sequence_enrollments') is not null then
    drop trigger if exists sequence_enrollments_reject_dnc_locked
      on public.sequence_enrollments;
    create trigger sequence_enrollments_reject_dnc_locked
      before insert or update or delete on public.sequence_enrollments
      for each row execute function public.guard_locked_property_sequence_enrollment();
  end if;
end;
$$;

create or replace function public.protect_locked_sequence_step_audit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  candidate_enrollment_id uuid;
begin
  for candidate_enrollment_id in
    select distinct candidate
    from unnest(array[
      old.enrollment_id,
      case when tg_op = 'UPDATE' then new.enrollment_id else null end
    ]) as candidates(candidate)
    where candidate is not null
    order by candidate
  loop
    if exists (
      select 1
      from public.sequence_enrollments e
      join public.properties p on p.id = e.property_id
      where e.id = candidate_enrollment_id and p.is_dnc_locked
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: sequence step audit history cannot be changed';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
begin
  if to_regclass('public.sequence_step_runs') is not null then
    drop trigger if exists sequence_step_runs_protect_dnc_audit
      on public.sequence_step_runs;
    create trigger sequence_step_runs_protect_dnc_audit
      before update or delete on public.sequence_step_runs
      for each row execute function public.protect_locked_sequence_step_audit();
  end if;
end;
$$;
