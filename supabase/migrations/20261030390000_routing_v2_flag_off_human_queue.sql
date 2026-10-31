-- Routing v2 stress review A-5: a flag-off rollback (sequence-tick routing_v2_stop_disabled)
-- returns the lead to the human queue (BUILD-PLAN §13.3), with the same property write today's
-- markPropertyNeedsAttention makes ('needs_reply', first flag wins). Re-created from its latest
-- body (20261030181000) with only those writes and one more count in the result.
-- Rollback: supabase/rollbacks/20261030390000_routing_v2_flag_off_human_queue.sql
begin;
set local lock_timeout = '5s';
create or replace function public.routing_v2_stop_disabled()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_stopped integer := 0;
  v_opted_out integer := 0;
  v_outbox integer := 0;
  v_held integer := 0;
  v_n integer;
begin
  for r in
    select distinct e.property_id from public.sequence_enrollments e
    where e.routing_v2_engine = 'v2' and e.status in ('active','paused')
      and not public.routing_v2_slice_enabled(e.property_id, 'drips')
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || r.property_id::text));
    if public.routing_v2_slice_enabled(r.property_id, 'drips') then continue; end if;
    if coalesce((select is_dnc_locked from public.properties where id = r.property_id), false) then
      update public.sequence_enrollments
      set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
      where property_id = r.property_id and routing_v2_engine = 'v2' and status in ('active','paused');
      get diagnostics v_n = row_count; v_opted_out := v_opted_out + v_n;
    else
      update public.sequence_enrollments
      set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
      where property_id = r.property_id and routing_v2_engine = 'v2' and status in ('active','paused');
      get diagnostics v_n = row_count; v_stopped := v_stopped + v_n;
      -- Cutover A-5 (§13.3): the lead lands in the human queue, the same write as today's
      -- markPropertyNeedsAttention (first flag wins; an existing hold is kept).
      if v_n > 0 then
        update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'needs_reply',
          last_ai_escalation_at = now(), updated_at = now()
        where id = r.property_id and needs_human_attention = false;
        get diagnostics v_n = row_count; v_held := v_held + v_n;
      end if;
    end if;
    update public.routing_v2_drip_send_claims set status = 'cancelled', cancel_reason = 'flag_off', cancelled_at = now()
    where property_id = r.property_id and status = 'open';
  end loop;

  for r in
    select o.id, o.property_id from public.routing_v2_outbox o
    where o.status = 'pending' and not public.routing_v2_slice_enabled(o.property_id, o.slice)
    order by o.property_id
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || r.property_id::text));
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = 'flag_off'
    where id = r.id and status = 'pending' and not public.routing_v2_slice_enabled(property_id, slice);
    get diagnostics v_n = row_count; v_outbox := v_outbox + v_n;
    -- A cancelled auto reply: the seller was not answered, so a person answers (§13.3).
    if v_n > 0 and exists (select 1 from public.routing_v2_outbox where id = r.id and kind = 'reply') then
      update public.properties set needs_human_attention = true, last_ai_escalation_reason = 'needs_reply',
        last_ai_escalation_at = now(), updated_at = now()
      where id = r.property_id and needs_human_attention = false;
      get diagnostics v_n = row_count; v_held := v_held + v_n;
    end if;
  end loop;

  return jsonb_build_object('enrollments_stopped', v_stopped, 'enrollments_opted_out', v_opted_out,
                            'outbox_cancelled', v_outbox, 'returned_to_human_queue', v_held);
end;
$$;

revoke all on function public.routing_v2_stop_disabled() from public, anon, authenticated;
grant execute on function public.routing_v2_stop_disabled() to service_role;
commit;
