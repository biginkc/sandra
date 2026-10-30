-- Rollback for 20261030210000_routing_v2_model_stop_suppression.
--
-- Leaves every sms_phone_suppressions row in place (including source
-- 'model_stop'): rolling back the code never silently un-suppresses a phone
-- (BUILD-PLAN §13.3, safe direction). Lift any model_stop rows first through
-- the audited inbox action if that is wanted.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function if exists public.fn_lift_model_stop_suppression(uuid, text);
drop function if exists public.fn_model_stop_lift_missing(uuid);
drop trigger if exists routing_v2_contact_phone_anomalies_sync_insert on public.contacts;
drop trigger if exists routing_v2_contact_phone_anomalies_sync_update on public.contacts;
drop function if exists public.routing_v2_contact_phone_anomalies_sync();
drop table if exists public.routing_v2_contact_phone_anomalies;
drop function if exists public.routing_v2_phone_anomaly_windows(text);
drop function if exists public.fn_apply_model_stop_suppression(uuid, text, uuid, uuid, uuid, jsonb);
drop function if exists public.fn_model_stop_phone_property_ids(uuid, text, uuid);
drop function if exists public.fn_routing_v2_property_eligible(jsonb, uuid);
drop function if exists public.fn_routing_v2_canary_bucket(uuid);
drop table if exists public.routing_v2_model_stop_events;

commit;
