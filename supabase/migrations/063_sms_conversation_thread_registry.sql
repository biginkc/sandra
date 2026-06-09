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

create policy message_threads_org_select on public.message_threads
  for select to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy message_threads_org_insert on public.message_threads
  for insert to authenticated
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy message_threads_org_update on public.message_threads
  for update to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()))
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));

create policy message_threads_org_delete on public.message_threads
  for delete to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

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
language sql
security definer
set search_path = public, pg_temp
as $$
  with existing_message as (
    select m.org_id, m.conversation_id
    from public.messages m
    where m.channel = 'sms'
      and m.contact_id = p_contact_id
      and m.property_id = p_property_id
      and m.conversation_id is not null
    order by m.created_at asc, m.id asc
    limit 1
  ),
  property_org as (
    select p.org_id
    from public.properties p
    where p.id = p_property_id
  ),
  upserted as (
    insert into public.message_threads (
      org_id,
      channel,
      contact_id,
      property_id,
      conversation_id
    )
    select
      coalesce((select org_id from existing_message), property_org.org_id),
      'sms',
      p_contact_id,
      p_property_id,
      coalesce((select conversation_id from existing_message), gen_random_uuid())
    from property_org
    on conflict (channel, contact_id, property_id)
    do update set updated_at = public.message_threads.updated_at
    returning conversation_id
  ),
  backfill as (
    update public.messages m
    set conversation_id = (select conversation_id from upserted)
    where m.channel = 'sms'
      and m.contact_id = p_contact_id
      and m.property_id = p_property_id
      and m.conversation_id is null
    returning m.id
  )
  select conversation_id from upserted;
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
