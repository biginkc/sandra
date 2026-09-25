-- Root review of f3ab9e1e (jev-root-round18-prelimit-dedup.md):
-- remaining P2 starvation bug — 20260921070948 moved promoted/reconciled
-- filtering before the limit, but left "latest wins per
-- source_inbound_message_id" deduplication to queries.ts AFTER
-- limit(100). If one inbound has MORE than 100 eligible failed-retry
-- rows, the 100 oldest fill the entire DB result on their own,
-- application dedup collapses them to a single item, and a genuinely
-- distinct newer actionable inbound never reaches the query at all —
-- the same starvation shape as the finding this view was built to fix,
-- just moved one step later. The prior migration's own comment calling
-- this "a presentation concern" was wrong: because dedup ran after
-- LIMIT, it directly affected eligibility/visibility, not just display.
--
-- Fixed: the view itself now returns AT MOST ONE row per
-- source_inbound_message_id — the deterministic latest eligible
-- candidate (created_at desc, id desc as a stable tie-break for an
-- exact-timestamp collision) — via DISTINCT ON, evaluated AFTER the
-- same unpromoted/unreconciled WHERE predicates as before (SQL applies
-- WHERE before DISTINCT ON/ORDER BY, so only already-eligible rows are
-- ever candidates for the per-inbound pick). limit(100) at the call
-- site now applies to already-deduped, already-eligible rows — no
-- number of retries on one inbound can crowd out a distinct actionable
-- event on another. security_invoker/RLS and ordering behavior are
-- otherwise unchanged from 20260921070948.

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
  )
order by cr.source_inbound_message_id, cr.created_at desc, cr.id desc;

grant select on public.jev_needs_decision_classifier_events to authenticated;
