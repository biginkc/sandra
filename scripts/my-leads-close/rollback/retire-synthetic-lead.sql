-- Retire the synthetic acceptance lead (TECH-PLAN Phase 4, item 4.7). Lifecycle cancellation plus
-- soft retirement; NOTHING is deleted (appointments carry a delete guard, Dialpad intents/events are
-- permanent evidence). Run the dry run first and attach the inventory to the receipt:
--
--   psql "$SANDRA_PRODUCTION_DATABASE_URL" -v run_tag='PROD-CANARY <runId>' -v owner_uid=<uuid> -v commit=no \
--        -f scripts/my-leads-close/rollback/retire-synthetic-lead.sql
--
-- `-v commit=yes` commits; anything else rolls back at the end.
\set ON_ERROR_STOP on
begin;

create temp table _p on commit drop as
  select id from public.properties where address like :'run_tag' || '%' and is_training = false;

select count(*) as candidate_properties from _p;

-- An in-flight calendar mutation must finish before the lifecycle cancel runs.
select count(*) as calendar_mutations_in_flight
  from public.task_calendar_mutations m
  join public.tasks t on t.id = m.source_task_id
 where t.related_property_id in (select id from _p)
   and m.phase in ('pending','provider_done');

select set_config('request.jwt.claim.sub', :'owner_uid', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

-- 0. a pending offer on the synthetic lead must be declined first so the follow-up chain cancel is not refused.
select o.id as pending_offer_left_for_operator
  from public.acquisition_offers o
 where o.property_id in (select id from _p) and o.outcome = 'pending';

-- 1. open appointments: lifecycle cancellation (never delete)
select public.fn_cancel_appointment(t.id)
  from public.tasks t
 where t.related_property_id in (select id from _p) and t.type = 'appointment' and t.status = 'open';

update public.tasks set status = 'cancelled', updated_at = now()
 where related_property_id in (select id from _p) and type <> 'appointment' and status in ('open','snoozed');

reset role;

-- 2. soft retirement (the queue read excludes deleted properties)
update public.properties set deleted_at = now(), assigned_user_id = null
 where id in (select id from _p) and deleted_at is null;
update public.acquisition_queue_states set archived_at = coalesce(archived_at, now())
 where property_id in (select id from _p);

-- 3. retained inventory for the receipt (immutable evidence stays)
select (select count(*) from _p) as properties_retired,
       (select count(*) from public.tasks where related_property_id in (select id from _p) and status in ('open','snoozed')) as open_tasks_left,
       (select count(*) from public.tasks where related_property_id in (select id from _p) and status = 'cancelled') as tasks_cancelled,
       (select count(*) from public.acquisition_attempts where property_id in (select id from _p)) as attempts_kept,
       (select count(*) from public.acquisition_offers where property_id in (select id from _p)) as offers_kept,
       (select count(*) from public.lead_notes where property_id in (select id from _p)) as notes_kept,
       (select count(*) from public.dialpad_call_intents where property_id in (select id from _p)) as intents_kept;

\if :{?commit}
  \if :commit
    \echo committing
    commit;
  \else
    \echo dry run: rolling back
    rollback;
  \endif
\else
  \echo dry run: rolling back
  rollback;
\endif
