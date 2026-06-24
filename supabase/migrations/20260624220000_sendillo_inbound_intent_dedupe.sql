begin;

create extension if not exists btree_gist;

create table if not exists public.sms_inbound_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references public.organizations(id),
  provider text not null,
  from_address text not null,
  to_address text not null,
  body_fingerprint text not null,
  fingerprint_version smallint not null default 1,
  dedupe_scope_hash text not null,
  received_at timestamptz not null,
  dedupe_range tstzrange not null,
  contact_id uuid references public.contacts(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  conversation_id uuid,
  routing_resolution text,
  canonical_message_id uuid,
  status text not null default 'claimed'
    check (status in ('claimed','message_inserted','side_effects_complete','error')),
  duplicate_count integer not null default 0,
  first_provider_message_id text not null,
  last_provider_message_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sms_inbound_intents_no_overlapping_semantic_burst'
      and conrelid = 'public.sms_inbound_intents'::regclass
  ) then
    alter table public.sms_inbound_intents
      add constraint sms_inbound_intents_no_overlapping_semantic_burst
      exclude using gist (
        org_id with =,
        dedupe_scope_hash with =,
        dedupe_range with &&
      );
  end if;
end $$;

create index if not exists idx_sms_inbound_intents_created
  on public.sms_inbound_intents (org_id, created_at desc);

create index if not exists idx_sms_inbound_intents_canonical_message
  on public.sms_inbound_intents (canonical_message_id)
  where canonical_message_id is not null;

create table if not exists public.sms_inbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid references public.sms_inbound_intents(id) on delete set null,
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references public.organizations(id),
  webhook_event_id uuid references public.webhook_events(id) on delete set null,
  provider text not null,
  provider_message_id text not null,
  received_at timestamptz not null,
  payload_sha256 text not null,
  classification text not null
    check (classification in ('canonical','duplicate_provider_id','duplicate_semantic','shadow_semantic')),
  created_at timestamptz not null default now(),
  unique (org_id, provider, provider_message_id)
);

create index if not exists idx_sms_inbound_deliveries_intent
  on public.sms_inbound_deliveries (intent_id, created_at);

alter table public.messages
  add column if not exists inbound_intent_id uuid references public.sms_inbound_intents(id) on delete set null;

create unique index if not exists idx_messages_inbound_intent_unique
  on public.messages (inbound_intent_id)
  where channel = 'sms'
    and direction = 'inbound'
    and inbound_intent_id is not null;

alter table public.sms_inbound_intents
  drop constraint if exists sms_inbound_intents_canonical_message_fkey;

alter table public.sms_inbound_intents
  add constraint sms_inbound_intents_canonical_message_fkey
  foreign key (canonical_message_id) references public.messages(id) on delete set null;

create table if not exists public.ai_response_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references public.organizations(id),
  response_kind text not null default 'sms_ai_responder_v1',
  inbound_message_id uuid references public.messages(id) on delete cascade,
  inbound_intent_id uuid references public.sms_inbound_intents(id) on delete set null,
  property_id uuid references public.properties(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  conversation_id uuid,
  status text not null default 'processing'
    check (status in ('processing','completed','error')),
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null default now() + interval '5 minutes',
  completed_at timestamptz,
  outbound_message_id uuid references public.messages(id) on delete set null,
  outcome text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_ai_response_claims_inbound_kind_unique
  on public.ai_response_claims (inbound_message_id, response_kind)
  where inbound_message_id is not null;

create index if not exists idx_ai_response_claims_processing
  on public.ai_response_claims (status, lease_expires_at)
  where status = 'processing';

alter table public.sms_inbound_intents enable row level security;
alter table public.sms_inbound_deliveries enable row level security;
alter table public.ai_response_claims enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sms_inbound_intents'
      and policyname = 'sms_inbound_intents_org_select'
  ) then
    create policy sms_inbound_intents_org_select on public.sms_inbound_intents
      for select to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sms_inbound_deliveries'
      and policyname = 'sms_inbound_deliveries_org_select'
  ) then
    create policy sms_inbound_deliveries_org_select on public.sms_inbound_deliveries
      for select to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ai_response_claims'
      and policyname = 'ai_response_claims_org_select'
  ) then
    create policy ai_response_claims_org_select on public.ai_response_claims
      for select to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;
end $$;

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
    public.message_threads,
    public.messages,
    public.consent_events,
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

  insert into public.memberships
  select * from _memberships_snapshot
  on conflict (user_id, org_id) do nothing;
end;
$$;

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;

commit;
