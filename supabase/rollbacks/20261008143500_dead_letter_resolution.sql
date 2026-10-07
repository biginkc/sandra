-- Rollback for 20261008143500_dead_letter_resolution. Drops the resolution
-- column (resolution state is lost; the sweeper then re-derives it from the
-- sent_late markers), its partial index, and the column-level UPDATE grant.
begin;

revoke update (resolved_at) on table public.ai_reply_dead_letters from service_role;
drop index if exists public.idx_ai_reply_dead_letters_unresolved_timeout;
alter table public.ai_reply_dead_letters drop column if exists resolved_at;

commit;
