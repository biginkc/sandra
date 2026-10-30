-- Roll back 20261030140000_routing_v2_versioned_drips.
-- Refuses while any v2 enrollment exists (stop them first: flags.drips = false, then let
-- sequence-tick stop them, or set them completed). Legacy rows are never touched.
begin;
set local routing_v2.allow_drip_edit = 'on';


do $$
begin
  if exists (select 1 from public.sequence_enrollments where routing_v2_engine = 'v2') then
    raise exception 'routing v2 enrollments exist; stop and remove them before rolling back';
  end if;
  if exists (select 1 from public.sequence_enrollments e join public.sequences s on s.id = e.sequence_id
             where s.routing_v2_key is not null) then
    raise exception 'enrollments point at routing v2 drips; remove them before rolling back';
  end if;
end $$;

drop trigger if exists routing_v2_reject_drip_step_edit on public.sequence_steps;
drop trigger if exists routing_v2_reject_drip_edit on public.sequences;
drop function if exists public.routing_v2_reject_drip_edit();
-- Restore pause_enrollments_for_inbound_call exactly as 20261021200300 defined it.
create or replace function public.pause_enrollments_for_inbound_call(p_contact_ids uuid[])
returns table (id uuid, property_id uuid, sequence_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.sequence_enrollments e
     set status = 'paused', pause_reason = 'inbound_call', updated_at = now()
   where e.property_id in (
           select pr.id from public.properties pr where pr.homeowner_contact_id = any(p_contact_ids)
         )
     and (e.status = 'active'
          or (e.status = 'paused'
              and e.pause_reason in ('reconciliation_required', 'call_in_progress', 'norma_call')))
  returning e.id, e.property_id, e.sequence_id;
end;
$$;
revoke all on function public.pause_enrollments_for_inbound_call(uuid[]) from public, anon, authenticated;
grant execute on function public.pause_enrollments_for_inbound_call(uuid[]) to service_role;
drop trigger if exists routing_v2_reject_foreign_enrollment on public.sequence_enrollments;
drop function if exists public.routing_v2_reject_foreign_enrollment();
drop function if exists public.routing_v2_mark_drip_claim_sent(uuid, text);
drop function if exists public.routing_v2_chain_after_completion(uuid);
drop function if exists public.routing_v2_claim_drip_send(uuid, uuid);
drop function if exists public.routing_v2_enrollment_send_check(uuid);
drop function if exists public.routing_v2_claim_outbox(uuid);
drop function if exists public.routing_v2_cancel_for_takeover(uuid);
drop function if exists public.route_reply_transition(uuid, uuid, jsonb);
drop function if exists public.routing_v2_enroll(uuid, uuid, uuid, uuid, uuid);
drop function if exists public.routing_v2_sequence_for(uuid, text);
drop function if exists public.routing_v2_contact_suppressed(uuid, uuid);
drop function if exists public.routing_v2_slice_enabled(uuid, text);
drop table if exists public.routing_v2_drip_send_claims;
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
