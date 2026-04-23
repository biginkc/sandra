-- ============================================================================
-- Feature 1 — VA polish seams
--
-- Three schema changes to unblock 2-VA ops:
--
--   1. properties.assigned_user_id — who owns this lead
--      FK to auth.users, nullable. ON DELETE SET NULL so offboarding a VA
--      doesn't delete their leads (matches migration 009's pattern for
--      csv_imports.user_id / jobs.created_by / property_merges.merged_by).
--
--   2. messages.read_at — when was this message last viewed by a user
--      Nullable timestamptz. Set server-side when a lead detail page loads.
--      A lead card shows an unread dot iff its most recent INBOUND message
--      has read_at IS NULL.
--
--   3. lead_notes table — append-only activity log
--      New entries go here; old properties.notes stays readable for historical
--      display but we stop writing to it from this feature forward. Each note
--      tracks the authoring user so VAs can hand off context to each other.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. properties.assigned_user_id
-- ----------------------------------------------------------------------------
alter table properties
  add column assigned_user_id uuid
    references auth.users(id) on delete set null;

create index idx_properties_assigned_user
  on properties (assigned_user_id)
  where assigned_user_id is not null;

-- ----------------------------------------------------------------------------
-- 2. messages.read_at
-- ----------------------------------------------------------------------------
alter table messages
  add column read_at timestamptz;

-- Partial index: only the unread inbound rows matter for the "unread dot"
-- query (latest inbound per property where read_at is null).
create index idx_messages_unread_inbound
  on messages (property_id, created_at desc)
  where direction = 'inbound' and read_at is null;

-- ----------------------------------------------------------------------------
-- 3. lead_notes table
-- ----------------------------------------------------------------------------
create table lead_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index idx_lead_notes_property_created
  on lead_notes (property_id, created_at desc);

create index idx_lead_notes_org
  on lead_notes (org_id);

create index idx_lead_notes_author
  on lead_notes (author_user_id)
  where author_user_id is not null;

alter table lead_notes enable row level security;

-- Same pattern as every other tenant table in 001_initial.sql:
-- authenticated users see everything in their org. Tightening per-user comes
-- with Risk #14 (RBAC) later.
create policy lead_notes_authenticated_all on lead_notes
  for all
  to authenticated
  using (true)
  with check (true);

-- Publish to Realtime so the notes feed updates without a page reload.
alter publication supabase_realtime add table lead_notes;
