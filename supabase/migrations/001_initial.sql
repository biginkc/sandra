-- ============================================================================
-- Sandra CRM — Migration 001: Initial schema
-- Plan: ~/.claude/plans/realtor-not-real-time-adaptive-thompson.md
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- Organizations — multi-tenant insurance (risk #14 partial)
-- ============================================================================

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Seed BMH Group with a deterministic UUID so downstream defaults can point at it.
insert into organizations (id, name)
values ('00000000-0000-0000-0000-000000000bbb', 'BMH Group');

-- ============================================================================
-- Counties
-- ============================================================================

create table counties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  state text not null,
  market text not null check (market in ('Kansas City','St. Louis','Dayton','Lake of the Ozarks')),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  created_at timestamptz not null default now(),
  unique (name, state)
);

-- ============================================================================
-- Contacts (Model C base table) — resolves risks #3 and #6
-- ============================================================================

create table contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  created_at timestamptz not null default now(),
  contact_type text not null default 'person' check (contact_type in ('person','entity')),
  first_name text,
  last_name text,
  entity_name text,
  phone_1 text,
  phone_2 text,
  phone_3 text,
  email text,
  do_not_contact boolean not null default false,
  sms_opted_out boolean not null default false,
  sms_opted_out_at timestamptz,
  email_opted_out boolean not null default false,
  email_opted_out_at timestamptz,
  notes text,
  check (
    contact_type = 'person'
    or (contact_type = 'entity' and entity_name is not null)
  )
);

-- Contact-level dedup cascade (partial unique indexes)
create unique index contacts_phone_1_key on contacts (phone_1)
  where phone_1 is not null;
create unique index contacts_email_key on contacts (lower(email))
  where email is not null and phone_1 is null;
create unique index contacts_person_name_key on contacts
  (lower(last_name), lower(first_name))
  where contact_type = 'person'
    and phone_1 is null
    and email is null
    and last_name is not null
    and first_name is not null;
create unique index contacts_entity_name_key on contacts (lower(entity_name))
  where contact_type = 'entity'
    and phone_1 is null
    and email is null
    and entity_name is not null;

create index idx_contacts_phone_2 on contacts (phone_2) where phone_2 is not null;
create index idx_contacts_phone_3 on contacts (phone_3) where phone_3 is not null;

-- Sidecar: homeowner_details
create table homeowner_details (
  contact_id uuid primary key references contacts(id) on delete cascade,
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  mailing_address text,
  mailing_city text,
  mailing_state text,
  mailing_zip text,
  added_at timestamptz not null default now(),
  removed_at timestamptz
);

-- Sidecar: agent_details
create table agent_details (
  contact_id uuid primary key references contacts(id) on delete cascade,
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  brokerage text,
  license_number text,
  added_at timestamptz not null default now(),
  removed_at timestamptz
);

-- ============================================================================
-- Reference data: FIPS codes + ZIP-to-county crosswalk
-- ============================================================================

create table fips_codes (
  fips_code text primary key,
  state_code text not null,
  county_name text not null
);
create unique index fips_codes_state_county_key on fips_codes
  (state_code, lower(county_name));

create table zip_county_xref (
  zip text not null,
  fips_code text not null references fips_codes(fips_code),
  is_primary boolean not null default false,
  primary key (zip, fips_code)
);
create index idx_zip_county_xref_zip_primary on zip_county_xref (zip)
  where is_primary = true;

-- ============================================================================
-- Properties
-- ============================================================================

create table properties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  address text not null,
  city text,
  state text not null,
  zip text,
  county_id uuid references counties(id),
  market text check (market in ('Kansas City','St. Louis','Dayton','Lake of the Ozarks')),

  fips_code text,
  apn text,
  apn_normalized text,

  regrid_id text,
  attom_id text,

  zpid text,
  mls_number text,

  lat numeric,
  lon numeric,

  address_normalized text,

  beds numeric,
  baths numeric,
  sqft numeric,
  year_built int,
  listing_price numeric,
  arv numeric,
  repair_estimate numeric,
  mortgage_balance numeric,
  equity_estimate numeric,
  source text check (source in ('mls','driving_for_dollars','direct_mail','referral','skip_trace','probate','pre_foreclosure','other')),
  status text not null default 'new_lead'
    check (status in ('new_lead','researching','contacted','interested','offer_sent','under_contract','closed','dead')),
  distress_flags text[] not null default '{}',
  notes text,

  homeowner_contact_id uuid references contacts(id),
  agent_contact_id uuid references contacts(id),

  is_vacant boolean,
  is_seasonal boolean,
  is_residential boolean,
  vacant_since timestamptz,
  owner_moved_at timestamptz,
  absentee_flag boolean,
  cass_status text not null default 'unverified'
    check (cass_status in ('unverified','verified','invalid','ambiguous')),
  cass_verified_at timestamptz,
  ncoa_verified_at timestamptz,
  cass_raw_response jsonb
);

