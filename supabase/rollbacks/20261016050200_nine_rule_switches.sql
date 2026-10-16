-- Rollback for 20261016050200_nine_rule_switches. Drops the setter, the log trigger, the
-- log table and the two switch columns; the engine then always sends the identity reply
-- and starts the Confirmed owner drip (PR 3 behaviour). Idempotent.
begin;

drop function if exists public.fn_set_ai_rule_switch(uuid, text, text);
drop trigger if exists trg_log_ai_rule_switch on public.ai_responder_configs;
drop function if exists public.fn_log_ai_rule_switch();
drop table if exists public.ai_rule_switch_events;
alter table public.ai_responder_configs drop column if exists nine_confirmed_owner_drip;
alter table public.ai_responder_configs drop column if exists nine_identity_reply;

commit;
