-- Routing v2 backfill (Astra review of 276f79b9, finding 1): record a backfill decision only if
-- its seller text is still the NEWEST inbound text on the lead. The check runs under the same
-- per-property advisory lock the atomic safety recorder takes and in the same transaction as the
-- decision row and (for a safety decision) its hold, drip pause and reply cancel, so a newer
-- seller text that is already committed always wins: nothing is recorded or held for the old one.
-- Used only by scripts/routing-v2-backfill.ts (the live path keeps routing_v2_record_live_decision).
-- Additive. Rollback: supabase/rollbacks/20261031132300_routing_v2_backfill_record_if_newest.sql
begin;
set local lock_timeout = '5s';

create or replace function public.routing_v2_backfill_record_live_decision(p_row jsonb, p_hold_reason text default null)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_property uuid := (p_row->>'property_id')::uuid;
  v_inbound uuid := (p_row->>'inbound_message_id')::uuid;
  v_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v_property::text));
  select m.created_at into v_at from public.messages m
    where m.id = v_inbound and m.property_id = v_property and m.direction = 'inbound';
  if v_at is null then return 'newer_inbound'; end if;
  if exists (
    select 1 from public.messages m
    where m.property_id = v_property and m.direction = 'inbound' and m.channel = 'sms' and m.id <> v_inbound
      and (m.created_at > v_at or (m.created_at = v_at and m.id > v_inbound))
  ) then
    return 'newer_inbound';
  end if;
  return public.routing_v2_record_live_decision(p_row, p_hold_reason);
end;
$$;
revoke all on function public.routing_v2_backfill_record_live_decision(jsonb, text) from public, anon, authenticated;
grant execute on function public.routing_v2_backfill_record_live_decision(jsonb, text) to service_role;

commit;