-- Dedup cascade (partial unique indexes)
create unique index properties_fips_apn_key on properties (fips_code, apn_normalized)
  where fips_code is not null and apn_normalized is not null;
create unique index properties_regrid_key on properties (regrid_id)
  where regrid_id is not null;
create unique index properties_attom_key on properties (attom_id)
  where attom_id is not null;
create unique index properties_zpid_key on properties (zpid)
  where zpid is not null;
create unique index properties_mls_number_key on properties (mls_number)
  where mls_number is not null;
create unique index properties_address_normalized_key on properties (address_normalized)
  where address_normalized is not null;

-- Query indexes
create index idx_properties_status on properties (status);
create index idx_properties_market on properties (market) where market is not null;
create index idx_properties_homeowner_contact on properties (homeowner_contact_id)
  where homeowner_contact_id is not null;
create index idx_properties_agent_contact on properties (agent_contact_id)
  where agent_contact_id is not null;
create index idx_properties_vacant on properties (is_vacant) where is_vacant = true;
create index idx_properties_absentee on properties (owner_moved_at)
  where owner_moved_at is not null;

-- ============================================================================
-- Messages (provider-agnostic; conversation_id reserved for risk #18)
-- ============================================================================

create table messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  created_at timestamptz not null default now(),
  channel text not null check (channel in ('sms','email')),
  direction text not null check (direction in ('outbound','inbound')),
  property_id uuid references properties(id),
  contact_id uuid references contacts(id),
  conversation_id uuid,
  provider text check (provider in ('dialpad','twilio','resend','sendgrid','internal')),
  from_address text,
  to_address text,
  subject text,
  body text not null,
  status text not null default 'pending'
    check (status in ('pending','queued','sent','delivered','failed','received','bounced')),
  external_id text,
  error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  metadata jsonb
);

create index idx_messages_property on messages (property_id) where property_id is not null;
create index idx_messages_contact on messages (contact_id) where contact_id is not null;
create index idx_messages_conversation on messages (conversation_id) where conversation_id is not null;
create index idx_messages_created on messages (created_at desc);
create index idx_messages_external_id on messages (external_id) where external_id is not null;

-- ============================================================================
-- CSV imports
-- ============================================================================

create table csv_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id),
  filename text,
  source text,
  market text,
  total_rows int not null default 0,
  inserted_properties int not null default 0,
  inserted_homeowners int not null default 0,
  inserted_agents int not null default 0,
  skipped_duplicates int not null default 0,
  failed_rows int not null default 0,
  errors jsonb
);

-- ============================================================================
-- CASS cache (SmartyStreets/Lob cost-control layer)
-- ============================================================================

create table cass_cache (
  raw_address text primary key,
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  cass_response jsonb not null,
  verified_at timestamptz not null default now()
);
create index idx_cass_cache_verified_at on cass_cache (verified_at);

-- ============================================================================
-- Webhook events (idempotency + audit for provider callbacks)
-- ============================================================================

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text not null,
  external_id text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processed','ignored','error')),
  payload jsonb not null,
  signature_verified boolean not null default false,
  error_message text
);

create unique index webhook_events_idempotency_key
  on webhook_events (provider, event_type, external_id);
create index idx_webhook_events_processing_status on webhook_events (processing_status)
  where processing_status = 'pending';

-- ============================================================================
-- Jobs (universal async-work table)
-- ============================================================================

