-- Rollback for 20261008260000_nurture_auto_drip. Drops the switch columns,
-- their constraint and the owner-only RPC. Idempotent.
begin;

drop function if exists public.fn_set_nurture_auto_drip(uuid, boolean, uuid);
alter table public.ai_responder_configs
  drop constraint if exists ai_responder_configs_nurture_auto_drip_sequence_check;
alter table public.ai_responder_configs
  drop column if exists nurture_auto_drip,
  drop column if exists nurture_auto_drip_sequence_id;

commit;
