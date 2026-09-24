-- A campaign may target several verified source contacts for the same
-- property (for example, Assigns' independently supplied contact blocks).
-- Keep legacy null-contact rows unique as well: a retry must not manufacture
-- another placeholder recipient or outbound message.
alter table public.campaign_recipients
  drop constraint if exists campaign_recipients_campaign_id_property_id_key;

create unique index if not exists idx_campaign_recipients_campaign_property_contact_unique
  on public.campaign_recipients (campaign_id, property_id, contact_id) nulls not distinct;

drop index if exists public.idx_messages_campaign_property_unique;

create unique index if not exists idx_messages_campaign_property_contact_unique
  on public.messages (campaign_id, property_id, contact_id) nulls not distinct
  where campaign_id is not null and direction = 'outbound';

-- Bind each imported Assigns contact to the immutable job that produced it.
-- A later import of the same property must never broaden an earlier
-- attestation to contacts that were not in that file.
create table public.csv_import_contact_outcomes (
  job_id uuid not null,
  property_id uuid not null references public.properties(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  org_id uuid not null references public.organizations(id),
  source_identity text not null,
  created_at timestamptz not null default now(),
  primary key (job_id, property_id, contact_id, source_identity),
  constraint csv_import_contact_outcomes_job_org_fkey
    foreign key (job_id, org_id) references public.jobs(id, org_id) on delete cascade
);

create index csv_import_contact_outcomes_job_org_idx
  on public.csv_import_contact_outcomes (job_id, org_id, property_id);

alter table public.csv_import_contact_outcomes enable row level security;
revoke all on public.csv_import_contact_outcomes from anon, authenticated;
grant all on public.csv_import_contact_outcomes to service_role;

-- Consent attestation follows the same recipient population. Legacy imports
-- retain their homeowner relationship; Assigns imports attest each explicitly
-- stored Assigns contact without naming one as the owner.
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

  perform public.lock_csv_import_consent_org(p_org_id);

  with eligible as materialized (
    select distinct c.id as contact_id
    from public.csv_import_row_outcomes outcome
    join public.properties p
      on p.id = outcome.property_id and p.org_id = outcome.org_id
    join lateral (
      select p.homeowner_contact_id as contact_id
      where p.homeowner_contact_id is not null
      union
      select pc.contact_id
      from public.csv_import_contact_outcomes pc
      where pc.job_id = p_job_id
        and pc.property_id = p.id
        and pc.org_id = p.org_id
    ) recipient on true
    join public.contacts c
      on c.id = recipient.contact_id and c.org_id = p.org_id
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
        select 1 from public.consent_events prior
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
