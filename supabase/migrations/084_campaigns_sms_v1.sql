begin;

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  channel text not null default 'sms' check (channel in ('sms')),
  status text not null default 'active' check (status in ('active','paused','completed','archived')),
  audience_snapshot jsonb,
  description text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index if not exists idx_campaigns_org_lower_name_unique
  on public.campaigns (org_id, lower(name));

create index if not exists idx_campaigns_org_status
  on public.campaigns (org_id, status);

create table if not exists public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, property_id)
);

create index if not exists idx_campaign_recipients_campaign_id
  on public.campaign_recipients (campaign_id);

alter table public.messages
  add column if not exists campaign_id uuid references public.campaigns(id) on delete restrict,
  add column if not exists attributed_outbound_message_id uuid references public.messages(id) on delete set null;

create index if not exists idx_messages_campaign_id
  on public.messages (campaign_id)
  where campaign_id is not null;

create index if not exists idx_messages_campaign_id_status
  on public.messages (campaign_id, status)
  where campaign_id is not null;

create index if not exists idx_messages_attributed_outbound_message_id
  on public.messages (attributed_outbound_message_id)
  where attributed_outbound_message_id is not null;

alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaigns'
      and policyname = 'campaigns_org_select'
  ) then
    create policy campaigns_org_select on public.campaigns
      for select to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaigns'
      and policyname = 'campaigns_org_insert'
  ) then
    create policy campaigns_org_insert on public.campaigns
      for insert to authenticated
      with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaigns'
      and policyname = 'campaigns_org_update'
  ) then
    create policy campaigns_org_update on public.campaigns
      for update to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()))
      with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaign_recipients'
      and policyname = 'campaign_recipients_org_select'
  ) then
    create policy campaign_recipients_org_select on public.campaign_recipients
      for select to authenticated
      using (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_recipients.campaign_id
            and m.user_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaign_recipients'
      and policyname = 'campaign_recipients_org_insert'
  ) then
    create policy campaign_recipients_org_insert on public.campaign_recipients
      for insert to authenticated
      with check (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_recipients.campaign_id
            and m.user_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaign_recipients'
      and policyname = 'campaign_recipients_org_update'
  ) then
    create policy campaign_recipients_org_update on public.campaign_recipients
      for update to authenticated
      using (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_recipients.campaign_id
            and m.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_recipients.campaign_id
            and m.user_id = auth.uid()
        )
      );
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
    public.campaign_recipients,
    public.campaigns,
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