create table jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  type text not null check (type in (
    'csv_import','cass_dsf2_ncoa','cass_refresh','ncoa_refresh',
    'agent_lookup','regrid_lookup','skip_trace',
    'direct_mail_campaign','bulk_sms','data_export',
    'property_merge','sweeper','send_sms','send_email'
  )),
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed','partial','canceled')),
  total_items int not null default 0,
  processed_items int not null default 0,
  succeeded_items int not null default 0,
  failed_items int not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  worker_heartbeat_at timestamptz,
  retry_count int not null default 0,
  max_retries int not null default 3,
  error_class text check (error_class in
    ('validation','transient','provider','database','authorization','configuration')),
  parent_job_id uuid references jobs(id),
  related_import_id uuid references csv_imports(id),
  provider text check (provider in
    ('apify','smartystreets','lob','dialpad','twilio','resend','internal')),
  provider_run_id text,
  provider_webhook_secret text,
  input_params jsonb,
  result_summary jsonb,
  error_message text,
  title text,
  description text
);

create index idx_jobs_status on jobs (status) where status in ('queued','running');
create index idx_jobs_type on jobs (type);
create index idx_jobs_parent on jobs (parent_job_id) where parent_job_id is not null;
create index idx_jobs_related_import on jobs (related_import_id)
  where related_import_id is not null;
create index idx_jobs_user on jobs (created_by, created_at desc);

-- ============================================================================
-- Job items (per-row results within a job)
-- ============================================================================

create table job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  property_id uuid references properties(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  message_id uuid references messages(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','success','no_match','error','skipped')),
  input_payload jsonb,
  output_payload jsonb,
  error_message text,
  error_class text check (error_class in
    ('validation','transient','provider','database','authorization','configuration')),
  retry_count int not null default 0,
  processed_at timestamptz
);

create index idx_job_items_job on job_items (job_id);
create index idx_job_items_property on job_items (property_id) where property_id is not null;
create index idx_job_items_contact on job_items (contact_id) where contact_id is not null;
create index idx_job_items_message on job_items (message_id) where message_id is not null;

-- ============================================================================
-- Property merges (audit log for merge operations)
-- ============================================================================

create table property_merges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id),
  keeper_id uuid not null references properties(id) on delete cascade,
  loser_id uuid not null,
  merged_at timestamptz not null default now(),
  merged_by uuid references auth.users(id),
  loser_snapshot jsonb not null
);
create index idx_property_merges_keeper on property_merges (keeper_id);

