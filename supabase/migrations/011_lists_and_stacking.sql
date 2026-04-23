-- ============================================================================
-- Feature 2 — Lists + list stacking (migration 011)
--
-- Adopts REISift's rule: one list per kind-of-data. All "Probate" records
-- go to the same "Probate" list forever; the "when" lives in tags + the
-- property_lists.last_source_import_id provenance link.
--
-- The motivating insight is **stacking**: a property in 3 lists (Absentee
-- + Pre-Foreclosure + Tired Landlord) is a higher-motivation signal than
-- any single list. Re-importing the same address into a new list adds a
-- membership, it does not duplicate a row.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- lists — the cohort definitions
-- ----------------------------------------------------------------------------
create table lists (
  id uuid primary key default gen_random_uuid(),
  -- Mirrors the per-tenant default every other tenant table uses
  -- (see 001_initial.sql) — RBAC is still single-org until Risk #14 lands.
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  -- Tailwind-ish hex for the badge + kanban chip. Optional; null = default.
  color text check (color is null or color ~* '^#[0-9a-f]{6}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  -- Per-org uniqueness on the name. Soft-deleted (archived) lists keep the
  -- name reserved so revived rows don't clash with a new list of the same
  -- name; if an org really wants to reuse a name, hard-delete the archived
  -- row first.
  unique (org_id, name)
);

create index idx_lists_org on lists (org_id);
create index idx_lists_active on lists (org_id, created_at desc)
  where archived_at is null;

alter table lists enable row level security;

create policy lists_authenticated_all on lists
  for all
  to authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table lists;

-- ----------------------------------------------------------------------------
-- property_lists — the cohort memberships (where the stacking lives)
-- ----------------------------------------------------------------------------
create table property_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references organizations(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  list_id uuid not null references lists(id) on delete cascade,
  -- When this property was FIRST added to this list.
  first_added_at timestamptz not null default now(),
  -- When it was LAST added (re-import bumps this, not a new row).
  last_added_at timestamptz not null default now(),
  last_added_by uuid references auth.users(id) on delete set null,
  -- Optional: which CSV import last wrote this membership. Lets the lead
  -- detail page link "added via Probate Q4 2026 import" back to the job.
  last_source_import_id uuid references csv_imports(id) on delete set null,
  -- A property is on a list once. Duplicate attempts → ON CONFLICT UPDATE.
  unique (property_id, list_id)
);

create index idx_property_lists_property on property_lists (property_id);
create index idx_property_lists_list on property_lists (list_id);
create index idx_property_lists_org on property_lists (org_id);

alter table property_lists enable row level security;

create policy property_lists_authenticated_all on property_lists
  for all
  to authenticated
  using (true)
  with check (true);

alter publication supabase_realtime add table property_lists;

-- ----------------------------------------------------------------------------
-- property_stack_counts — convenience view for "how motivated is this lead"
--
-- Kept as a view (not a denormalized column with a trigger) because the
-- stacking query runs on /leads and /lists pages with bounded property
-- sets (≤500 leads per kanban view). A trigger-maintained counter would
-- add write amplification on every CSV import for a read that's fast
-- already via the (property_id) index.
-- ----------------------------------------------------------------------------
create view property_stack_counts as
  select
    property_id,
    count(*)::int as stack_count,
    array_agg(list_id order by first_added_at) as list_ids
  from property_lists
  group by property_id;
