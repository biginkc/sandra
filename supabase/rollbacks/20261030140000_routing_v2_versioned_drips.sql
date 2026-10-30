-- Roll back 20261030140000_routing_v2_versioned_drips.
-- Refuses while any v2 enrollment exists (stop them first: flags.drips = false, then let
-- sequence-tick stop them, or set them completed). Legacy rows are never touched.
begin;

do $$
begin
  if exists (select 1 from public.sequence_enrollments where routing_v2_engine = 'v2') then
    raise exception 'routing v2 enrollments exist; stop and remove them before rolling back';
  end if;
end $$;

drop function if exists public.routing_v2_chain_after_completion(uuid);
drop function if exists public.routing_v2_enrollment_send_check(uuid);
drop function if exists public.routing_v2_claim_outbox(uuid);
drop function if exists public.routing_v2_cancel_for_takeover(uuid);
drop function if exists public.route_reply_transition(uuid, uuid, jsonb);
drop function if exists public.routing_v2_enroll(uuid, uuid, uuid, uuid, uuid);
drop function if exists public.routing_v2_sequence_for(uuid, text);
drop function if exists public.routing_v2_contact_suppressed(uuid, uuid);
drop function if exists public.routing_v2_slice_enabled(uuid, text);
drop table if exists public.routing_v2_outbox;
drop table if exists public.routing_v2_reply_transitions;

-- The seeded drips have no enrollments (checked above); steps cascade.
delete from public.sequences where routing_v2_key is not null;

drop index if exists public.idx_enrollments_routing_v2_one_active;
alter table public.sequence_enrollments drop constraint if exists sequence_enrollments_routing_v2_engine_check;
alter table public.sequence_enrollments
  drop column if exists routing_v2_inbound_id,
  drop column if exists retired_by_inbound_id,
  drop column if exists ended_reason,
  drop column if exists routing_v2_engine;
alter table public.sequence_steps drop constraint if exists sequence_steps_slot_window_check;
alter table public.sequence_steps drop column if exists slot_window;
drop index if exists public.idx_sequences_routing_v2_key_version;
alter table public.sequences drop constraint if exists sequences_routing_v2_key_check;
alter table public.sequences
  drop column if exists routing_v2_then_key,
  drop column if exists routing_v2_version,
  drop column if exists routing_v2_key;

commit;
