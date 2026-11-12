-- Rollback for 20261112120000_multi_number_sender_schema.
-- Run 20261112120100's rollback first. Drops the new tables (their rows are derived or
-- unused while pinning is off), the mirror trigger, the evidence indexes and the catalog /
-- org columns, and restores reset_tenant_tables() to its 20261008140000 definition.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop trigger if exists campaign_delivery_settings_mirror_sender_numbers on public.campaign_delivery_settings;
drop function if exists public.mirror_campaign_delivery_primary_sender();
drop table if exists public.sms_sender_assignments;
drop table if exists public.sms_sender_settings;
drop table if exists public.campaign_sender_numbers;
drop index if exists public.idx_messages_org_to_sms_outbound_created;
drop index if exists public.idx_messages_org_from_sms_inbound_created;
alter table public.provider_sender_numbers
  drop column if exists attached_campaign,
  drop column if exists attached_brand;
alter table public.organizations drop column if exists sendillo_brand_name;

create or replace function public.reset_tenant_tables()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;
  truncate table
    public.ai_reply_drafts,
    public.ai_send_reservations,
    public.ai_reply_dead_letters,
    public.hold_alert_deliveries,
    public.messages_v2_settings,
    public.hold_alert_settings,
    public.luna_suggestions,
    public.jev_lead_decisions,
    public.jev_outcome_threshold_history,
    public.jev_outcome_thresholds,
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
    public.auto_reply_templates,
    public.sms_template_approval_events,
    public.ai_response_claims,
    public.sms_inbound_deliveries,
    public.sms_inbound_intents,
    public.campaign_recipients,
    public.campaign_delivery_settings,
    public.campaigns,
    public.provider_sender_numbers,
    public.provider_campaigns,
    public.ai_disposition_reviews,
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
  insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, version, updated_by, automation_enabled)
  select o.id, v.outcome, v.min_confidence, 1, null, (v.outcome not in ('new_lead', 'opted_out'))
  from public.organizations o
  cross join (values
    ('new_lead', 0.90),
    ('wrong_number', 0.90),
    ('not_interested', 0.90),
    ('nurture', 0.95),
    ('opted_out', 0.95)
  ) as v(outcome, min_confidence)
  on conflict (org_id, outcome) do nothing;
  delete from public.lists where coalesce(system_managed, false) = false;
  perform set_config('sandra.template_approval', 'on', true);
  update public.sms_templates set approved_for_auto_send = false, approved_by = null, approved_at = null, approved_content = null where approved_for_auto_send;
  perform set_config('sandra.template_approval', 'off', true);
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
$function$;

commit;
