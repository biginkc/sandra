-- Rollback of 20261122120000: drops switchboard_read.norma_lead_thread. No-op where switchboard_read was never
-- provisioned. Leaves every other switchboard_read object, and the owner's existing public.messages access, alone.
begin;
set local lock_timeout = '5s';
drop view if exists switchboard_read.norma_lead_thread;
commit;
