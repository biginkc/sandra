-- Rollback for 20261008140400_jev_deferred_disposition_proposal.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_propose_deferred_ai_disposition_review(uuid, uuid, uuid, text, text);

commit;
