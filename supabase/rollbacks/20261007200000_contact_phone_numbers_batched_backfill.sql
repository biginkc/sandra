-- Rollback for 20261007200000_contact_phone_numbers_batched_backfill: drops the batched functions only.
-- Runs already applied through them stay rollbackable only through the one-shot rollback entry point,
-- which cannot fit a large run in one statement; roll such runs back (script `rollback --run`) first.
begin;
drop function if exists public.fn_contact_phone_numbers_backfill_rollback_finish(uuid, uuid, int, int, jsonb);
drop function if exists public.fn_contact_phone_numbers_backfill_rollback_range(uuid, uuid, uuid, int, uuid, boolean, text);
drop function if exists public.fn_contact_phone_numbers_backfill_run_info(uuid, uuid);
drop function if exists public.fn_contact_phone_numbers_backfill_range(uuid, uuid, int, uuid, boolean, text, uuid, text);
drop function if exists public.my_leads_phone_backfill_range_candidates(uuid, uuid, uuid);
commit;
