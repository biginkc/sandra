-- My Leads Phase 3c (TECH-PLAN-2026-10 §3.5): contract defaults for the send-contract card.
-- Additive only. No rows are inserted: title companies and buyer entities start EMPTY, so the
-- card refuses to send until an owner adds them (no invented defaults).
-- Rollback twin: supabase/rollbacks/20261007160000_acquisition_contract_defaults.sql
begin;

create table public.acquisition_contract_title_companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  closing_agent_name text not null,
  closing_agent_phone text,
  closing_agent_address text,
  closing_agent_email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint acquisition_contract_title_companies_id_org_key unique (id, org_id)
);

create table public.acquisition_contract_buyer_entities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  phone text,
  email text,
  attorney_in_fact text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint acquisition_contract_buyer_entities_id_org_key unique (id, org_id)
);

create table public.acquisition_contract_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  -- No default: earnest money is not an approved business default. NULL means unset, and the card
  -- requires the rep to type it before Send.
  earnest_money_cents bigint check (earnest_money_cents is null or earnest_money_cents >= 0),
  follow_up_days_before_closing integer not null default 3
    check (follow_up_days_before_closing between 1 and 60),
  follow_up_hour_central smallint not null default 9 check (follow_up_hour_central between 0 and 23),
  default_title_company_id uuid,
  default_buyer_entity_id uuid,
  template_field_defaults jsonb not null default '{}'::jsonb
    check (jsonb_typeof(template_field_defaults) = 'object'),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  foreign key (default_title_company_id, org_id)
    references public.acquisition_contract_title_companies (id, org_id),
  foreign key (default_buyer_entity_id, org_id)
    references public.acquisition_contract_buyer_entities (id, org_id)
);

create table public.acquisition_contract_title_market_defaults (
  org_id uuid not null references public.organizations(id) on delete cascade,
  market text not null check (market in ('Kansas City', 'St. Louis', 'Dayton', 'Lake of the Ozarks')),
  state_code text check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  title_company_id uuid not null,
  foreign key (title_company_id, org_id)
    references public.acquisition_contract_title_companies (id, org_id)
);

create unique index acquisition_contract_title_market_defaults_key
  on public.acquisition_contract_title_market_defaults (org_id, market, coalesce(state_code, ''));

alter table public.acquisition_contract_title_companies enable row level security;
alter table public.acquisition_contract_buyer_entities enable row level security;
alter table public.acquisition_contract_settings enable row level security;
alter table public.acquisition_contract_title_market_defaults enable row level security;

create policy acquisition_contract_title_companies_select on public.acquisition_contract_title_companies
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
create policy acquisition_contract_title_companies_write on public.acquisition_contract_title_companies
  for all to authenticated
  using (public.esign_is_active_org_owner(org_id))
  with check (public.esign_is_active_org_owner(org_id));

create policy acquisition_contract_buyer_entities_select on public.acquisition_contract_buyer_entities
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
create policy acquisition_contract_buyer_entities_write on public.acquisition_contract_buyer_entities
  for all to authenticated
  using (public.esign_is_active_org_owner(org_id))
  with check (public.esign_is_active_org_owner(org_id));

create policy acquisition_contract_settings_select on public.acquisition_contract_settings
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
create policy acquisition_contract_settings_write on public.acquisition_contract_settings
  for all to authenticated
  using (public.esign_is_active_org_owner(org_id))
  with check (public.esign_is_active_org_owner(org_id));

create policy acquisition_contract_title_market_defaults_select on public.acquisition_contract_title_market_defaults
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
create policy acquisition_contract_title_market_defaults_write on public.acquisition_contract_title_market_defaults
  for all to authenticated
  using (public.esign_is_active_org_owner(org_id))
  with check (public.esign_is_active_org_owner(org_id));

revoke all on public.acquisition_contract_title_companies from public, anon;
revoke all on public.acquisition_contract_buyer_entities from public, anon;
revoke all on public.acquisition_contract_settings from public, anon;
revoke all on public.acquisition_contract_title_market_defaults from public, anon;

grant select, insert, update, delete on public.acquisition_contract_title_companies to authenticated, service_role;
grant select, insert, update, delete on public.acquisition_contract_buyer_entities to authenticated, service_role;
grant select, insert, update, delete on public.acquisition_contract_settings to authenticated, service_role;
grant select, insert, update, delete on public.acquisition_contract_title_market_defaults to authenticated, service_role;

commit;
