-- Rollback for 20261016020100: restore the view as defined by 20261008142300.
begin;

create or replace view public.jev_needs_decision_classifier_events
with (security_invoker = true) as
select distinct on (cr.source_inbound_message_id)
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
  -- Blocker 3: promotion is idempotent by source_inbound_message_id
  -- (jev_lead_decisions has a unique constraint on it), not by
  -- classification_run_id — exclude the whole inbound once ANY decision
  -- exists for it, so an earlier failed run on the same inbound as a
  -- later promoted one can never reappear.
  and not exists (
    select 1
    from public.jev_lead_decisions d
    where d.source_inbound_message_id = cr.source_inbound_message_id
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
  )
order by cr.source_inbound_message_id, cr.created_at desc, cr.id desc;

grant select on public.jev_needs_decision_classifier_events to authenticated;

commit;
