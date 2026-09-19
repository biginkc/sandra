-- Operator runbook: canonical concurrent indexes for the Inbox redesign.
--
-- NOT a supabase/migrations file. These 8 statements are CREATE INDEX
-- CONCURRENTLY, which cannot run inside a transaction and therefore cannot
-- be a `supabase db push` migration (each migration file is wrapped in its
-- own transaction). They also touch hot tables (public.messages,
-- public.ai_disposition_reviews, public.message_threads) under the
-- standing "no CONCURRENTLY in migrations" ruling for those tables.
--
-- Run this manually, once, by an operator with a direct (non-pooled)
-- connection, during a low-traffic window, AFTER the Batch A migrations
-- (20260919120000_inbox_control_foundation.sql,
-- 20260919120100_inbox_read_companion.sql; the R1 amendment dropped the
-- auth-upgrade/read-upgrade-* existing-schema files from the fresh-install
-- set) have applied. Each statement is
-- idempotent (IF NOT EXISTS) so it is safe to re-run after an interrupted
-- attempt — but an interrupted CONCURRENTLY build can also leave an
-- INVALID index behind; see precondition-check.sql below, which must PASS
-- before serving is ever enabled.
--
-- Source: experiments/inbox-production-install/generated/index-01.sql .. index-07.sql
--         and experiments/inbox-production-install/generated/read-index-01.sql
-- (verbatim statements; only IF NOT EXISTS was added for safe operator re-run.)

CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_parent_message_property ON public.messages(org_id,property_id,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_parent_message_contact ON public.messages(org_id,contact_id,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_parent_review_property ON public.ai_disposition_reviews(org_id,property_id,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_backfill_messages ON public.messages(org_id,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_backfill_reviews ON public.ai_disposition_reviews(org_id,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_backfill_threads ON public.message_threads(org_id,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_backfill_thread_identity ON public.message_threads(org_id,conversation_id,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inbox_unknown_history_page ON public.messages(org_id,md5(from_address),created_at DESC,id DESC) WHERE channel='sms';
