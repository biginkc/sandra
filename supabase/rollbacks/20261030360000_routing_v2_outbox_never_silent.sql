-- Rollback for 20261030360000: restore the 20261030330000 reconcile body; drop the hold helpers.
begin;
set local lock_timeout = '5s';
drop function if exists public.routing_v2_mark_outbox_hold_written(uuid);
drop function if exists public.routing_v2_outbox_holds_due(integer);
drop function if exists public.routing_v2_reconcile_outbox(integer,integer);
create or replace function public.routing_v2_reconcile_outbox(p_older_than_seconds integer default 180)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
  v_sent integer := 0;
  v_failed integer := 0;
  v_open integer := 0;
begin
  for r in
    select o.id, o.property_id, m.id as message_id, m.status as message_status
    from public.routing_v2_outbox o
    left join public.messages m on m.org_id = o.org_id and m.channel = 'sms' and m.direction = 'outbound'
      and m.idempotency_key = o.id
    where o.kind = 'reply' and o.status = 'claimed' and o.authorized_at is not null
      and o.authorized_at < now() - make_interval(secs => greatest(p_older_than_seconds, 60))
    order by o.authorized_at
    limit 200
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || r.property_id::text));
    if r.message_status in ('sent','delivered') then
      update public.routing_v2_outbox set status='sent', sent_at=now(), provider_receipt='message:'||r.message_id, delivery_state=null
        where id=r.id and status='claimed';
      v_sent := v_sent + 1;
    elsif r.message_status in ('failed','bounced') then
      update public.routing_v2_outbox set status='cancelled', cancel_reason='not_sent:provider_failed', delivery_state=null
        where id=r.id and status='claimed';
      v_failed := v_failed + 1;
    else
      update public.routing_v2_outbox set delivery_state='unknown',
        delivery_note=coalesce(delivery_note, case when r.message_id is null then 'no_message_row' else 'message_'||r.message_status end)
        where id=r.id and status='claimed';
      v_open := v_open + 1;
    end if;
  end loop;
  return jsonb_build_object('sent', v_sent, 'not_sent', v_failed, 'unknown', v_open);
end;
$$;
revoke all on function public.routing_v2_reconcile_outbox(integer) from public, anon, authenticated;
grant execute on function public.routing_v2_reconcile_outbox(integer) to service_role;
drop index if exists public.routing_v2_outbox_hold_pending_idx;
alter table public.routing_v2_outbox drop column if exists hold_pending;
commit;
