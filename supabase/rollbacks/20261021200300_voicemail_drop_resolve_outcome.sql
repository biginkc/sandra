-- Roll back 20261021200300_voicemail_drop_resolve_outcome.
-- The status-updates.ts code that calls this function must be reverted first.
-- Roll this back before 20261021200200_voicemail_drop_record_outcome (its
-- rollback refuses while this function exists).
begin;

drop function if exists public.pause_enrollments_for_inbound_call(uuid[]);
drop function if exists public.resolve_voicemail_drop_outcome(uuid, text, text, text, text, text, numeric, text, jsonb);

commit;
