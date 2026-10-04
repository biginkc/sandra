-- Roll back 20261005100000_my_leads_housekeeping_tools. Apply AFTER
-- 20261005100100 and 20261005110000 rollbacks. Dropping the tables discards every
-- before-image: only do this when no housekeeping run still needs a data rollback.
begin;
drop function if exists public.my_leads_housekeeping_require_service();
drop table if exists public.my_leads_housekeeping_before_images;
drop table if exists public.my_leads_housekeeping_runs;
commit;
