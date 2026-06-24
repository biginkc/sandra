-- Durable phone-level SMS suppression.
--
-- STOP/DNC and explicit wrong-number-for-everything signals must outlive the
-- current contact row snapshot. A later import with the same phone must still
-- be blocked before any queued row, message insert, or provider call.
--
-- Rollback note:
-- 1. drop table public.sms_phone_suppressions cascade;
-- 2. restore public.reset_tenant_tables() to the prior migration 084 body so
--    reset_tenant_tables does not reference the dropped table.

create table if not exists public.sms_phone_suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  channel text not null default 'sms',
  phone_e164 text not null,
  source text not null,
  source_detail jsonb,
  first_contact_id uuid references public.contacts(id) on delete set null,
  provider text,
  suppressed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_phone_suppressions_channel_check check (channel = 'sms'),
  constraint sms_phone_suppressions_phone_e164_check check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

create unique index if not exists idx_sms_phone_suppressions_org_channel_phone
  on public.sms_phone_suppressions(org_id, channel, phone_e164);

create index if not exists idx_sms_phone_suppressions_phone
  on public.sms_phone_suppressions(phone_e164);

create index if not exists idx_sms_phone_suppressions_org
  on public.sms_phone_suppressions(org_id);

alter table public.sms_phone_suppressions enable row level security;

drop policy if exists sms_phone_suppressions_authenticated_select on public.sms_phone_suppressions;
create policy sms_phone_suppressions_authenticated_select
  on public.sms_phone_suppressions
  for select
  to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

drop policy if exists sms_phone_suppressions_authenticated_insert on public.sms_phone_suppressions;
create policy sms_phone_suppressions_authenticated_insert
  on public.sms_phone_suppressions
  for insert
  to authenticated
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));

drop policy if exists sms_phone_suppressions_authenticated_update on public.sms_phone_suppressions;
create policy sms_phone_suppressions_authenticated_update
  on public.sms_phone_suppressions
  for update
  to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()))
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));

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
grant execute on function public.reset_tenant_tables() to service_role;
