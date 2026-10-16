-- Rollback for 20261008140100_jev_lead_decisions.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_propose_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric);
drop function if exists public.fn_auto_apply_jev_lead_decision(uuid, uuid, uuid, uuid, text, numeric, numeric);
drop function if exists public.fn_confirm_jev_lead_decision(uuid);
drop function if exists public.fn_correct_jev_lead_decision(uuid, text, text);

-- Functions this migration replaced: restore the prior body (and grants).
-- reset_tenant_tables(): restore body from 20261008140000_jev_outcome_thresholds.sql
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

  -- Re-seed the provisional default thresholds for every remaining org,
  -- same as this migration's initial backfill, so a reset test project
  -- always starts from the documented defaults.
  insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, version, updated_by)
  select o.id, v.outcome, v.min_confidence, 1, null
  from public.organizations o
  cross join (values
    ('new_lead', 0.90),
    ('wrong_number', 0.90),
    ('not_interested', 0.95),
    ('nurture', 0.95),
    ('opted_out', 0.95)
  ) as v(outcome, min_confidence)
  on conflict (org_id, outcome) do nothing;

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
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from anon;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;
revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;
revoke execute on function public.reset_tenant_tables() from public, authenticated;
grant execute on function public.reset_tenant_tables() to service_role;

-- Tables / columns / constraints
-- Table (policy, indexes, grants and comments go with it).
drop table if exists public.jev_lead_decisions;

commit;
