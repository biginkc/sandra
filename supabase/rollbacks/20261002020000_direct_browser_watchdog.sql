-- Whole-feature rollback only. This does not restore the historical direct_call_begin signature;
-- disable/drain direct calling and apply the coordinated duration/preparation rollback first.
begin;
revoke all on function public.direct_call_watchdog_claim_expired(integer) from public, anon, authenticated, service_role;
revoke all on function public.direct_call_watchdog_disconnect(uuid, uuid, text, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.direct_call_watchdog_renew(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_call_watchdog_attach(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_call_watchdog_arm(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.direct_watchdog_heartbeat(text) from public, anon, authenticated, service_role;
revoke all on function public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid, uuid) from public, anon, authenticated, service_role;
drop function if exists public.direct_call_watchdog_claim_expired(integer);
drop function if exists public.direct_call_watchdog_disconnect(uuid, uuid, text, uuid, boolean);
drop function if exists public.direct_call_watchdog_renew(uuid, uuid, text, uuid);
drop function if exists public.direct_call_watchdog_attach(uuid, uuid, text, uuid);
drop function if exists public.direct_call_watchdog_arm(uuid, uuid, uuid);
drop function if exists public.direct_watchdog_heartbeat(text);
drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid, uuid);
drop index if exists public.direct_calls_watchdog_expiry_idx;
drop table if exists public.direct_watchdog_liveness;
alter table public.direct_calls
  drop column if exists browser_watchdog_claimed_at,
  drop column if exists browser_watchdog_expires_at,
  drop column if exists browser_watchdog_seen_at,
  drop column if exists browser_watchdog_session_id;
commit;
