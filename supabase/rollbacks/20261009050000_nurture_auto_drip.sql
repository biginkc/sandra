-- Rollback for 20261009050000_nurture_auto_drip. Drops the switch columns,
-- their constraint and the owner-only RPC. Idempotent.
begin;

drop trigger if exists trg_hot_enrollment_takeover_fence on public.sequence_enrollments;
drop function if exists public.fn_hot_enrollment_takeover_fence();
alter table public.sequence_enrollments drop column if exists hot_fence_message_id;
drop trigger if exists trg_pause_hot_drip_on_person_assignment on public.properties;
drop function if exists public.fn_pause_hot_drip_on_person_assignment();
alter table public.properties drop column if exists last_person_takeover_at;
alter table public.sequence_enrollments drop constraint if exists sequence_enrollments_auto_route_check;
alter table public.sequence_enrollments drop column if exists auto_enrolled_route;
drop trigger if exists trg_guard_nurture_mapped_sequence_delete on public.sequences;
drop function if exists public.fn_guard_nurture_mapped_sequence_delete();
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
