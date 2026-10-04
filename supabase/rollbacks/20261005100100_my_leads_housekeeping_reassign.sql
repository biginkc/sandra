-- Roll back 20261005100100: drops the housekeeping functions. Data changes already made
-- by a run are NOT undone by this file; call fn_my_leads_housekeeping_rollback(run_id, org_id,
-- fingerprint) for each applied run first. Later phases copy-replace the rollback function;
-- roll those back first so this drop does not strand them.
begin;
drop function if exists public.fn_my_leads_housekeeping_rollback(uuid, uuid, text);
drop function if exists public.fn_my_leads_housekeeping_run_info(uuid, uuid);
drop function if exists public.fn_my_leads_housekeeping_close_attempts(uuid, interval, boolean, text);
drop function if exists public.fn_my_leads_housekeeping_reassign(uuid, uuid, uuid, boolean, boolean, text);
drop function if exists public.my_leads_housekeeping_work_since(uuid, uuid, uuid, timestamptz);
drop function if exists public.my_leads_housekeeping_rollback_fingerprint(uuid, uuid);
drop function if exists public.my_leads_housekeeping_reassign_fingerprint(uuid, uuid, uuid, boolean, timestamptz);
drop function if exists public.my_leads_housekeeping_reassign_scope(uuid, uuid, timestamptz);
commit;
