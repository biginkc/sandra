-- Retire the synthetic acceptance lead (TECH-PLAN Phase 4, item 4.7). Lifecycle cancellation plus
-- soft retirement; NOTHING is deleted (appointments carry a delete guard, Dialpad intents/events are
-- permanent evidence). Run the dry run first and attach the inventory to the receipt:
--
--   psql "$SANDRA_PRODUCTION_DATABASE_URL" -v run_tag='PROD-CANARY <runId>' -v org_id=<uuid> \
--        -v owner_uid=<uuid> [-v max_expected=1] -v commit=no \
--        -f scripts/my-leads-close/rollback/retire-synthetic-lead.sql
--
-- Safety (every check runs before any write):
--   * run_tag must match ^PROD-CANARY [A-Za-z0-9-]{6,}$ (no wildcard characters, no short tags),
--   * org_id is required and scopes every read and write,
--   * a candidate is a non-training, non-deleted property in that org whose address starts with the
--     (LIKE-escaped) tag AND whose homeowner contact has first_name = the tag (the fixture writes it),
--   * the candidate count must be between 1 and max_expected (default 1) or the script aborts,
--   * candidate ids are printed before any write,
--   * only `-v commit=yes` commits; anything else rolls back at the end.
\set ON_ERROR_STOP on

\if :{?run_tag}
\else
  do $$ begin raise exception 'ABORT: -v run_tag is required'; end $$;
\endif
\if :{?org_id}
\else
  do $$ begin raise exception 'ABORT: -v org_id is required'; end $$;
\endif
\if :{?owner_uid}
\else
  do $$ begin raise exception 'ABORT: -v owner_uid is required'; end $$;
\endif
\if :{?max_expected}
\else
  \set max_expected 1
\endif
\if :{?commit}
\else
  \set commit no
\endif

select (:'run_tag' ~ '^PROD-CANARY [A-Za-z0-9-]{6,}$') as tag_ok,
       (:'org_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as org_ok,
       (:'owner_uid' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as owner_ok,
       (:'max_expected' ~ '^[1-9][0-9]?$') as max_ok,
       (:'commit' = 'yes') as do_commit \gset
\if :tag_ok
\else
  do $$ begin raise exception 'ABORT: run_tag must match ^PROD-CANARY [A-Za-z0-9-]{6,}$'; end $$;
\endif
\if :org_ok
\else
  do $$ begin raise exception 'ABORT: org_id must be a uuid'; end $$;
\endif
\if :owner_ok
\else
  do $$ begin raise exception 'ABORT: owner_uid must be a uuid'; end $$;
\endif
\if :max_ok
\else
  do $$ begin raise exception 'ABORT: max_expected must be an integer from 1 to 99'; end $$;
\endif

begin;

create temp table _p on commit drop as
  select p.id, p.address
    from public.properties p
    join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = p.org_id
   where p.org_id = :'org_id'::uuid
     and p.is_training = false
     and p.deleted_at is null
     and p.address like replace(replace(replace(:'run_tag', '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
     and c.first_name = :'run_tag';

select count(*) as n_candidates from _p \gset
select (:n_candidates = 0 or :n_candidates > :max_expected) as bad_count \gset
\if :bad_count
  do $$ begin raise exception 'ABORT: candidate count is outside 1..max_expected; nothing was written'; end $$;
\endif

\echo candidates to retire:
select id, address from _p order by address;

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
 where id in (select id from _p) and org_id = :'org_id'::uuid and deleted_at is null;
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

\if :do_commit
  \echo committing
  commit;
\else
  \echo dry run: rolling back
  rollback;
\endif
