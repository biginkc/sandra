-- Roll back 20261008100000_retire_follow_up_callback_types.
-- Drops the reject trigger and its function. The retire preflight
-- (fn_my_leads_next_step_retire_preflight) belongs to 20261005121500 and stays.
begin;

drop trigger if exists trg_tasks_reject_retired_types on public.tasks;
drop function if exists public.tasks_reject_retired_types();

commit;
