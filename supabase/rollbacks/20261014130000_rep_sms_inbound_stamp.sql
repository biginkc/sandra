-- Rollback for 20261014130000_rep_sms_inbound_stamp.sql. Safe to run at any time: the
-- app treats a missing function as "no stored stamp" and sends unstamped.
begin;

drop function if exists public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid);
alter table public.rep_sms_delivery_ledger drop column if exists inbound_message_id;
alter table public.rep_sms_obligations drop column if exists inbound_message_id;

commit;
