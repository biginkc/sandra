-- Rollback for 20261030171500_routing_v2_model_stop_suppression.
--
-- Leaves every sms_phone_suppressions row in place (including source
-- 'model_stop'): rolling back the code never silently un-suppresses a phone
-- (BUILD-PLAN §13.3, safe direction). Lift any model_stop rows first through
-- the audited inbox action if that is wanted.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function if exists public.fn_lift_model_stop_suppression(uuid, text);
drop function if exists public.fn_apply_model_stop_suppression(uuid, text, uuid, uuid, uuid, jsonb);
drop table if exists public.routing_v2_model_stop_events;

commit;
