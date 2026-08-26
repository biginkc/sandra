-- 20260825170000_lead_events_ledger.sql
-- Append-only, property-scoped lead activity ledger. Messages, notes, and
-- calls remain canonical in their existing tables and are not duplicated here.

begin;

create table public.lead_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  actor_type text not null,
  actor_id uuid,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  source_type text,
  source_id uuid,
  created_at timestamptz not null default now(),
  constraint lead_events_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id),
  constraint lead_events_actor_type_check
    check (actor_type in ('user', 'ai', 'system')),
  constraint lead_events_actor_identity_check
    check (actor_type = 'user' or actor_id is null),
  constraint lead_events_source_identity_check
    check ((source_type is null) = (source_id is null))
);

comment on table public.lead_events is
  'Append-only property activity ledger. Browser clients may read same-org rows; trusted server writers append confirmed mutations with no direct browser write path.';
comment on column public.lead_events.payload is
  'Small event metadata/diff object only. Message bodies, note bodies, and other unnecessary personal information do not belong here.';
comment on column public.lead_events.source_id is
  'Optional durable source identity paired with source_type for idempotent backfill and retry-safe append operations.';

create index idx_lead_events_property_created
  on public.lead_events (property_id, created_at desc);

create index idx_lead_events_org
  on public.lead_events (org_id);

create unique index idx_lead_events_source_identity
  on public.lead_events (source_type, source_id)
  where source_id is not null;

alter table public.lead_events enable row level security;

create policy lead_events_org_select on public.lead_events
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

-- The application writer uses createAdminClient() on the server. Make the
-- append-only ACL explicit instead of relying on hosted-project defaults:
-- browser users may read same-org rows and the server role may only read or
-- append. The table owner retains the privileges needed by migrations and the
-- tightly scoped reset/merge helpers below.
revoke all on table public.lead_events
  from public, anon, authenticated, service_role;
grant select on table public.lead_events to authenticated;
grant select, insert on table public.lead_events to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lead_events'
  ) then
    execute 'alter publication supabase_realtime add table public.lead_events';
  end if;
end $$;

-- Duplicate-property merges are the one approved maintenance path that may
-- re-point existing ledger rows. Preserve the hardened public authorization
-- wrapper and move loser history before the private merge body deletes the
-- loser property. Any later failure rolls this update back with the merge.
create or replace function public.merge_duplicate_properties(
  keeper_id uuid,
  loser_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keeper_org_id uuid;
  v_loser_org_id uuid;
begin
  select p.org_id into v_keeper_org_id
  from public.properties p where p.id = keeper_id;
  select p.org_id into v_loser_org_id
  from public.properties p where p.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;

  update public.lead_events
  set property_id = keeper_id
  where property_id = loser_id
    and org_id = v_keeper_org_id;

  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;

revoke all on function public.merge_duplicate_properties(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.merge_duplicate_properties(uuid, uuid)
  to authenticated;

-- Keep the integration-test reset helper aligned with the latest complete
-- definition from 20260814150000_appointments_schema.sql.
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
    public.dashboard_snapshots,
    public.metric_snapshots,
    public.memberships,
    public.task_reminder_deliveries,
    public.task_calendar_mutations,
    public.tasks,
    public.job_items,
    public.ai_response_claims,
    public.sms_inbound_deliveries,
    public.sms_inbound_intents,
    public.campaign_recipients,
    public.campaign_delivery_settings,
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
    public.lead_events,
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
  where role = 'owner'
    and access_status = 'active'
    and deletion_prepared_at is null
    and access_expires_at is null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;

  insert into public.memberships
  select * from _memberships_snapshot
  where role <> 'owner'
     or access_status <> 'active'
     or deletion_prepared_at is not null
     or access_expires_at is not null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;
end;
$$;

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;

commit;
