-- 20261016010000_hold_alert_claim_with_cap.sql
-- Messages v2 PR 2 (hot sellers): reserve the hourly cap and claim a delivery
-- in ONE transaction. Two concurrent alert passes used to check the cap and
-- then claim separately, so both could send into the last free slot and
-- exceed 20 Slack DMs per recipient / 10 SMS per org per hour.
--
-- hold_alert_claim_with_cap takes a transaction-scoped advisory lock per
-- (org, channel, recipient-or-org) cap bucket, counts sent + sending rows in
-- the window, and only if under the cap performs the same conditional claim
-- the app did before (pending/failed, matching attempts -> sending). Returns
-- 'claimed', 'capped' or 'lost' (another run got it / no longer claimable).
-- Additive: one new function, no table change. Rollback:
-- supabase/rollbacks/20261016010000_hold_alert_claim_with_cap.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.hold_alert_claim_with_cap(
  p_id uuid,
  p_attempts integer,
  p_org_id uuid,
  p_channel text,
  p_recipient_user_id uuid,
  p_cap integer,
  p_since timestamptz
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'hold_alert_cap:' || p_org_id::text || ':' || p_channel || ':' || coalesce(p_recipient_user_id::text, '*'),
      0
    )
  );

  select count(*)
    into v_count
    from public.hold_alert_deliveries d
   where d.org_id = p_org_id
     and d.channel = p_channel
     and (p_recipient_user_id is null or d.recipient_user_id = p_recipient_user_id)
     and (
       (d.status = 'sent' and d.sent_at >= p_since)
       or (d.status = 'sending' and d.sending_at >= p_since)
     );

  if v_count >= p_cap then
    return 'capped';
  end if;

  update public.hold_alert_deliveries d
     set status = 'sending',
         sending_at = now(),
         attempts = d.attempts + 1
   where d.id = p_id
     and d.status in ('pending', 'failed')
     and d.attempts = p_attempts;

  if found then
    return 'claimed';
  end if;
  return 'lost';
end;
$$;

revoke all on function public.hold_alert_claim_with_cap(uuid, integer, uuid, text, uuid, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hold_alert_claim_with_cap(uuid, integer, uuid, text, uuid, integer, timestamptz)
  to service_role;

commit;
