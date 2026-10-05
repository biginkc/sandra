-- Rollback for 20261005170000_seller_appointment_reminders.sql: drops the three functions and the two
-- tables. Reminder history is discarded; sent texts stay in public.messages.
begin;
drop function if exists public.fn_finish_seller_reminder(uuid, uuid, text, text, uuid, timestamptz, uuid);
drop function if exists public.fn_claim_seller_reminders(integer, uuid[]);
drop function if exists public.fn_schedule_seller_reminders(interval, integer, uuid[]);
drop table if exists public.seller_appointment_reminders;
drop table if exists public.seller_reminder_settings;
commit;
