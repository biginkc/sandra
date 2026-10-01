begin;

drop function if exists public.direct_call_cleanup_claim(uuid, timestamptz, integer);
drop function if exists public.direct_call_cleanup_add_leg(uuid, text);
drop function if exists public.direct_call_discard_reservation(uuid);
drop function if exists public.direct_call_set_target(uuid, uuid, uuid, text);
drop function if exists public.direct_call_dial_rejected(uuid, text);
drop function if exists public.direct_call_dial_succeeded(uuid, text, text);
drop function if exists public.direct_call_apply(uuid, text[], jsonb, jsonb);
drop function if exists public.direct_call_cancel_request(uuid, uuid, uuid);
drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid);
drop function if exists public.direct_call_active_for_operator(uuid);
drop function if exists public.direct_call_operator_busy(uuid);
drop table if exists public.direct_call_cleanups;
drop table if exists public.direct_call_events;
drop table if exists public.direct_calls;
drop table if exists public.direct_call_operators;

commit;
