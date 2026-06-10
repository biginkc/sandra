begin;

alter table public.notifications drop constraint if exists notifications_entity_type_check;
alter table public.notifications add constraint notifications_entity_type_check
  check (entity_type in ('property', 'job', 'task', 'message'));

do $$
declare
  duplicate_row record;
begin
  select user_id, entity_id, count(*) as duplicate_count
  into duplicate_row
  from public.notifications
  where event_type = 'owner_message_added'
    and entity_type = 'message'
  group by user_id, entity_id
  having count(*) > 1
  limit 1;

  if duplicate_row is not null then
    raise exception
      'Cannot create idx_notifications_owner_message_added_message_unique: duplicate notifications exist for user_id %, entity_id %, count %',
      duplicate_row.user_id,
      duplicate_row.entity_id,
      duplicate_row.duplicate_count;
  end if;
end
$$;

create unique index if not exists idx_notifications_owner_message_added_message_unique
  on public.notifications (user_id, event_type, entity_type, entity_id)
  where event_type = 'owner_message_added'
    and entity_type = 'message';

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
