begin;
set local lock_timeout = '5s';
drop function public.routing_v2_apply_live_transition(uuid,uuid,jsonb);
commit;
