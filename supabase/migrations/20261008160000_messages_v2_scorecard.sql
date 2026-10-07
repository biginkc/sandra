-- Messages v2 Phase 3: per-outcome shadow scorecard.
--
-- READ-ONLY. A SECURITY INVOKER function, so every table read below is
-- filtered by the caller's own RLS (another org's member gets zeros). It
-- displays and suggests; it never writes thresholds, flags or dispositions.
--
-- Per Jev outcome over a trailing window (days, clamped 1..90) it returns:
--   runs            Jev classification runs created in the window
--   auto_applied    runs the system applied with no human step
--                   (ai_disposition_reviews.status = auto_accepted, or a
--                   jev_lead_decisions row created already-resolved)
--   held            runs routed to a human (pending / human-resolved)
--   auto_settled    auto-applied runs with a verdict: corrected inside 72h
--                   (disagree), or older than 72h and not corrected (agree)
--   auto_agreed     ... of which agreed
--   held_decided    held runs a human has since decided
--   held_agreed     ... of which the human kept Jev's outcome
--   threshold, automation_enabled   current jev_outcome_thresholds row
--   samples         [[native_confidence, agreed 0|1, route], ...] for every run
--                   with a verdict and a numeric native confidence; route is
--                   'a' (auto-applied) or 'h' (held then human-decided), so
--                   auto-settled and held-decided agreement are never blended.
--                   The app turns these into the suggested threshold.
--
-- "Corrected" means: corrected_disposition on the review (any time for held
-- rows, <= 72h after the run for auto rows), the first
-- jev_lead_decision_corrected event, or a lead_events dispo_set by a user
-- within 72h that sets a different disposition (not used for new_lead, whose
-- promotion is a status change, not a disposition). A review superseded by a
-- human changing the disposition counts as a held disagreement; any other
-- superseded row only counts as a run (no verdict). Nurture is a parking step:
-- a human dispo_set to needs_sequence after a nurture run (what
-- setInboxDispoAndStartDrip writes) agrees with Jev and is not an override.
-- Auto rows younger than 72h and not yet corrected are auto_applied but not
-- settled, so a fresh burst cannot inflate agreement.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.fn_messages_v2_scorecard(
  p_org_id uuid,
  p_window_days integer default 7
)
returns table (
  outcome text,
  runs bigint,
  auto_applied bigint,
  held bigint,
  auto_settled bigint,
  auto_agreed bigint,
  held_decided bigint,
  held_agreed bigint,
  threshold numeric,
  automation_enabled boolean,
  samples jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select now() as at,
           make_interval(days => greatest(1, least(coalesce(p_window_days, 7), 90))) as win
  ),
  outcomes(ord, outcome) as (
    values (1, 'new_lead'), (2, 'wrong_number'), (3, 'not_interested'),
           (4, 'nurture'), (5, 'opted_out')
  ),
  runs as (
    select r.id, r.org_id, r.property_id, r.created_at,
           r.resolved_outcome as outcome,
           case when jsonb_typeof(r.decision -> 'nativeConfidence') = 'number'
                then (r.decision ->> 'nativeConfidence')::numeric end as conf
    from public.sms_classification_runs r, params p
    where r.org_id = p_org_id
      and r.provider = 'jev'
      and r.created_at >= p.at - p.win
      and r.resolved_outcome in (select o.outcome from outcomes o)
  ),
  review_rows as (
    select r.id as run_id,
           x.route,
           case
             when x.route = 'auto' then
               case
                 when (v.corrected_at is not null and v.corrected_at <= r.created_at + interval '72 hours')
                   or x.override then 0
                 when r.created_at <= p.at - interval '72 hours' then 1
               end
             when x.route = 'held' then
               case
                 when v.corrected_disposition is not null or x.override then 0
                 when v.status = 'confirmed' then 1
               end
           end as verdict
    from runs r
    cross join params p
    join public.ai_disposition_reviews v
      on v.classification_run_id = r.id and v.org_id = r.org_id
    cross join lateral (
      select exists (
               select 1 from public.lead_events e
               where e.org_id = r.org_id and e.property_id = r.property_id
                 and e.event_type = 'dispo_set' and e.actor_type = 'user'
                 and e.created_at > r.created_at
                 and e.created_at <= r.created_at + interval '72 hours'
                 and e.payload ->> 'to' is distinct from v.disposition
                 and not (v.disposition = 'nurture' and e.payload ->> 'to' = 'needs_sequence')
             ) as override
    ) o
    cross join lateral (
      select o.override,
             case
               when v.status = 'auto_accepted' then 'auto'
               when v.status in ('pending', 'confirmed') then 'held'
               when v.status = 'superseded' and o.override then 'held'
             end as route
    ) x
  ),
  decision_rows as (
    select r.id as run_id,
           x.route,
           case
             when x.route = 'auto' then
               case
                 when (fc.at is not null and fc.at <= r.created_at + interval '72 hours')
                   or x.override then 0
                 when r.created_at <= p.at - interval '72 hours' then 1
               end
             when x.route = 'held' then
               case
                 when j.status = 'corrected' or x.override then 0
                 when j.status = 'confirmed' then 1
               end
           end as verdict
    from runs r
    cross join params p
    join public.jev_lead_decisions j
      on j.classification_run_id = r.id and j.org_id = r.org_id
    left join lateral (
      select e.created_at as at,
             (e.payload ->> 'previous_resolved_outcome') is null as was_pending
      from public.lead_events e
      where e.org_id = j.org_id and e.property_id = j.property_id
        and e.event_type = 'jev_lead_decision_corrected'
        and e.payload ->> 'decision_id' = j.id::text
      order by e.created_at asc
      limit 1
    ) fc on true
    cross join lateral (
      select r.outcome <> 'new_lead' and exists (
               select 1 from public.lead_events e
               where e.org_id = r.org_id and e.property_id = r.property_id
                 and e.event_type = 'dispo_set' and e.actor_type = 'user'
                 and e.created_at > r.created_at
                 and e.created_at <= r.created_at + interval '72 hours'
                 and e.payload ->> 'to' is distinct from r.outcome
                 and not (r.outcome = 'nurture' and e.payload ->> 'to' = 'needs_sequence')
             ) as override,
             exists (
               select 1 from public.lead_events e
               where e.org_id = j.org_id and e.property_id = j.property_id
                 and e.event_type = 'jev_lead_decision_confirmed'
                 and e.source_id = j.id
             ) as was_confirmed
    ) c
    cross join lateral (
      select c.override,
             case
               when j.status = 'pending' then 'held'
               when j.status = 'confirmed' and j.resolved_by is null then 'auto'
               when j.status = 'confirmed' then 'held'
               when j.status = 'corrected'
                 and not c.was_confirmed
                 and coalesce(fc.was_pending, true) = false then 'auto'
               when j.status = 'corrected' then 'held'
             end as route
    ) x
  ),
  scored as (
    select r.id, r.outcome, r.conf,
           coalesce(rr.route, dr.route) as route,
           coalesce(rr.verdict, dr.verdict) as verdict
    from runs r
    left join review_rows rr on rr.run_id = r.id
    left join decision_rows dr on dr.run_id = r.id
  )
  select o.outcome,
         count(s.id)::bigint,
         (count(*) filter (where s.route = 'auto'))::bigint,
         (count(*) filter (where s.route = 'held'))::bigint,
         (count(*) filter (where s.route = 'auto' and s.verdict is not null))::bigint,
         (count(*) filter (where s.route = 'auto' and s.verdict = 1))::bigint,
         (count(*) filter (where s.route = 'held' and s.verdict is not null))::bigint,
         (count(*) filter (where s.route = 'held' and s.verdict = 1))::bigint,
         t.min_confidence,
         t.automation_enabled,
         coalesce(
           jsonb_agg(jsonb_build_array(s.conf, s.verdict, case s.route when 'auto' then 'a' else 'h' end)
                           order by s.conf, s.verdict, s.route)
             filter (where s.verdict is not null and s.conf is not null),
           '[]'::jsonb
         )
  from outcomes o
  left join scored s on s.outcome = o.outcome
  left join public.jev_outcome_thresholds t
    on t.org_id = p_org_id and t.outcome = o.outcome
  group by o.ord, o.outcome, t.min_confidence, t.automation_enabled
  order by o.ord;
$$;

comment on function public.fn_messages_v2_scorecard(uuid, integer) is
  'Messages v2 scorecard: per Jev outcome, runs / auto vs held / human agreement over a trailing window, plus [confidence, agreed, route] samples for the threshold suggestion. SECURITY INVOKER read-only; never writes.';

revoke all on function public.fn_messages_v2_scorecard(uuid, integer) from public, anon;
grant execute on function public.fn_messages_v2_scorecard(uuid, integer) to authenticated, service_role;

commit;
