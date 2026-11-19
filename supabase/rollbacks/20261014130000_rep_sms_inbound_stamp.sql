-- Rollback for 20261014130000_rep_sms_inbound_stamp.sql. Safe to run at any time: with the
-- functions gone the app's stamp calls fail and it sends unstamped.
begin;

drop function if exists public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid);
drop function if exists public.fn_get_rep_sms_inbound_stamp(text,uuid,uuid);
alter table public.rep_sms_delivery_ledger drop column if exists inbound_message_id;
alter table public.rep_sms_obligations drop column if exists inbound_message_id;

commit;
