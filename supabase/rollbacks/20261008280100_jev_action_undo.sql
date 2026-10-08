-- Rollback for 20261008280100_jev_action_undo.
begin;
drop function if exists public.fn_undo_jev_action(uuid);
drop table if exists public.jev_action_undo;
commit;
