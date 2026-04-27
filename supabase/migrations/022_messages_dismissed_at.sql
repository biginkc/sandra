-- ============================================================================
-- Feature 8 Phase 2 — soft-delete for unmatched inbound SMS
--
-- The cockpit's "Unknown" bucket surfaces every inbound message where
-- contact_id IS NULL — these are replies to texts the team sent from
-- Dialpad-direct (not through Sandra). The VA triages each one to either
-- match it to an existing contact, create a new contact + property from
-- it, or dismiss it as spam / wrong number.
--
-- "Dismiss" needs to hide the row from the bucket without losing the
-- evidence. NULL = active, timestamp = dismissed (and recoverable from a
-- "Dismissed" sub-tab).
--
-- Partial index keeps the Unknown bucket query fast — most messages are
-- matched (contact_id NOT NULL) so they aren't candidates; among the
-- unmatched, most are active (dismissed_at NULL).
-- ============================================================================

alter table messages
  add column if not exists dismissed_at timestamptz;

create index if not exists idx_messages_unknown_active
  on messages (from_address, created_at desc)
  where contact_id is null and dismissed_at is null;
