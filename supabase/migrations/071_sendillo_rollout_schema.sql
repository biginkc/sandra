-- Ship the Sendillo SMS lane on top of main's current migration chain.
--
-- Earlier Sendillo work used migration numbers 062/063 on a branch that
-- later fell behind main. Main now owns 062-070 for unrelated schema work, so
-- the Sendillo lane must land on a fresh post-070 migration instead of
-- reusing stale numbers.

begin;

-- Allow Sendillo anywhere provider labels are constrained.
alter table public.messages drop constraint if exists messages_provider_check;
alter table public.messages add constraint messages_provider_check
  check (provider in ('dialpad','twilio','resend','sendgrid','internal','mock','sendillo'));

alter table public.jobs drop constraint if exists jobs_provider_check;
alter table public.jobs add constraint jobs_provider_check
  check (provider in (
    'apify',
    'smartystreets',
    'lob',
    'dialpad',
    'twilio',
    'resend',
    'internal',
    'mock',
    'tracerfy',
    'sendillo'
  ));

do $$
declare
  duplicate_group_count integer;
  duplicate_rows integer;
begin
  with duplicate_groups as (
    select provider, external_id, count(*) as row_count
    from public.messages
    where direction = 'inbound'
      and provider is not null
      and external_id is not null
    group by provider, external_id
    having count(*) > 1
  )
  select count(*), coalesce(sum(row_count), 0)
  into duplicate_group_count, duplicate_rows
  from duplicate_groups;

  if duplicate_group_count > 0 then
    raise exception
      'Cannot add inbound provider/external_id uniqueness: found % duplicate group(s) across % inbound message row(s). Run an audited cleanup/merge before this migration.',
      duplicate_group_count,
      duplicate_rows;
  end if;
end $$;

create unique index if not exists idx_messages_inbound_provider_external_unique
  on public.messages (provider, external_id)
  where direction = 'inbound' and external_id is not null;

-- Give the webhook handler an explicit in-flight claim state so duplicate
-- deliveries can no-op while another worker owns processing.
alter table public.webhook_events
  add column if not exists processing_started_at timestamptz;

alter table public.webhook_events
  drop constraint if exists webhook_events_processing_status_check;

alter table public.webhook_events
  add constraint webhook_events_processing_status_check
  check (processing_status in ('pending','processing','processed','ignored','error'));

-- Make SMS conversation ids database-owned so concurrent first outbound and
-- inbound messages for the same contact/property cannot split threads.
create table if not exists public.message_threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references public.organizations(id),
  channel text not null check (channel in ('sms')),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  conversation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, contact_id, property_id)
);

create index if not exists idx_message_threads_conversation
  on public.message_threads (conversation_id);

alter table public.message_threads enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'message_threads'
      and policyname = 'message_threads_org_select'
  ) then
    create policy message_threads_org_select on public.message_threads
      for select to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'message_threads'
      and policyname = 'message_threads_org_insert'
  ) then
    create policy message_threads_org_insert on public.message_threads
      for insert to authenticated
      with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'message_threads'
      and policyname = 'message_threads_org_update'
  ) then
    create policy message_threads_org_update on public.message_threads
      for update to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()))
      with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'message_threads'
      and policyname = 'message_threads_org_delete'
  ) then
    create policy message_threads_org_delete on public.message_threads
      for delete to authenticated
      using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
  end if;
end $$;

insert into public.message_threads (
  org_id,
  channel,
  contact_id,
  property_id,
  conversation_id,
  created_at,
  updated_at
)
select distinct on (m.channel, m.contact_id, m.property_id)
  m.org_id,
  m.channel,
  m.contact_id,
  m.property_id,
  coalesce(m.conversation_id, gen_random_uuid()),
  m.created_at,
  now()
from public.messages m
where m.channel = 'sms'
  and m.contact_id is not null
  and m.property_id is not null
order by
  m.channel,
  m.contact_id,
  m.property_id,
  (m.conversation_id is null),
  m.created_at asc,
  m.id asc
on conflict (channel, contact_id, property_id) do nothing;

update public.messages m
set conversation_id = mt.conversation_id
from public.message_threads mt
where m.channel = mt.channel
  and m.contact_id = mt.contact_id
  and m.property_id = mt.property_id
  and m.conversation_id is null;

create or replace function public.ensure_sms_conversation_id(
  p_contact_id uuid,
  p_property_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_existing_conversation_id uuid;
  v_conversation_id uuid;
begin
  select p.org_id
  into v_org_id
  from public.properties p
  join public.contacts c
    on c.id = p_contact_id
   and c.org_id = p.org_id
  where p.id = p_property_id;

  if v_org_id is null then
    raise exception 'contact/property thread scope not found'
      using errcode = '42501';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
    and not exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = v_org_id
    )
  then
    raise exception 'not authorized for contact/property thread'
      using errcode = '42501';
  end if;

  select m.conversation_id
  into v_existing_conversation_id
  from public.messages m
  where m.channel = 'sms'
    and m.contact_id = p_contact_id
    and m.property_id = p_property_id
    and m.conversation_id is not null
  order by m.created_at asc, m.id asc
  limit 1;

  insert into public.message_threads (
    org_id,
    channel,
    contact_id,
    property_id,
    conversation_id
  )
  values (
    v_org_id,
    'sms',
    p_contact_id,
    p_property_id,
    coalesce(v_existing_conversation_id, gen_random_uuid())
  )
  on conflict (channel, contact_id, property_id)
  do update set updated_at = public.message_threads.updated_at
  returning conversation_id into v_conversation_id;

  update public.messages m
  set conversation_id = v_conversation_id
  where m.channel = 'sms'
    and m.contact_id = p_contact_id
    and m.property_id = p_property_id
    and m.conversation_id is null;

  return v_conversation_id;
end;
$$;

revoke execute on function public.ensure_sms_conversation_id(uuid, uuid) from public;
grant execute on function public.ensure_sms_conversation_id(uuid, uuid) to authenticated;
grant execute on function public.ensure_sms_conversation_id(uuid, uuid) to service_role;

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

-- Keep STOP/HELP replay-safe at the database layer.
alter table public.consent_events
  add column if not exists source_external_id text
  generated always as ((source_detail ->> 'externalId')) stored;

do $$
declare
  duplicate_group_count integer;
  duplicate_rows integer;
begin
  with duplicate_groups as (
    select
      contact_id,
      channel,
      event_type,
      source_external_id,
      count(*) as row_count
    from public.consent_events
    where source_external_id is not null
      and event_type in ('opt_out', 'help_request')
    group by 1, 2, 3, 4
    having count(*) > 1
  )
  select count(*), coalesce(sum(row_count), 0)
  into duplicate_group_count, duplicate_rows
  from duplicate_groups;

  if duplicate_group_count > 0 then
    raise exception
      'Cannot add consent external-id idempotency: found % duplicate group(s) across % consent row(s). Run an audited cleanup before this migration.',
      duplicate_group_count,
      duplicate_rows;
  end if;
end $$;

create unique index if not exists idx_consent_events_external_idempotency
  on public.consent_events (contact_id, channel, event_type, source_external_id)
  where source_external_id is not null
    and event_type in ('opt_out', 'help_request');

commit;
