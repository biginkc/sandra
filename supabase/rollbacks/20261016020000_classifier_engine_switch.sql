-- Rollback for 20261016020000_classifier_engine_switch. Drops the switch column and its
-- constraint; every org falls back to the eight-answer path. Idempotent.
begin;

alter table public.ai_responder_configs drop constraint if exists ai_responder_configs_classifier_engine_check;
alter table public.ai_responder_configs drop column if exists classifier_engine;

commit;
