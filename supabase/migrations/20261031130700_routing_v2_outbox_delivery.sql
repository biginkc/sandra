-- Routing v2 cutover (b): concrete transactional outbox delivery.
--
-- Flow for a seller reply (consumer in ai-responder/dispatch.ts):
--   routing_v2_claim_outbox (pending -> claimed; PR-F 230000)
--   -> routing_v2_authorize_outbox_send (sets authorized_at once; PR-F 230000)
--   -> provider boundary: routing_v2_check_authorized_outbox_send (300000), then the provider
--      send keyed by the outbox id (messages.idempotency_key = outbox id: a replay never sends
--      a second time)
--   -> routing_v2_mark_outbox_sent(id, receipt)   (accepted, receipt recorded)
--   or routing_v2_mark_outbox_not_sent(id, reason) (provably never handed to the provider)
--   or routing_v2_mark_outbox_unknown(id, reason)  (may have sent: NEVER retried; reconciled)
-- Owner alerts: routing_v2_alert_delivery_gate (claim -> authorize -> provider-boundary check,
-- N2), then the existing hold-alert fan-out (its delivery table owns per-channel at-most-once).
--
-- Recovery: routing_v2_release_stale_outbox_claims returns a claim that was NEVER authorized
-- to pending (no provider call can have happened). routing_v2_reconcile_outbox settles an
-- authorized reply from the durable message row carrying its idempotency key.
--
-- Additive; nothing here changes a row while routing_v2 is off (no outbox rows exist).
-- Rollback: supabase/rollbacks/20261031130700_routing_v2_outbox_delivery.sql
begin;
set local lock_timeout = '5s';

alter table public.routing_v2_outbox
  add column if not exists provider_receipt text,
  add column if not exists delivery_state text,
  add column if not exists delivery_note text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='routing_v2_outbox_delivery_state_check') then
    alter table public.routing_v2_outbox add constraint routing_v2_outbox_delivery_state_check
      check (delivery_state is null or delivery_state in ('unknown'));
  end if;
end $$;
create index if not exists routing_v2_outbox_due_idx
  on public.routing_v2_outbox (created_at) where status in ('pending','claimed');

create or replace function public.routing_v2_mark_outbox_sent(p_outbox_id uuid, p_receipt text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v public.routing_v2_outbox;
begin
  if nullif(btrim(coalesce(p_receipt,'')),'') is null then return 'missing_receipt'; end if;
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id for update;
  if v.status = 'sent' then
    return case when v.provider_receipt = p_receipt then 'ok' else 'receipt_mismatch' end;
  end if;
  -- Only an authorized claim can have reached the provider.
  if v.status <> 'claimed' or v.authorized_at is null then return 'not_authorized'; end if;
  update public.routing_v2_outbox
    set status = 'sent', sent_at = now(), provider_receipt = p_receipt, delivery_state = null
    where id = v.id;
  return 'ok';
end;
$$;

create or replace function public.routing_v2_mark_outbox_not_sent(p_outbox_id uuid, p_reason text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v public.routing_v2_outbox;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id for update;
  if v.status in ('sent','cancelled') then return 'already_' || v.status; end if;
  -- An "unknown" outcome is never downgraded to not-sent by a caller; only reconcile may.
  if v.delivery_state = 'unknown' then return 'unknown'; end if;
  update public.routing_v2_outbox
    set status = 'cancelled', cancel_reason = 'not_sent:' || coalesce(nullif(p_reason,''),'unspecified')
    where id = v.id;
  return 'ok';
end;
$$;

create or replace function public.routing_v2_mark_outbox_unknown(p_outbox_id uuid, p_reason text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v public.routing_v2_outbox;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id for update;
  if v.status <> 'claimed' then return 'not_claimed'; end if;
  update public.routing_v2_outbox
    set delivery_state = 'unknown', delivery_note = coalesce(nullif(p_reason,''),'unknown')
    where id = v.id;
  return 'ok';
end;
$$;

-- A claim taken but never authorized cannot have reached the provider: back to pending.
create or replace function public.routing_v2_release_stale_outbox_claims(p_older_than_seconds integer default 300)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  update public.routing_v2_outbox
    set status = 'pending', claimed_at = null
    where status = 'claimed' and authorized_at is null
      and claimed_at < now() - make_interval(secs => greatest(p_older_than_seconds, 60));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Settle authorized replies from the durable outbound row keyed by the outbox id.
-- sent/delivered -> sent; failed/bounced -> not sent. Anything else stays for a person.
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

-- Due seller replies (oldest first). The claim re-checks everything; this is only a list.
create or replace function public.routing_v2_due_outbox_replies(p_limit integer default 20, p_property_id uuid default null)
returns setof public.routing_v2_outbox
language sql stable security definer set search_path = public, pg_temp
as $$
  select * from public.routing_v2_outbox
  where kind = 'reply' and status = 'pending' and (p_property_id is null or property_id = p_property_id)
  order by created_at
  limit greatest(least(coalesce(p_limit, 20), 100), 1);
$$;

-- Owner-alert gate, called by the hold-alert fan-out before each channel send (N2).
-- pending -> claim -> authorize; an authorized row is re-checked at the provider boundary
-- (check_authorized: fresh flags, slice, canary, alert_on_time_only for a yes alert) and then
-- marked sent once (receipt = the fan-out delivery key). A sent row is re-checked for flags
-- only, so another channel / a retry of the same alert may go out, never a second alert.
create or replace function public.routing_v2_alert_delivery_gate(p_outbox_id uuid, p_receipt text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_outbox;
  v_r text;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  if v.kind <> 'alert' then return 'not_alert'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id for update;
  if v.status = 'cancelled' then return coalesce(v.cancel_reason, 'cancelled'); end if;
  if v.status = 'sent' then
    if v.engine is distinct from 'v2' or not public.routing_v2_slice_enabled(v.property_id, v.slice) then return 'flag_off'; end if;
    if v.payload->'when_time_only_off' = 'true'::jsonb
       and public.routing_v2_slice_enabled(v.property_id,'drips')
       and public.routing_v2_slice_enabled(v.property_id,'alert_on_time_only') then
      return 'time_only_alert_disabled';
    end if;
    return 'ok';
  end if;
  if v.status = 'pending' then
    v_r := public.routing_v2_claim_outbox(p_outbox_id);
    if v_r <> 'ok' then return v_r; end if;
  end if;
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if v.authorized_at is null then
    v_r := public.routing_v2_authorize_outbox_send(p_outbox_id);
    if v_r <> 'ok' then return v_r; end if;
  end if;
  v_r := public.routing_v2_check_authorized_outbox_send(p_outbox_id, v.property_id, v.inbound_message_id);
  if v_r <> 'ok' then return v_r; end if;
  update public.routing_v2_outbox set status='sent', sent_at=now(), provider_receipt=coalesce(nullif(p_receipt,''),'hold_alert')
    where id = p_outbox_id;
  return 'ok';
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'routing_v2_mark_outbox_sent(uuid,text)', 'routing_v2_mark_outbox_not_sent(uuid,text)',
    'routing_v2_mark_outbox_unknown(uuid,text)', 'routing_v2_release_stale_outbox_claims(integer)',
    'routing_v2_reconcile_outbox(integer)', 'routing_v2_due_outbox_replies(integer,uuid)',
    'routing_v2_alert_delivery_gate(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
-- The consumer needs the claim / authorize / provider-boundary functions too.
grant execute on function public.routing_v2_authorize_outbox_send(uuid) to service_role;
grant execute on function public.routing_v2_check_authorized_outbox_send(uuid,uuid,uuid) to service_role;
commit;
