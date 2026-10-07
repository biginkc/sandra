-- Rollback for 20261008143900_suppression_pointer_union. Drops the RPC only;
-- no data was changed by the migration.
begin;
drop function if exists public.fn_merge_suppression_incomplete_pointer(uuid, uuid[], text[], uuid);
commit;
