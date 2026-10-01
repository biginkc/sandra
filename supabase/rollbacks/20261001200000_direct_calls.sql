begin;

drop function if exists public.direct_call_active_for_operator(uuid);
drop function if exists public.direct_call_orphan_add(uuid, text);
drop function if exists public.direct_call_orphan_remove(uuid, text);
drop table if exists public.direct_call_events;
drop table if exists public.direct_calls;
drop table if exists public.direct_call_operators;

commit;
