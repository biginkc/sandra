-- ============================================================================
-- Phase 04 — user_integration_prefs
--
-- Per-user Slack + Google Calendar delivery preferences, plus external IDs on
-- tasks so dispatchers can update previously-created Slack messages and
-- Google Calendar events.
--
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml.
-- ============================================================================

create table public.user_integration_prefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('slack', 'google_calendar')),
  enabled boolean not null default true,
  timezone text not null default 'America/Chicago',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, channel)
);

comment on table public.user_integration_prefs is
  'Per-user delivery preferences for integration channels. Timezone lives here because it is only used by Slack and Google Calendar dispatch today.';
comment on column public.user_integration_prefs.channel is
  'Delivery channel key. Distinct from OAuth provider names; google_calendar uses provider google.';
comment on column public.user_integration_prefs.timezone is
  'IANA timezone used for task calendar events. Defaults to America/Chicago.';

alter table public.user_integration_prefs enable row level security;

create policy user_integration_prefs_self_all on public.user_integration_prefs
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.tasks
  add column google_calendar_event_id text,
  add column slack_channel_id text,
  add column slack_message_ts text;

comment on column public.tasks.google_calendar_event_id is
  'Google Calendar event id created by the task calendar dispatcher. Completion does not delete the event; stale events are an accepted Phase 04 tradeoff.';
comment on column public.tasks.slack_channel_id is
  'Slack channel id for the task-assigned DM message, used with slack_message_ts for chat.update.';
comment on column public.tasks.slack_message_ts is
  'Slack message timestamp for the task-assigned DM message, used with slack_channel_id for chat.update.';

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
