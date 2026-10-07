-- Rollback for 20261008141600_ai_responder_configs_classifier_cutover_guard.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Triggers
drop trigger if exists trg_ai_responder_configs_classifier_cutover_guard on public.ai_responder_configs;

-- Functions this migration created (no prior version): drop.
drop function if exists public.ai_responder_configs_classifier_cutover_guard();

commit;
