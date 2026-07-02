-- Provider-neutral delivery setup (dynamic sender selection).
--
-- Two read-only catalog tables synced from the messaging provider
-- (Sendillo first), plus literal sender-snapshot columns on campaigns.
-- Catalog rows are soft-deactivated when they drop out of a sync, never
-- hard-deleted, and campaigns/messages never FK into the catalog — the
-- snapshot on the campaign row and messages.from_address must survive
-- provider churn for audit.

begin;

create table if not exists public.provider_sender_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  phone_e164 text not null check (length(trim(phone_e164)) > 0),
  provider_number_id text,
  status text not null default 'active' check (status in ('active','inactive')),
  messaging_status text,
  raw jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider, phone_e164)
);

create index if not exists idx_provider_sender_numbers_org_provider_status
  on public.provider_sender_numbers (org_id, provider, status);

create table if not exists public.provider_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  external_id text not null check (length(trim(external_id)) > 0),
  name text,
  brand text,
  use_case text,
  status text not null default 'active' check (status in ('active','inactive')),
  provider_status text,
  raw jsonb,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider, external_id)
);

create index if not exists idx_provider_campaigns_org_provider_status
  on public.provider_campaigns (org_id, provider, status);

-- Literal snapshots — no FK to the catalog on purpose.
alter table public.campaigns
  add column if not exists sender_provider text,
  add column if not exists sender_number text,
  add column if not exists provider_campaign_external_id text,
  add column if not exists provider_campaign_name text;

alter table public.provider_sender_numbers enable row level security;
alter table public.provider_campaigns enable row level security;

-- Read-only for operators; sync writes go through the service role
-- (admin client), so no insert/update policies for authenticated.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_sender_numbers'
      and policyname = 'provider_sender_numbers_org_select'
  ) then
    create policy provider_sender_numbers_org_select on public.provider_sender_numbers
      for select to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_campaigns'
      and policyname = 'provider_campaigns_org_select'
  ) then
    create policy provider_campaigns_org_select on public.provider_campaigns
      for select to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;
end $$;

-- Keep the integration-test reset in step: same body as the
-- 20260624220000 version plus the two catalog tables.
create or replace function public.reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;

  truncate table
    public.user_integration_prefs,
    public.user_oauth_tokens,
    public.call_recordings,
    public.call_transcripts,
    public.call_activities,
    public.dialer_batch_items,
    public.dialer_batches,
    public.metric_snapshots,
    public.memberships,
    public.tasks,
    public.job_items,
    public.ai_response_claims,
    public.sms_inbound_deliveries,
    public.sms_inbound_intents,
    public.campaign_recipients,
    public.campaigns,
    public.provider_sender_numbers,
    public.provider_campaigns,
    public.message_threads,
    public.messages,
    public.consent_events,
    public.sms_phone_suppressions,
    public.property_merges,
    public.jobs,
    public.csv_imports,
    public.webhook_events,
    public.webhook_consumers,
    public.notifications,
    public.lead_notes,
    public.sequence_step_runs,
    public.sequence_enrollments,
    public.sequence_steps,
    public.sequences,
    public.ai_responder_configs,
    public.property_lists,
    public.property_tags,
    public.tags,
    public.test_sms_log,
    public.closer_practice_outcomes,
    public.institute_course_outcomes,
    public.properties,
    public.homeowner_details,
    public.agent_details,
    public.contacts,
    public.cass_cache,
    public.skip_trace_cache
  restart identity cascade;

  delete from public.lists where coalesce(system_managed, false) = false;

  delete from public.sms_templates
  where coalesce(system_managed, false) = false
    and deleted_at is null;

  delete from public.saved_filters
  where coalesce(is_base, false) = false;

  insert into public.memberships
  select * from _memberships_snapshot
  on conflict (user_id, org_id) do nothing;
end;
$$;

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;

commit;
