-- Rollback for 20261006100500_dialpad_artifact_fetches. Remove the cron entry and route first.
-- call_transcripts rows already written are valid data and stay.
begin;
drop trigger if exists dialpad_artifact_fetches_enqueue_trg on public.call_activities;
drop function if exists public.dialpad_artifact_fetches_enqueue();
drop function if exists public.fn_resolve_dialpad_recording_links(integer);
drop function if exists public.fn_record_dialpad_artifact_result(uuid, text, text, text, text, text);
drop function if exists public.fn_claim_dialpad_artifact_fetches(integer, integer, text[]);
drop table if exists public.dialpad_call_artifact_fetches;
commit;
