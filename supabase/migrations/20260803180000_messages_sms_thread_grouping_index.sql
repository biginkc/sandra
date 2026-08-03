-- PR E: hot-path index for inbox thread grouping.
--
-- This predicate must stay equivalent to src/lib/messages/list-threads.ts:
--   .eq("channel", "sms")
--   .not("contact_id", "is", null)
--   .not("conversation_id", "is", null)
--   .not("status", "in", "(queued,paused)")
--   .gte("created_at", cutoff)
-- A narrower predicate is not usable for that query.
--
-- CONCURRENTLY avoids taking the ordinary index-build table write lock, so
-- reads and writes can continue while this index builds. It takes longer,
-- uses additional maintenance resources, and still needs two table scans;
-- monitor the build and do not run it inside an explicit transaction.
--
-- This is intentionally not presented as a cheap index: the predicate
-- currently matches about 99.6% of messages (0 queued rows and about 0.39%
-- contact_id NULL), so the expected footprint is approximately 2.5-3 MB,
-- close to a full-table index, plus ongoing write-maintenance overhead.
--
-- UNVERIFIED until production-scale EXPLAIN ANALYZE proves that this index is
-- chosen for the target list-threads query and that its sort does not spill.
-- Supporting evidence is only the live idx_messages_unread_inbound plan
-- pattern and pg_stats correlation evidence; hypopg was not installed.

create index concurrently idx_messages_sms_thread_grouping
  on public.messages (conversation_id, created_at desc)
  where channel = 'sms'
    and status not in ('queued', 'paused')
    and contact_id is not null
    and conversation_id is not null;
