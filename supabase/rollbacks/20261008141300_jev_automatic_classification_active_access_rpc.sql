-- Rollback for 20261008141300_jev_automatic_classification_active_access_rpc.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration created (no prior version): drop.
drop function if exists public.fn_update_jev_automatic_classification(uuid, boolean);

commit;
