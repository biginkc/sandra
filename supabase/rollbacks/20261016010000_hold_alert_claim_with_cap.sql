-- Roll back 20261016010000_hold_alert_claim_with_cap.
begin;

drop function if exists public.hold_alert_claim_with_cap(uuid, integer, uuid, text, uuid, integer, timestamptz);

commit;
