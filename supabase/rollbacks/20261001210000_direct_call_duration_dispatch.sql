-- Rollback for 20261001210000_direct_call_duration_dispatch.sql. Before any remote use, run the
-- migration-history preflight against the exact remote history and verify direct calling is
-- disabled/drained. This is not remote deployment authorization or an independent old/new
-- compatibility rollback: the forward migration replaces the historical 7-argument
-- direct_call_begin signature and the old app cannot coexist with this schema.
-- Roll back 20261001220000_direct_call_prepare_ownership.sql first; then use this only immediately
-- before the whole-feature rollback, never as independent baseline restoration.
-- Rollback requires a coordinated app+schema change and disabled/drained direct calling; a local
-- loopback rollback rehearsal does not prove that the remote rollback is safe.
begin;

drop function if exists public.direct_call_dial_started(uuid, text, timestamptz, integer, integer);
drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer);

alter table if exists public.direct_call_cleanups drop column if exists dial_started_at;
alter table if exists public.direct_calls drop column if exists browser_dial_started_at;
alter table if exists public.direct_calls drop constraint if exists direct_calls_time_limit_secs_check;
alter table if exists public.direct_calls drop column if exists time_limit_secs;

commit;
