-- ============================================================================
-- Feature 7 — In-app notifications (bell icon + dispatch + cleanup cron)
--
-- User-scoped rows written by three existing code paths at ship-time:
--   · Dialpad inbound SMS webhook               → owner_message_added
--   · assignLeadsBulk server action             → property_assigned
--   · runCassEnrichment terminal-state write    → bulk_action_completed
--
-- More event types slot in as their source features land (Feature 4c
-- tasks, Feature 5a sequences, Feature 8 vacancy). Each is a one-line
-- dispatchNotification(...) call at the right hook point.
--
-- entity_id is a loose reference (no FK). Underlying rows can be
-- soft-deleted; the UI falls back to a friendly "no longer available"
-- label when it can't resolve the target.
-- ============================================================================

create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'owner_message_added',
      'property_assigned',
      'bulk_action_completed'
    )
  ),
  entity_type text not null check (entity_type in ('property', 'job')),
  entity_id uuid not null,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Bell badge query: unread rows for the current user, newest first.
-- Partial index — read rows drop out and stay out.
create index idx_notifications_user_unread
  on notifications (user_id, created_at desc)
  where read_at is null;

-- Dropdown list: last N for the current user regardless of read state.
create index idx_notifications_user_recent
  on notifications (user_id, created_at desc);

-- Cleanup cron sweeps rows older than 90 days once a day — plain btree
-- on created_at is enough for a single range scan.
create index idx_notifications_cleanup
  on notifications (created_at);

alter table notifications enable row level security;

-- Same pattern as lead_notes (migration 010) and consent_events
-- (migration 007): authenticated users can see all rows in their org.
-- Per-user narrowing ships with Risk #14 (RBAC).
create policy notifications_authenticated_all on notifications
  for all
  to authenticated
  using (true)
  with check (true);

-- Realtime subscribe target for the bell badge.
alter publication supabase_realtime add table notifications;

-- ----------------------------------------------------------------------------
-- Test-reset helper: rebuild the tenant-truncate list.
--
-- Migration 005 predates lists/tags/notes/consent-events; those tables
-- were never added, so integration tests that seeded lists or tags
-- silently accumulated rows across runs (surfaced when a
-- unique-name create hit a leftover row and failed).
--
-- Rebuild the list to include every org-scoped tenant table that's
-- landed since, plus the new `notifications` table. Any new tenant
-- table added in a future migration must be appended here too.
-- ----------------------------------------------------------------------------
create or replace function reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate table
    job_items,
    messages,
    consent_events,
    property_merges,
    jobs,
    csv_imports,
    webhook_events,
    notifications,
    lead_notes,
    property_lists,
    property_tags,
    tags,
    lists,
    properties,
    homeowner_details,
    agent_details,
    contacts,
    cass_cache
  restart identity cascade;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
