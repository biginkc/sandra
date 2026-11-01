-- Rollback of 20261031140000: drops the suppress-and-release wrapper. The adapter falls back to
-- fn_apply_model_stop_suppression (hold left in place: fail safe).
begin;
set local lock_timeout = '5s';
drop function if exists public.routing_v2_apply_model_stop_and_release(uuid,text,uuid,uuid,uuid,jsonb);
commit;
