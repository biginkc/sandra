-- Rollback for 20261006100400_dialpad_native_assign_to_lead. Ambiguous events simply stay quarantined.
begin;
drop function if exists public.fn_assign_native_call_to_lead(uuid, text, uuid);
drop function if exists public.fn_list_ambiguous_native_calls(uuid);
commit;