-- ============================================================================
-- RLS — authenticated users get full CRUD today (single-tenant)
-- When RBAC lands (risk #14) these get replaced with role-aware policies.
-- ============================================================================

alter table organizations     enable row level security;
alter table counties          enable row level security;
alter table contacts          enable row level security;
alter table homeowner_details enable row level security;
alter table agent_details     enable row level security;
alter table properties        enable row level security;
alter table messages          enable row level security;
alter table csv_imports       enable row level security;
alter table cass_cache        enable row level security;
alter table webhook_events    enable row level security;
alter table jobs              enable row level security;
alter table job_items         enable row level security;
alter table property_merges   enable row level security;
alter table fips_codes        enable row level security;
alter table zip_county_xref   enable row level security;

create policy organizations_authenticated_all on organizations
  for all to authenticated using (true) with check (true);
create policy counties_authenticated_all on counties
  for all to authenticated using (true) with check (true);
create policy contacts_authenticated_all on contacts
  for all to authenticated using (true) with check (true);
create policy homeowner_details_authenticated_all on homeowner_details
  for all to authenticated using (true) with check (true);
create policy agent_details_authenticated_all on agent_details
  for all to authenticated using (true) with check (true);
create policy properties_authenticated_all on properties
  for all to authenticated using (true) with check (true);
create policy messages_authenticated_all on messages
  for all to authenticated using (true) with check (true);
create policy csv_imports_authenticated_all on csv_imports
  for all to authenticated using (true) with check (true);
create policy cass_cache_authenticated_all on cass_cache
  for all to authenticated using (true) with check (true);
create policy webhook_events_authenticated_all on webhook_events
  for all to authenticated using (true) with check (true);
create policy jobs_authenticated_all on jobs
  for all to authenticated using (true) with check (true);
create policy job_items_authenticated_all on job_items
  for all to authenticated using (true) with check (true);
create policy property_merges_authenticated_all on property_merges
  for all to authenticated using (true) with check (true);
create policy fips_codes_authenticated_all on fips_codes
  for all to authenticated using (true) with check (true);
create policy zip_county_xref_authenticated_all on zip_county_xref
  for all to authenticated using (true) with check (true);

-- ============================================================================
-- Realtime publications (jobs, job_items, messages)
-- ============================================================================

alter publication supabase_realtime add table jobs;
alter publication supabase_realtime add table job_items;
alter publication supabase_realtime add table messages;

-- ============================================================================
-- merge_duplicate_properties function
-- ============================================================================

create or replace function merge_duplicate_properties(keeper_id uuid, loser_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  keeper_row properties%rowtype;
  loser_row  properties%rowtype;
begin
  select * into keeper_row from properties where id = keeper_id for update;
  select * into loser_row  from properties where id = loser_id  for update;

  if keeper_row.id is null or loser_row.id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found (keeper=%, loser=%)',
      keeper_id, loser_id;
  end if;

  update messages  set property_id = keeper_id where property_id = loser_id;
  update job_items set property_id = keeper_id where property_id = loser_id;

  update properties set
    apn                  = coalesce(properties.apn, loser_row.apn),
    apn_normalized       = coalesce(properties.apn_normalized, loser_row.apn_normalized),
    fips_code            = coalesce(properties.fips_code, loser_row.fips_code),
    regrid_id            = coalesce(properties.regrid_id, loser_row.regrid_id),
    attom_id             = coalesce(properties.attom_id, loser_row.attom_id),
    zpid                 = coalesce(properties.zpid, loser_row.zpid),
    mls_number           = coalesce(properties.mls_number, loser_row.mls_number),
    lat                  = coalesce(properties.lat, loser_row.lat),
    lon                  = coalesce(properties.lon, loser_row.lon),
    address_normalized   = coalesce(properties.address_normalized, loser_row.address_normalized),
    county_id            = coalesce(properties.county_id, loser_row.county_id),
    market               = coalesce(properties.market, loser_row.market),
    beds                 = coalesce(properties.beds, loser_row.beds),
    baths                = coalesce(properties.baths, loser_row.baths),
    sqft                 = coalesce(properties.sqft, loser_row.sqft),
    year_built           = coalesce(properties.year_built, loser_row.year_built),
    listing_price        = coalesce(properties.listing_price, loser_row.listing_price),
    arv                  = coalesce(properties.arv, loser_row.arv),
    repair_estimate      = coalesce(properties.repair_estimate, loser_row.repair_estimate),
    mortgage_balance     = coalesce(properties.mortgage_balance, loser_row.mortgage_balance),
    equity_estimate      = coalesce(properties.equity_estimate, loser_row.equity_estimate),
    homeowner_contact_id = coalesce(properties.homeowner_contact_id, loser_row.homeowner_contact_id),
    agent_contact_id     = coalesce(properties.agent_contact_id, loser_row.agent_contact_id),
    is_vacant            = coalesce(properties.is_vacant, loser_row.is_vacant),
    is_seasonal          = coalesce(properties.is_seasonal, loser_row.is_seasonal),
    is_residential       = coalesce(properties.is_residential, loser_row.is_residential),
    vacant_since         = coalesce(properties.vacant_since, loser_row.vacant_since),
    owner_moved_at       = coalesce(properties.owner_moved_at, loser_row.owner_moved_at),
    absentee_flag        = coalesce(properties.absentee_flag, loser_row.absentee_flag),
    cass_verified_at     = greatest(properties.cass_verified_at, loser_row.cass_verified_at),
    ncoa_verified_at     = greatest(properties.ncoa_verified_at, loser_row.ncoa_verified_at),
    updated_at           = now()
  where id = keeper_id;

  insert into property_merges (keeper_id, loser_id, merged_at, loser_snapshot)
  values (keeper_id, loser_id, now(), to_jsonb(loser_row));

  delete from properties where id = loser_id;
end;
$$;

-- ============================================================================
-- delete_contact function (scaffold for risk #16 cascading PII delete)
-- ============================================================================

create or replace function delete_contact(p_contact_id uuid, p_reason text)
returns void
language plpgsql
security definer
as $$
begin
  update messages
    set contact_id = null,
        body = '[contact deleted: ' || p_reason || ']'
    where contact_id = p_contact_id;

  delete from contacts where id = p_contact_id;
end;
$$;
