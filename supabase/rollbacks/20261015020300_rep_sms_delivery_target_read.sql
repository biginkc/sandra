-- Roll back 20261015020300_rep_sms_delivery_target_read.
begin;

drop function if exists public.fn_get_rep_sms_delivery_target(uuid, uuid);

commit;
