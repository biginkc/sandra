-- Rollback for 20261008142200_jev_needs_decision_dedup_before_limit.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Views
-- view jev_needs_decision_classifier_events: restore prior definition
drop view if exists public.jev_needs_decision_classifier_events;
create or replace view public.jev_needs_decision_classifier_events
with (security_invoker = true) as
select
  cr.id,
  cr.org_id,
  cr.property_id,
  cr.conversation_id,
  cr.source_inbound_message_id,
  cr.resolved_outcome,
  cr.fallback_reason,
  cr.model,
  cr.schema_version,
  cr.policy_version,
  cr.decision,
  cr.created_at
from public.sms_classification_runs cr
where cr.provider = 'jev'
  and (cr.fallback_reason is not null or cr.resolved_outcome in ('unclear', 'bad_number'))
  -- Not already promoted into a real, actionable jev_lead_decisions row.
  and not exists (
    select 1
    from public.jev_lead_decisions d
    where d.classification_run_id = cr.id
  )
  -- Not a stale failure superseded by a later successful (non-fallback)
  -- retry on the SAME inbound (round 11/12 reconciliation) — a
  -- successful run's own fallback_reason is always null, so failures
  -- never exclude themselves here.
  and (
    cr.fallback_reason is null
    or not exists (
      select 1
      from public.sms_classification_runs succ
      where succ.provider = 'jev'
        and succ.fallback_reason is null
        and succ.source_inbound_message_id = cr.source_inbound_message_id
    )
  );

-- Tables / columns / constraints
grant select on public.jev_needs_decision_classifier_events to authenticated;

commit;
