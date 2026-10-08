-- Rollback for 20261008260000_nurture_auto_drip. Drops the switch columns,
-- their constraint and the owner-only RPC. Idempotent.
begin;

drop function if exists public.fn_set_nurture_auto_drip(uuid, boolean, uuid, uuid, uuid, uuid);
alter table public.ai_responder_configs
  drop constraint if exists ai_responder_configs_nurture_auto_drip_sequences_check;
alter table public.ai_responder_configs
  drop column if exists nurture_auto_drip,
  drop column if exists nurture_drip_maybe_later_sequence_id,
  drop column if exists nurture_drip_check_in_60_sequence_id,
  drop column if exists nurture_drip_listed_not_selling_sequence_id,
  drop column if exists nurture_drip_hot_book_appointment_sequence_id;

commit;
