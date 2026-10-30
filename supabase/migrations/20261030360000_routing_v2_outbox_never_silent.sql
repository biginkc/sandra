-- Routing v2 cutover, review of #949 B1: an authorized reply is never lost silently.
--
-- send.ts writes the outbound row (messages.idempotency_key = outbox id) BEFORE the provider
-- fence and the provider call. So once the reconcile window has passed:
--   * no keyed message row        -> provably never submitted: cancelled not_sent:no_message_row;
--   * keyed row sent / delivered  -> sent (receipt = the message);
--   * keyed row failed / bounced  -> cancelled not_sent:provider_failed;
--   * keyed row still pending / sending after p_unknown_hold_minutes -> cancelled
--     unknown:held_for_person (delivery_state stays 'unknown': it may have gone out).
-- Every cancelled outcome also sets hold_pending; the consumer writes today's hold
-- (nine_reply_not_sent:<reason>) and then clears it (routing_v2_outbox_holds_due /
-- routing_v2_mark_outbox_hold_written), so a crash between the two re-holds, never drops.
-- Rows leave `claimed` at the latest after p_unknown_hold_minutes, so stuck rows can no longer
-- fill the reconcile window and starve newer ones.
--
-- routing_v2_reconcile_outbox is re-created from its 20261030330000 body with those branches.
-- Additive; no rows exist while routing_v2 is off.
-- Rollback: supabase/rollbacks/20261030360000_routing_v2_outbox_never_silent.sql
begin;
set local lock_timeout = '5s';

alter table public.routing_v2_outbox add column if not exists hold_pending boolean not null default false;
create index if not exists routing_v2_outbox_hold_pending_idx
  on public.routing_v2_outbox (created_at) where hold_pending;

drop function if exists public.routing_v2_reconcile_outbox(integer);
create or replace function public.routing_v2_reconcile_outbox(
  p_older_than_seconds integer default 180,
  p_unknown_hold_minutes integer default 30
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
  v_sent integer := 0;
  v_failed integer := 0;
  v_never integer := 0;
  v_held_unknown integer := 0;
  v_open integer := 0;
begin
  for r in
    select o.id, o.property_id, o.authorized_at, m.id as message_id, m.status as message_status
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
      update public.routing_v2_outbox set status='sent', sent_at=now(), provider_receipt=r.message_id::text, delivery_state=null
        where id=r.id and status='claimed';
      v_sent := v_sent + 1;
    elsif r.message_status in ('failed','bounced') then
      update public.routing_v2_outbox set status='cancelled', cancel_reason='not_sent:provider_failed', delivery_state=null, hold_pending=true
        where id=r.id and status='claimed';
      v_failed := v_failed + 1;
    elsif r.message_id is null then
      -- The keyed row is written before the provider call: no row = never submitted.
      update public.routing_v2_outbox set status='cancelled', cancel_reason='not_sent:no_message_row', delivery_state=null, hold_pending=true
        where id=r.id and status='claimed';
      v_never := v_never + 1;
    elsif r.authorized_at < now() - make_interval(mins => greatest(p_unknown_hold_minutes, 5)) then
      update public.routing_v2_outbox set status='cancelled', cancel_reason='unknown:held_for_person',
        delivery_state='unknown', delivery_note='message_'||r.message_status, hold_pending=true
        where id=r.id and status='claimed';
      v_held_unknown := v_held_unknown + 1;
    else
      update public.routing_v2_outbox set delivery_state='unknown', delivery_note='message_'||r.message_status
        where id=r.id and status='claimed';
      v_open := v_open + 1;
    end if;
  end loop;
  return jsonb_build_object('sent', v_sent, 'not_sent', v_failed, 'never_submitted', v_never,
    'held_unknown', v_held_unknown, 'unknown', v_open);
end;
$$;

-- Replies whose seller did not get them and whose hold is not yet written.
create or replace function public.routing_v2_outbox_holds_due(p_limit integer default 50)
returns table (outbox_id uuid, property_id uuid, reason text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select o.id, o.property_id, coalesce(o.cancel_reason, 'unknown')
  from public.routing_v2_outbox o
  where o.hold_pending
  order by o.created_at
  limit greatest(least(coalesce(p_limit, 50), 200), 1);
$$;

create or replace function public.routing_v2_mark_outbox_hold_written(p_outbox_id uuid)
returns text
language sql security definer set search_path = public, pg_temp
as $$
  update public.routing_v2_outbox set hold_pending = false where id = p_outbox_id and hold_pending
  returning 'ok';
$$;

do $$
declare f text;
begin
  foreach f in array array['routing_v2_reconcile_outbox(integer,integer)', 'routing_v2_outbox_holds_due(integer)',
    'routing_v2_mark_outbox_hold_written(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
commit;
