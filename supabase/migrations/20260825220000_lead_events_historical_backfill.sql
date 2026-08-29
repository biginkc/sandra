-- 20260825220000_lead_events_historical_backfill.sql
-- Backfill only activity that existing durable rows can prove. Messages,
-- notes, and calls remain live-sourced from their canonical tables and are
-- deliberately not copied into lead_events.

begin;

with candidates as (
  -- Property creation has no historical actor column.
  select
    p.org_id,
    p.id as property_id,
    'system'::text as actor_type,
    null::uuid as actor_id,
    'lead_created'::text as event_type,
    jsonb_strip_nulls(jsonb_build_object('source', p.source)) as payload,
    'properties.created'::text as source_type,
    p.id as source_id,
    p.created_at
  from public.properties p

  union all

  -- qualified_by is text because it may contain a system marker. Only a
  -- still-existing auth UUID is safe to persist as a user actor.
  select
    p.org_id,
    p.id,
    case when actor.id is not null then 'user' else 'system' end,
    actor.id,
    'qualified',
    jsonb_build_object('from', 'prospect', 'to', 'new_lead'),
    'properties.qualified',
    p.id,
    p.qualified_at
  from public.properties p
  left join auth.users actor on actor.id::text = p.qualified_by
  where p.qualified_at is not null

  union all

  select
    t.org_id,
    t.related_property_id,
    case when actor.id is not null then 'user' else 'system' end,
    actor.id,
    'task_created',
    jsonb_build_object('task_id', t.id),
    'tasks.created',
    t.id,
    t.created_at
  from public.tasks t
  left join auth.users actor on actor.id = t.created_by
  where t.type <> 'appointment'
    and t.related_property_id is not null

  union all

  select
    t.org_id,
    t.related_property_id,
    case when actor.id is not null then 'user' else 'system' end,
    actor.id,
    'task_completed',
    jsonb_build_object('task_id', t.id, 'to', 'completed'),
    'tasks.completed',
    t.id,
    t.completed_at
  from public.tasks t
  left join auth.users actor on actor.id = t.completed_by
  where t.type <> 'appointment'
    and t.related_property_id is not null
    and t.status = 'completed'
    and t.completed_at is not null

  union all

  -- Appointment calendar mutations are the durable identity used by the
  -- live writers for booking/cancel/reschedule/reassign events.
  select
    t.org_id,
    t.related_property_id,
    case when actor.id is not null then 'user' else 'system' end,
    actor.id,
    'appointment_booked',
    jsonb_build_object(
      'task_id', t.id,
      'assignee_id', mutation.old_assignee_id,
      'due_at', t.due_at
    ),
    'appointments.booked',
    mutation.id,
    mutation.created_at
  from public.task_calendar_mutations mutation
  join public.tasks t on t.id = mutation.source_task_id
  left join auth.users actor on actor.id = t.created_by
  where mutation.operation = 'create'
    and t.type = 'appointment'
    and t.related_property_id is not null

  union all

  -- Held/no-show does not create a calendar mutation; the completed task is
  -- the durable source and matches the live source convention.
  select
    t.org_id,
    t.related_property_id,
    case when actor.id is not null then 'user' else 'system' end,
    actor.id,
    case
      when t.outcome = 'held' then 'appointment_held'
      else 'appointment_no_show'
    end,
    jsonb_build_object('task_id', t.id),
    'appointments.completed',
    t.id,
    t.completed_at
  from public.tasks t
  left join auth.users actor on actor.id = t.completed_by
  where t.type = 'appointment'
    and t.related_property_id is not null
    and t.status = 'completed'
    and t.outcome in ('held', 'no_show')
    and t.completed_at is not null

  union all

  select
    source_task.org_id,
    source_task.related_property_id,
    'system',
    null,
    'appointment_canceled',
    jsonb_build_object('task_id', source_task.id),
    'appointments.canceled',
    mutation.id,
    mutation.created_at
  from public.task_calendar_mutations mutation
  join public.tasks source_task on source_task.id = mutation.source_task_id
  where mutation.operation = 'cancel'
    and source_task.type = 'appointment'
    and source_task.related_property_id is not null

  union all

  select
    source_task.org_id,
    source_task.related_property_id,
    case when actor.id is not null then 'user' else 'system' end,
    actor.id,
    'appointment_rescheduled',
    jsonb_build_object(
      'task_id', target_task.id,
      'previous_task_id', source_task.id,
      'from', source_task.due_at,
      'to', target_task.due_at
    ),
    'appointments.rescheduled',
    mutation.id,
    mutation.created_at
  from public.task_calendar_mutations mutation
  join public.tasks source_task on source_task.id = mutation.source_task_id
  join public.tasks target_task on target_task.id = mutation.target_task_id
  left join auth.users actor on actor.id = source_task.completed_by
  where mutation.operation = 'reschedule'
    and source_task.type = 'appointment'
    and source_task.related_property_id is not null

  union all

  -- The calendar ledger proves the reassignment transition but does not
  -- retain the requesting user, so historical attribution is system.
  select
    t.org_id,
    t.related_property_id,
    'system',
    null::uuid,
    'appointment_reassigned',
    jsonb_build_object(
      'task_id', t.id,
      'from', mutation.old_assignee_id,
      'to', mutation.new_assignee_id
    ),
    'appointments.reassigned',
    mutation.id,
    mutation.created_at
  from public.task_calendar_mutations mutation
  join public.tasks t on t.id = mutation.source_task_id
  where mutation.operation = 'reassign'
    and mutation.new_assignee_id is not null
    and t.type = 'appointment'
    and t.related_property_id is not null

  union all

  -- Current contact linkage cannot prove historical property attribution.
  -- Backfill only consent rows whose immutable source metadata names an
  -- already-existing property in the same org; malformed, missing, future,
  -- or merely current-state associations are skipped rather than guessed.
  select
    consent.org_id,
    property.id,
    'system',
    null::uuid,
    case
      when consent.event_type in ('opt_out', 'provider_auto_opt_out')
        then 'opted_out'
      else 'consent_captured'
    end,
    jsonb_build_object(
      'channel', consent.channel,
      'consent_type', consent.event_type
    ),
    case
      when consent.event_type in ('opt_out', 'provider_auto_opt_out')
        then 'consent_events.opt_out'
      else 'consent_events.consent_captured'
    end,
    consent.id,
    consent.occurred_at
  from public.consent_events consent
  join public.properties property
    on property.org_id = consent.org_id
   and property.id::text = consent.source_detail ->> 'propertyId'
   and property.homeowner_contact_id = consent.contact_id
   and property.created_at <= consent.occurred_at
  where consent.event_type in (
    'opt_in_marketing_written',
    'opt_in_informational',
    'opt_in_confirmed',
    'opt_out',
    'provider_auto_opt_out'
  )
)
insert into public.lead_events (
  org_id,
  property_id,
  actor_type,
  actor_id,
  event_type,
  payload,
  source_type,
  source_id,
  created_at
)
select
  candidate.org_id,
  candidate.property_id,
  candidate.actor_type,
  candidate.actor_id,
  candidate.event_type,
  candidate.payload,
  candidate.source_type,
  candidate.source_id,
  candidate.created_at
from candidates candidate
where not (
    candidate.event_type = 'qualified'
    and exists (
      select 1
      from public.lead_events existing
      where existing.property_id = candidate.property_id
        and existing.event_type = 'qualified'
    )
  )
  and not (
    candidate.event_type = 'task_completed'
    and exists (
      select 1
      from public.lead_events existing
      where existing.property_id = candidate.property_id
        and existing.event_type = 'task_completed'
        and existing.payload ->> 'task_id' = candidate.payload ->> 'task_id'
    )
  )
on conflict do nothing;

commit;
