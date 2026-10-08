-- Rollback for 20261008160000_messages_v2_scorecard. The function is
-- read-only, so dropping it loses no data; the page falls back to an
-- "unavailable" scorecard.
begin;

drop function if exists public.fn_messages_v2_scorecard(uuid, integer);

commit;
