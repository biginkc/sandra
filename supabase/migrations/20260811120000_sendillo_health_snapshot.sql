begin;

create table public.dashboard_snapshots (
  snapshot_key text primary key,
  payload jsonb not null,
  captured_at timestamptz not null
);

alter table public.dashboard_snapshots enable row level security;

revoke all on table public.dashboard_snapshots from public, anon;
grant select on table public.dashboard_snapshots to authenticated;
grant select on table public.dashboard_snapshots to service_role;

create policy "authenticated users can read dashboard snapshots"
  on public.dashboard_snapshots
  for select
  to authenticated
  using (public.hugo_has_any_active_access());

create index dashboard_snapshots_captured_at_idx
  on public.dashboard_snapshots (captured_at desc);

create or replace function public.compute_sendillo_sms_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with sendillo_rows as (
    select
      m.id,
      m.direction,
      m.status,
      m.contact_id,
      m.property_id,
      m.conversation_id,
      m.created_at,
      m.read_at,
      case
        when m.conversation_id is not null
          then 'conversation:' || m.conversation_id::text
        when m.contact_id is not null or m.property_id is not null
          then 'legacy:' || coalesce(m.contact_id::text, 'none') || ':' ||
            coalesce(m.property_id::text, 'none')
        else 'message:' || m.id::text
      end as thread_key
    from public.messages m
    where m.channel = 'sms'
      and m.provider = 'sendillo'
  ),
  non_queued as (
    select *
    from sendillo_rows
    where status is distinct from 'queued'
  ),
  thread_buckets as (
    select
      thread_key,
      bool_or(direction = 'inbound') as has_inbound,
      bool_or(direction = 'inbound' and read_at is null) as has_unread_inbound,
      (array_agg(direction order by created_at desc, id desc))[1] as latest_direction,
      (array_agg(property_id order by created_at desc, id desc))[1] as latest_property_id
    from non_queued
    group by thread_key
  ),
  disposition_counts as (
    select
      count(*) filter (
        where p.id is not null
          and p.outreach_dispo is null
          and b.latest_direction = 'inbound'
      ) as latest_inbound_missing_disposition,
      count(*) filter (
        where p.id is not null
          and p.outreach_dispo is null
          and b.has_unread_inbound
      ) as unread_missing_disposition,
      count(*) filter (
        where p.id is not null
          and p.outreach_dispo is null
          and p.needs_human_attention
      ) as human_attention_missing_disposition,
      count(*) filter (
        where p.id is not null
          and p.outreach_dispo is null
          and b.has_inbound
      ) as any_inbound_missing_disposition
    from thread_buckets b
    left join public.properties p on p.id = b.latest_property_id
  )
  select jsonb_build_object(
    'smsRows', (select count(*) from sendillo_rows),
    'outboundMessages', (
      select count(*) from sendillo_rows
      where direction = 'outbound' and status is distinct from 'queued'
    ),
    'inboundMessages', (
      select count(*) from sendillo_rows where direction = 'inbound'
    ),
    'conversations', (select count(*) from thread_buckets),
    'latestInboundMissingDisposition', d.latest_inbound_missing_disposition,
    'unreadMissingDisposition', d.unread_missing_disposition,
    'humanAttentionMissingDisposition', d.human_attention_missing_disposition,
    'anyInboundMissingDisposition', d.any_inbound_missing_disposition,
    'firstMessageAt', (select min(created_at) from sendillo_rows),
    'latestMessageAt', (select max(created_at) from sendillo_rows)
  )
  from disposition_counts d;
$$;

create or replace function public.capture_sendillo_sms_health_snapshot(
  p_captured_at timestamptz default now()
)
returns table(payload jsonb, captured_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  v_payload := public.compute_sendillo_sms_health();

  return query
  insert into public.dashboard_snapshots (
    snapshot_key,
    payload,
    captured_at
  ) values (
    'sendillo_sms_health',
    v_payload,
    p_captured_at
  )
  on conflict (snapshot_key) do update
    set payload = excluded.payload,
        captured_at = excluded.captured_at
    where excluded.captured_at > public.dashboard_snapshots.captured_at
  returning dashboard_snapshots.payload, dashboard_snapshots.captured_at;

  if not found then
    return query
    select ds.payload, ds.captured_at
    from public.dashboard_snapshots ds
    where ds.snapshot_key = 'sendillo_sms_health';
  end if;
end;
$$;

revoke all on function public.compute_sendillo_sms_health()
  from public, anon, authenticated;
grant execute on function public.compute_sendillo_sms_health()
  to service_role;

revoke all on function public.capture_sendillo_sms_health_snapshot(timestamptz)
  from public, anon, authenticated;
grant execute on function public.capture_sendillo_sms_health_snapshot(timestamptz)
  to service_role;

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
