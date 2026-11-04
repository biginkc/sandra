-- Rollback of 20261104120000: drops switchboard_read.norma_lead_details and the owner's call_activities access it added.
-- No-op where switchboard_read was never provisioned. Leaves every other switchboard_read object alone.
begin;
set local lock_timeout = '5s';
drop view if exists switchboard_read.norma_lead_details;
drop policy if exists switchboard_read_owner_select on public.call_activities;
do $rollback$
begin
  if exists (select 1 from pg_roles where rolname = 'switchboard_read_owner') then
    revoke all on public.call_activities from switchboard_read_owner;
  end if;
end
$rollback$;
commit;
