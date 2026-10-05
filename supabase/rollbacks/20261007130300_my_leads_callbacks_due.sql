-- Rollback for 20261007130300_my_leads_callbacks_due. Turn callback_alert off first.
begin;
drop function if exists public.fn_my_leads_callbacks_due(uuid, interval, interval);
commit;
