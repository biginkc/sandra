-- ============================================================================
-- Feature 3 — Tags (migration 012)
--
-- Strict tag model: tags are journey markers, not state. They record what
-- happened to a record (source:propstream, uploaded:2026-04, mailed-twice,
-- skip-traced:matched) — not what's currently true about the property
-- (vacant, needs roof). State lives in property fields + status.
--
-- Categories:
--   source      — where data came from (auto at ingest)
--   marketing   — outreach actions taken (auto on SMS/email/mail send)
--   skip_trace  — skip-trace outcomes (auto on job complete)
--   phone       — phone-number metadata (auto on STOP, per-phone)
--   journey     — lifecycle markers (nurture:90-day, requalify-needed)
--   custom      — anything VAs add manually that doesn't fit above
--
-- Most chips VAs see on a lead are auto-applied. Only the `custom` category
-- has a "+ Add tag" UI; the rest are read-only. `system_managed=true` marks
-- tag rows that shouldn't be renamed / deleted by VAs (reserved for system
-- use — deleting `source:propstream` would orphan thousands of memberships).
-- ============================================================================

create table tags (
  id uuid primary key default gen_random_uuid(),
  -- Same per-tenant default as every other tenant table (migration 001 pattern).
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb'
    references organizations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- Optional hex color for chip tint. If null, UI uses category default.
  color text check (color is null or color ~* '^#[0-9a-f]{6}$'),
  category text not null default 'custom'
    check (category in ('source','marketing','skip_trace','phone','journey','custom')),
  -- System-managed tags are created by code (e.g. source:<vendor>) and
  -- the UI treats them as read-only. VAs see them but can't delete them
  -- without first detaching every property_tags row.
  system_managed boolean not null default false,
  -- Optional rule describing how this tag gets auto-applied. Interpreted
  -- by the ingest / cron workers (not enforced by a trigger); today it's
  -- documentation-only but future workers will read it for "re-apply
  -- source tags" style backfills.
  auto_apply_rule jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create index idx_tags_org on tags (org_id);
create index idx_tags_category on tags (org_id, category);

alter table tags enable row level security;

create policy tags_authenticated_all on tags
  for all
  to authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table tags;

-- ----------------------------------------------------------------------------
-- property_tags — the many-to-many memberships
-- ----------------------------------------------------------------------------
create table property_tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb'
    references organizations(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  applied_at timestamptz not null default now(),
  -- Null when the tag was applied by the system (import/cron/webhook).
  applied_by uuid references auth.users(id) on delete set null,
  source text not null default 'manual'
    check (source in ('manual','import','system','webhook')),
  unique (property_id, tag_id)
);

create index idx_property_tags_property on property_tags (property_id);
create index idx_property_tags_tag on property_tags (tag_id);
create index idx_property_tags_org on property_tags (org_id);

alter table property_tags enable row level security;

create policy property_tags_authenticated_all on property_tags
  for all
  to authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table property_tags;
