-- Fable re-review of e5d001bb (fable-final-review-e5d001bb.json,
-- jev-root-round17-fable2-fixes.md), finding 2 — P2 Needs-a-decision
-- starvation:
--
-- getNeedsDecisionQueue() fetched the 100 OLDEST matching
-- sms_classification_runs rows, then filtered out already-promoted and
-- already-reconciled ones in application code (round 11/12 fixes).
-- sms_classification_runs is immutable audit evidence, so once the 100
-- oldest candidates are ALL promoted/reconciled, a genuinely newer
-- unclear/failed event can never reach the LIMIT window — it's
-- permanently invisible to Needs-a-decision even though it's the one
-- actionable item left.
--
-- Fixed by moving eligibility BEFORE the limit, at the database query
-- boundary: a security_invoker view does the promoted/reconciled
-- exclusion server-side. security_invoker (PG15+) means the view runs
-- with the CALLING role's privileges — the existing org-scoped RLS
-- policies on sms_classification_runs and jev_lead_decisions apply
-- exactly as if the caller queried those tables directly; this view
-- adds no new authorization surface, it only reshapes an already-
-- authorized read. limit(100) at the call site now applies to actually-
-- eligible rows, so a genuinely newer actionable event is never starved
-- out by older, already-resolved ones.
--
-- Per-inbound "latest wins" DEDUPLICATION (round 12) still happens in
-- application code on the (now-eligible, capped-at-100) result set —
-- that's a presentation concern (which of several eligible candidates
-- for the SAME inbound to show), not an eligibility concern, and
-- operating on <=100 already-eligible rows is bounded, not an unbounded
-- scan.

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

grant select on public.jev_needs_decision_classifier_events to authenticated;
