-- Rollback for 20261008142100_jev_needs_decision_eligibility_view.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Views
drop view if exists public.jev_needs_decision_classifier_events;

commit;
