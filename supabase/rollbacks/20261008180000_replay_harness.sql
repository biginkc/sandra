-- Rollback for 20261008180000_replay_harness: drops the three replay tables (rows are lost; they hold only replay data).
begin;
drop table if exists public.replay_outbound_log;
drop table if exists public.replay_row_tags;
drop table if exists public.replay_batches;
commit;
